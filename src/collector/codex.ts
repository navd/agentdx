import { readdirSync, statSync, existsSync } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join, basename } from 'path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { Session, Message, ToolCall, ModelUsage } from '../core/types.js';
import { isValidSessionTimestamp, isPermissionError } from './shared.js';

interface CodexThread {
  id: string;
  title: string;
  model: string | null;
  model_provider: string;
  cwd: string;
  tokens_used: number;
  git_branch: string | null;
  git_sha: string | null;
  git_origin_url: string | null;
  cli_version: string;
  source: string;
  created_at_ms: number;
  updated_at_ms: number;
  first_user_message: string;
  sandbox_policy: string;
  approval_mode: string;
}

interface ParsedCodexSession {
  messages: Message[];
  toolCalls: ToolCall[];
  modelUsage: Map<string, ModelUsage>;
  turnCount: number;
  totalIn: number;
  totalOut: number;
  totalCacheRead: number;
}

function truncate(s: string | null | undefined, max = 10000): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function discoverSessionFiles(codexDir: string): Map<string, string> {
  const sessionsDir = join(codexDir, 'sessions');
  if (!existsSync(sessionsDir)) return new Map();

  const result = new Map<string, string>();

  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.jsonl')) {
          const match = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
          if (match) {
            result.set(match[1], full);
          }
        }
      }
    } catch (err: any) {
      if (isPermissionError(err)) {
        console.warn(`[codex] Permission denied reading ${dir}, skipping`);
      }
      /* skip unreadable dirs */
    }
  }

  walk(sessionsDir);
  return result;
}

async function parseCodexJsonl(filePath: string, sessionId: string): Promise<ParsedCodexSession> {
  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  const modelTokens = new Map<string, ModelUsage>();
  let turnCount = 0;
  let totalIn = 0, totalOut = 0, totalCacheRead = 0;
  let seq = 0;
  let sessionModel: string | null = null;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;

    if (obj.type === 'session_meta' && obj.payload) {
      sessionModel = obj.payload.model || null;
    }

    if (obj.type === 'turn_context' && obj.payload) {
      sessionModel = obj.payload.model || sessionModel;
    }

    if (obj.type === 'event_msg' && obj.payload) {
      const p = obj.payload;

      if (p.type === 'user_message' && p.message) {
        turnCount++;
        messages.push({
          id: `${sessionId}-u${seq}`,
          session_id: sessionId,
          parent_id: null,
          role: 'user',
          model: null,
          content_text: truncate(p.message),
          content_type: 'text',
          timestamp: ts,
          input_tokens: 0,
          output_tokens: 0,
          cache_read: 0,
          cache_write: 0,
          seq: seq++,
        });
      }

      if (p.type === 'agent_message' && p.message) {
        messages.push({
          id: `${sessionId}-a${seq}`,
          session_id: sessionId,
          parent_id: null,
          role: 'assistant',
          model: sessionModel,
          content_text: truncate(p.message),
          content_type: 'text',
          timestamp: ts,
          input_tokens: 0,
          output_tokens: 0,
          cache_read: 0,
          cache_write: 0,
          seq: seq++,
        });
      }

      if (p.type === 'token_count' && p.info?.total_token_usage) {
        // Codex reports cumulative session totals where `input_tokens` is
        // INCLUSIVE of `cached_input_tokens` (the re-read context). Every other
        // agent (and the app's input+output+cache_read convention) treats input
        // and cache as disjoint/additive, so de-include the cache here to avoid
        // double-counting it on read.
        const u = p.info.total_token_usage;
        totalCacheRead = u.cached_input_tokens || 0;
        totalIn = Math.max(0, (u.input_tokens || 0) - totalCacheRead);
        totalOut = u.output_tokens || 0;
      }
    }

    if (obj.type === 'response_item' && obj.payload) {
      const p = obj.payload;

      if (p.type === 'function_call' && p.name) {
        toolCalls.push({
          id: p.call_id || `${sessionId}-tc${seq}`,
          session_id: sessionId,
          message_id: null,
          tool_name: p.name,
          tool_input: truncate(p.arguments, 5000),
          tool_output: null,
          is_error: 0,
          duration_ms: null,
          timestamp: ts,
        });
        seq++;
      }

      if (p.type === 'function_call_output') {
        const lastTc = toolCalls[toolCalls.length - 1];
        if (lastTc && !lastTc.tool_output) {
          lastTc.tool_output = truncate(typeof p.output === 'string' ? p.output : JSON.stringify(p.output), 5000);
          // Codex doesn't store an explicit duration, but the call and its
          // output carry timestamps — derive tool latency from the delta.
          if (lastTc.duration_ms == null && ts > 0 && lastTc.timestamp > 0 && ts >= lastTc.timestamp) {
            lastTc.duration_ms = ts - lastTc.timestamp;
          }
        }
      }
    }
  }

  if (sessionModel) {
    modelTokens.set(sessionModel, {
      session_id: sessionId,
      model: sessionModel,
      input_tokens: totalIn,
      output_tokens: totalOut,
      cache_read: totalCacheRead,
      cache_write: 0,
      message_count: messages.filter(m => m.role === 'assistant').length,
    });
  }

  return { messages, toolCalls, modelUsage: modelTokens, turnCount, totalIn, totalOut, totalCacheRead };
}

export async function collectCodex(db: Database.Database, codexDir: string, onProgress?: (done: number, total: number) => void): Promise<{ sessions: number; messages: number; toolCalls: number; errors: string[] }> {
  const stats = { sessions: 0, messages: 0, toolCalls: 0, errors: [] as string[] };

  const stateDbPath = join(codexDir, 'state_5.sqlite');
  if (!existsSync(stateDbPath)) {
    stats.errors.push('state_5.sqlite not found');
    return stats;
  }

  let codexDb: BetterSqlite3.Database;
  try {
    codexDb = new BetterSqlite3(stateDbPath, { readonly: true });
  } catch (err: any) {
    stats.errors.push(`Cannot open state_5.sqlite: ${err.message}`);
    return stats;
  }

  const insertSession = db.prepare(`
    INSERT INTO sessions (id, agent, agent_version, title, status, project_path,
      repository_url, git_branch, git_sha, model_primary, started_at, ended_at, duration_ms,
      total_input_tokens, total_output_tokens, total_cache_read, total_cache_write,
      turn_count, tool_call_count, first_user_message, source_path, collected_at)
    VALUES (@id, @agent, @agent_version, @title, @status, @project_path,
      @repository_url, @git_branch, @git_sha, @model_primary, @started_at, @ended_at, @duration_ms,
      @total_input_tokens, @total_output_tokens, @total_cache_read, @total_cache_write,
      @turn_count, @tool_call_count, @first_user_message, @source_path, @collected_at)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      model_primary = excluded.model_primary,
      ended_at = excluded.ended_at,
      duration_ms = excluded.duration_ms,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read = excluded.total_cache_read,
      total_cache_write = excluded.total_cache_write,
      turn_count = excluded.turn_count,
      tool_call_count = excluded.tool_call_count,
      collected_at = excluded.collected_at
  `);

  const insertMessage = db.prepare(`
    INSERT INTO messages (id, session_id, parent_id, role, model, content_text,
      content_type, timestamp, input_tokens, output_tokens, cache_read, cache_write, seq)
    VALUES (@id, @session_id, @parent_id, @role, @model, @content_text,
      @content_type, @timestamp, @input_tokens, @output_tokens, @cache_read, @cache_write, @seq)
    ON CONFLICT(id) DO NOTHING
  `);

  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (id, session_id, message_id, tool_name, tool_input,
      tool_output, is_error, duration_ms, timestamp)
    VALUES (@id, @session_id, @message_id, @tool_name, @tool_input,
      @tool_output, @is_error, @duration_ms, @timestamp)
    ON CONFLICT(id) DO UPDATE SET
      duration_ms = COALESCE(excluded.duration_ms, tool_calls.duration_ms)
  `);

  const insertModelUsage = db.prepare(`
    INSERT OR REPLACE INTO model_usage (session_id, model, input_tokens, output_tokens,
      cache_read, cache_write, message_count)
    VALUES (@session_id, @model, @input_tokens, @output_tokens,
      @cache_read, @cache_write, @message_count)
  `);

  const insertRepo = db.prepare(`
    INSERT OR IGNORE INTO repositories (path, name, session_count, total_tokens)
    VALUES (@path, @name, 0, 0)
  `);

  // Repository aggregates are recomputed as a rollup from `sessions` after
  // collection — see recomputeRepositories(). Per-session increment here
  // double-counted any re-collected session.

  const getWatermark = db.prepare(`SELECT * FROM collection_state WHERE source = ?`);
  const setWatermark = db.prepare(`
    INSERT OR REPLACE INTO collection_state (source, last_file, last_offset, last_session_id, last_timestamp, updated_at)
    VALUES (@source, @last_file, @last_offset, @last_session_id, @last_timestamp, @updated_at)
  `);

  const sourceKey = 'codex';

  // One-time: existing codex tool calls were stored without derived latency and
  // the thread watermark would skip re-parsing them. Clear the codex watermark
  // once so every thread is re-read and gains duration_ms; the marker prevents
  // repeating.
  if (!getWatermark.get('codex_latency_v1')) {
    db.prepare(`DELETE FROM collection_state WHERE source = ?`).run(sourceKey);
    setWatermark.run({ source: 'codex_latency_v1', last_file: null, last_offset: 0, last_session_id: null, last_timestamp: Date.now(), updated_at: Date.now() });
  }

  const watermark = getWatermark.get(sourceKey) as any;
  const lastCollectedAt = watermark?.last_timestamp || 0;

  let threads: CodexThread[];
  try {
    threads = codexDb.prepare(`
      SELECT id, title, model, model_provider, cwd, tokens_used,
        git_branch, git_sha, git_origin_url, cli_version, source,
        created_at_ms, updated_at_ms, first_user_message, sandbox_policy, approval_mode
      FROM threads
      WHERE archived = 0
      ORDER BY created_at_ms DESC
    `).all() as CodexThread[];
  } catch (err: any) {
    stats.errors.push(`Cannot read threads: ${err.message}`);
    codexDb.close();
    return stats;
  }

  const sessionFiles = discoverSessionFiles(codexDir);

  let progressDone = 0;
  onProgress?.(0, threads.length);

  for (const thread of threads) {
    onProgress?.(++progressDone, threads.length);
    if (thread.updated_at_ms <= lastCollectedAt) continue;

    try {
      const sessionFile = sessionFiles.get(thread.id);
      let parsed: ParsedCodexSession | null = null;

      if (sessionFile) {
        parsed = await parseCodexJsonl(sessionFile, thread.id);
      }

      const session: Session = {
        id: thread.id,
        agent: 'codex',
        agent_version: thread.cli_version || null,
        title: thread.title || null,
        status: 'completed',
        project_path: thread.cwd || null,
        repository_url: thread.git_origin_url || null,
        git_branch: thread.git_branch || null,
        git_sha: thread.git_sha || null,
        model_primary: thread.model || null,
        started_at: thread.created_at_ms,
        ended_at: thread.updated_at_ms || null,
        duration_ms: thread.updated_at_ms && thread.created_at_ms
          ? thread.updated_at_ms - thread.created_at_ms : null,
        total_input_tokens: parsed?.totalIn || 0,
        total_output_tokens: parsed?.totalOut || 0,
        total_cache_read: parsed?.totalCacheRead || 0,
        total_cache_write: 0,
        turn_count: parsed?.turnCount || 1,
        tool_call_count: parsed?.toolCalls.length || 0,
        first_user_message: truncate(thread.first_user_message, 500),
        source_path: sessionFile || stateDbPath,
        collected_at: Date.now(),
      };

      // Validate timestamp before inserting
      if (!isValidSessionTimestamp(session.started_at)) {
        console.warn(`[codex] Skipping session ${session.id}: invalid started_at ${session.started_at}`);
        continue;
      }

      const txn = db.transaction(() => {
        insertSession.run(session);

        if (parsed) {
          for (const msg of parsed.messages) {
            insertMessage.run(msg);
          }
          for (const tc of parsed.toolCalls) {
            insertToolCall.run(tc);
          }
          for (const [, mu] of parsed.modelUsage) {
            insertModelUsage.run(mu);
          }
        } else if (thread.model) {
          insertModelUsage.run({
            session_id: thread.id,
            model: thread.model,
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            cache_write: 0,
            message_count: 0,
          });
        }

        if (session.project_path) {
          const name = session.project_path.split('/').pop() || session.project_path;
          insertRepo.run({ path: session.project_path, name });
        }
      });

      txn();
      stats.sessions++;
      stats.messages += parsed?.messages.length || 0;
      stats.toolCalls += parsed?.toolCalls.length || 0;
    } catch (err: any) {
      if (isPermissionError(err)) {
        console.warn(`[codex] Permission denied processing thread ${thread.id}, skipping`);
      } else {
        stats.errors.push(`${thread.id}: ${err.message}`);
      }
    }
  }

  setWatermark.run({
    source: sourceKey,
    last_file: stateDbPath,
    last_offset: 0,
    last_session_id: threads[0]?.id || null,
    last_timestamp: Date.now(),
    updated_at: Date.now(),
  });

  codexDb.close();
  return stats;
}

// One-time heal for Codex sessions stored before the cache de-include fix.
// Those rows kept Codex's cache-INCLUSIVE input, so the app's
// input+output+cache_read convention double-counted the cache. Subtract the
// already-stored cache from input, in place. Guarded by a marker row in
// collection_state so it runs exactly once (re-running would over-subtract).
export function backfillCodexTokens(db: Database.Database): void {
  const MARKER = 'codex_token_decache_v1';
  const done = db.prepare(`SELECT 1 FROM collection_state WHERE source = ?`).get(MARKER);
  if (done) return;

  // The subtract is NON-idempotent (re-running over-subtracts and clamps real
  // input to 0). Wrap the two UPDATEs and the guard marker in one transaction so
  // a crash rolls back both — the heal can only ever commit exactly once.
  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE sessions
      SET total_input_tokens = MAX(0, total_input_tokens - total_cache_read)
      WHERE agent = 'codex' AND total_cache_read > 0
    `).run();

    db.prepare(`
      UPDATE model_usage
      SET input_tokens = MAX(0, input_tokens - cache_read)
      WHERE cache_read > 0
        AND session_id IN (SELECT id FROM sessions WHERE agent = 'codex')
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO collection_state
        (source, last_file, last_offset, last_session_id, last_timestamp, updated_at)
      VALUES (?, NULL, 0, NULL, ?, ?)
    `).run(MARKER, Date.now(), Date.now());
  });
  txn();
}
