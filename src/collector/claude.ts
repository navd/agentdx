import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join, basename } from 'path';
import type Database from 'better-sqlite3';
import type { Session, Message, ToolCall, ModelUsage } from '../core/types.js';
import { isValidSessionTimestamp, isPermissionError } from './shared.js';

interface ParsedSession {
  session: Session;
  messages: Message[];
  toolCalls: ToolCall[];
  modelUsage: Map<string, ModelUsage>;
}

function truncate(s: string | null | undefined, max = 10000): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function extractText(content: any): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    if (block.type === 'tool_use') parts.push(`[tool: ${block.name}]`);
    if (block.type === 'tool_result') {
      if (typeof block.content === 'string') parts.push(block.content);
    }
  }
  return parts.join('\n') || null;
}

function extractToolUses(content: any): Array<{ id: string; name: string; input: any }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b.type === 'tool_use')
    .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));
}

function extractToolResults(content: any): Array<{ tool_use_id: string; content: string; is_error: boolean }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b.type === 'tool_result')
    .map((b: any) => ({
      tool_use_id: b.tool_use_id,
      content: typeof b.content === 'string' ? b.content :
        Array.isArray(b.content) ? b.content.map((c: any) => c.text || '').join('\n') : '',
      is_error: !!b.is_error,
    }));
}

export async function parseSessionJsonl(filePath: string): Promise<ParsedSession | null> {
  const lines: any[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }

  if (lines.length === 0) return null;

  const sessionId = basename(filePath, '.jsonl');
  let title: string | null = null;
  let firstUserMessage: string | null = null;
  let startedAt = Infinity;
  let endedAt = 0;
  let projectPath: string | null = null;
  let gitBranch: string | null = null;
  let agentVersion: string | null = null;
  let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;
  let turnCount = 0;
  let toolCallCount = 0;
  const modelTokens = new Map<string, ModelUsage>();
  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  const pendingToolUses = new Map<string, { name: string; input: any; messageId: string; timestamp: number }>();
  let seq = 0;

  for (const obj of lines) {
    // title
    if (obj.type === 'custom-title' && obj.customTitle) {
      title = obj.customTitle;
      continue;
    }

    // skip non-conversation types
    if (!obj.type || !['user', 'assistant'].includes(obj.type)) continue;
    if (!obj.message) continue;

    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
    if (ts && ts < startedAt) startedAt = ts;
    if (ts && ts > endedAt) endedAt = ts;

    if (!projectPath && obj.cwd) projectPath = obj.cwd;
    if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;
    if (!agentVersion && obj.version) agentVersion = obj.version;

    const msg = obj.message;
    const role = msg.role || obj.type;
    const msgId = obj.uuid || `${sessionId}-${seq}`;

    if (role === 'user') {
      const isMeta = obj.isMeta === true;
      const text = extractText(msg.content);

      // extract tool results
      const results = extractToolResults(msg.content);
      for (const r of results) {
        const pending = pendingToolUses.get(r.tool_use_id);
        if (pending) {
          toolCalls.push({
            id: r.tool_use_id,
            session_id: sessionId,
            message_id: pending.messageId,
            tool_name: pending.name,
            tool_input: truncate(JSON.stringify(pending.input), 5000),
            tool_output: truncate(r.content, 5000),
            is_error: r.is_error ? 1 : 0,
            duration_ms: ts - pending.timestamp > 0 ? ts - pending.timestamp : null,
            timestamp: pending.timestamp,
          });
          pendingToolUses.delete(r.tool_use_id);
          toolCallCount++;
        }
      }

      if (!isMeta && text && !firstUserMessage) {
        firstUserMessage = text;
      }
      if (!isMeta) turnCount++;

      messages.push({
        id: msgId,
        session_id: sessionId,
        parent_id: obj.parentUuid || null,
        role: 'user',
        model: null,
        content_text: truncate(text),
        content_type: results.length > 0 ? 'tool_result' : 'text',
        timestamp: ts,
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 0,
        cache_write: 0,
        seq: seq++,
      });

    } else if (role === 'assistant') {
      const model = msg.model || null;
      const usage = msg.usage || {};
      const inTok = usage.input_tokens || 0;
      const outTok = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheWrite = usage.cache_creation_input_tokens || 0;

      totalIn += inTok;
      totalOut += outTok;
      totalCacheRead += cacheRead;
      totalCacheWrite += cacheWrite;

      // model usage aggregation
      if (model && model !== '<synthetic>') {
        const existing = modelTokens.get(model) || {
          session_id: sessionId, model, input_tokens: 0, output_tokens: 0,
          cache_read: 0, cache_write: 0, message_count: 0,
        };
        existing.input_tokens += inTok;
        existing.output_tokens += outTok;
        existing.cache_read += cacheRead;
        existing.cache_write += cacheWrite;
        existing.message_count++;
        modelTokens.set(model, existing);
      }

      // extract tool uses
      const uses = extractToolUses(msg.content);
      for (const u of uses) {
        pendingToolUses.set(u.id, { name: u.name, input: u.input, messageId: msgId, timestamp: ts });
      }

      const text = extractText(msg.content);
      messages.push({
        id: msgId,
        session_id: sessionId,
        parent_id: obj.parentUuid || null,
        role: 'assistant',
        model,
        content_text: truncate(text),
        content_type: uses.length > 0 ? 'tool_use' : 'text',
        timestamp: ts,
        input_tokens: inTok,
        output_tokens: outTok,
        cache_read: cacheRead,
        cache_write: cacheWrite,
        seq: seq++,
      });
    }
  }

  if (startedAt === Infinity) return null;

  // find primary model (most output tokens)
  let modelPrimary: string | null = null;
  let maxOut = 0;
  for (const [model, usage] of modelTokens) {
    if (usage.output_tokens > maxOut) {
      maxOut = usage.output_tokens;
      modelPrimary = model;
    }
  }

  const session: Session = {
    id: sessionId,
    agent: 'claude-code',
    agent_version: agentVersion,
    title,
    status: 'completed',
    project_path: projectPath,
    repository_url: null,
    git_branch: gitBranch,
    git_sha: null,
    model_primary: modelPrimary,
    started_at: startedAt,
    ended_at: endedAt || null,
    duration_ms: endedAt > startedAt ? endedAt - startedAt : null,
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    total_cache_read: totalCacheRead,
    total_cache_write: totalCacheWrite,
    turn_count: turnCount,
    tool_call_count: toolCallCount,
    first_user_message: truncate(firstUserMessage, 500),
    source_path: filePath,
    collected_at: Date.now(),
  };

  return { session, messages, toolCalls, modelUsage: modelTokens };
}

export function discoverProjects(claudeDir: string): Array<{ dir: string; projectPath: string }> {
  const projectsDir = join(claudeDir, 'projects');
  if (!existsSync(projectsDir)) return [];

  try {
    const dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const dirName = d.name;
        // decode: -Users-navdeepsharma-Documents-code-foo → /Users/navdeepsharma/Documents/code/foo
        const projectPath = '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
        return { dir: join(projectsDir, dirName), projectPath };
      });

    return dirs;
  } catch (err: any) {
    if (isPermissionError(err)) {
      console.warn(`[claude] Permission denied reading ${projectsDir}, skipping`);
      return [];
    }
    throw err;
  }
}

export function discoverSessionFiles(projectDir: string): string[] {
  try {
    return readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(projectDir, f));
  } catch (err: any) {
    if (isPermissionError(err)) {
      console.warn(`[claude] Permission denied reading ${projectDir}, skipping`);
    }
    return [];
  }
}

// A session's sub-agent / workflow transcripts live (recursively) under
// <projectDir>/<sessionId>/subagents/. Returns their absolute paths.
export function discoverSubagentFiles(projectDir: string, sessionId: string): string[] {
  const root = join(projectDir, sessionId, 'subagents');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(d, { withFileTypes: true }) as any; } catch { return; }
    for (const e of entries as any[]) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

// Classify a sub-agent transcript path: workflow agents sit under
// subagents/workflows/wf_xxx/, everything else is a Task-tool sub-agent.
function subagentKind(path: string): { kind: 'task' | 'workflow'; workflow_id: string | null } {
  const m = path.match(/\/subagents\/workflows\/(wf_[A-Za-z0-9-]+)\//);
  return m ? { kind: 'workflow', workflow_id: m[1] } : { kind: 'task', workflow_id: null };
}

export async function collectClaude(db: Database.Database, claudeDir: string, onProgress?: (done: number, total: number) => void): Promise<{ sessions: number; messages: number; toolCalls: number; errors: string[] }> {
  const stats = { sessions: 0, messages: 0, toolCalls: 0, errors: [] as string[] };

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
    ON CONFLICT(id) DO NOTHING
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

  const insertSubagent = db.prepare(`
    INSERT OR REPLACE INTO subagents (id, parent_session_id, agent, kind, workflow_id, model,
      input_tokens, output_tokens, cache_read, cache_write, tool_call_count, message_count,
      started_at, ended_at, source_path)
    VALUES (@id, @parent_session_id, @agent, @kind, @workflow_id, @model,
      @input_tokens, @output_tokens, @cache_read, @cache_write, @tool_call_count, @message_count,
      @started_at, @ended_at, @source_path)
  `);

  // Repository aggregates (session_count / total_tokens / last_session_at) are
  // recomputed as a rollup from `sessions` after collection — see
  // recomputeRepositories(). Incrementing them per-session here double-counted
  // any session re-collected across runs (e.g. a still-open session).

  const getWatermark = db.prepare(`SELECT * FROM collection_state WHERE source = ?`);
  const setWatermark = db.prepare(`
    INSERT OR REPLACE INTO collection_state (source, last_file, last_offset, last_session_id, last_timestamp, updated_at)
    VALUES (@source, @last_file, @last_offset, @last_session_id, @last_timestamp, @updated_at)
  `);

  // One-time: existing sessions were collected before sub-agent roll-up
  // existed, and the mtime watermark would skip re-parsing them. Clear the
  // claude watermarks once so every session is re-parsed and gains its
  // sub-agent totals; the marker keeps this from repeating.
  const ROLLUP_MARKER = 'subagent_rollup_v1';
  if (!getWatermark.get(ROLLUP_MARKER)) {
    db.prepare(`DELETE FROM collection_state WHERE source LIKE 'claude::%'`).run();
    setWatermark.run({ source: ROLLUP_MARKER, last_file: null, last_offset: 0, last_session_id: null, last_timestamp: Date.now(), updated_at: Date.now() });
  }

  const projects = discoverProjects(claudeDir);
  let progressDone = 0;
  onProgress?.(0, projects.length);

  for (const { dir, projectPath } of projects) {
    const sourceKey = `claude::${dir}`;
    const watermark = getWatermark.get(sourceKey) as CollectionState | undefined;
    const files = discoverSessionFiles(dir);

    for (const file of files) {
      try {
        const fileStat = statSync(file);
        // skip if file hasn't changed since last collection
        if (watermark && watermark.last_timestamp && fileStat.mtimeMs <= watermark.last_timestamp) {
          continue;
        }

        const parsed = await parseSessionJsonl(file);
        if (!parsed || parsed.messages.length === 0) continue;

        // Validate timestamp before inserting
        if (!isValidSessionTimestamp(parsed.session.started_at)) {
          console.warn(`[claude] Skipping session ${parsed.session.id}: invalid started_at ${parsed.session.started_at}`);
          continue;
        }

        // Roll sub-agent / workflow transcripts into this session: their tokens
        // count toward the parent's real cost (added to the session totals and
        // model_usage so sessions == model_usage stays consistent), and each
        // sub-agent is recorded for the sub-agent metrics view. Computed fresh
        // every parse (not incremented), so re-collecting is idempotent.
        const subRows: any[] = [];
        for (const sf of discoverSubagentFiles(dir, parsed.session.id)) {
          let sp: ParsedSession | null = null;
          try { sp = await parseSessionJsonl(sf); } catch { continue; }
          if (!sp || sp.messages.length === 0) continue;
          const { kind, workflow_id } = subagentKind(sf);

          parsed.session.total_input_tokens += sp.session.total_input_tokens;
          parsed.session.total_output_tokens += sp.session.total_output_tokens;
          parsed.session.total_cache_read += sp.session.total_cache_read;
          parsed.session.total_cache_write += sp.session.total_cache_write;

          for (const [m, mu] of sp.modelUsage) {
            const ex = parsed.modelUsage.get(m) || {
              session_id: parsed.session.id, model: m,
              input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, message_count: 0,
            };
            ex.input_tokens += mu.input_tokens;
            ex.output_tokens += mu.output_tokens;
            ex.cache_read += mu.cache_read;
            ex.cache_write += mu.cache_write;
            ex.message_count += mu.message_count;
            parsed.modelUsage.set(m, ex);
          }

          subRows.push({
            id: `${parsed.session.id}:${basename(sf, '.jsonl')}`,
            parent_session_id: parsed.session.id,
            agent: 'claude-code', kind, workflow_id,
            model: sp.session.model_primary || null,
            input_tokens: sp.session.total_input_tokens,
            output_tokens: sp.session.total_output_tokens,
            cache_read: sp.session.total_cache_read,
            cache_write: sp.session.total_cache_write,
            tool_call_count: sp.toolCalls.length,
            message_count: sp.messages.length,
            started_at: sp.session.started_at,
            ended_at: sp.session.ended_at,
            source_path: sf,
          });
        }

        const txn = db.transaction(() => {
          insertSession.run(parsed.session);

          for (const msg of parsed.messages) {
            insertMessage.run(msg);
          }

          for (const tc of parsed.toolCalls) {
            insertToolCall.run(tc);
          }

          for (const [, mu] of parsed.modelUsage) {
            insertModelUsage.run(mu);
          }

          for (const sr of subRows) {
            insertSubagent.run(sr);
          }

          if (parsed.session.project_path) {
            const name = parsed.session.project_path.split('/').pop() || parsed.session.project_path;
            insertRepo.run({ path: parsed.session.project_path, name });
          }
        });

        txn();

        stats.sessions++;
        stats.messages += parsed.messages.length;
        stats.toolCalls += parsed.toolCalls.length;
      } catch (err: any) {
        if (isPermissionError(err)) {
          console.warn(`[claude] Permission denied reading ${file}, skipping`);
        } else {
          stats.errors.push(`${file}: ${err.message}`);
        }
      }
    }

    setWatermark.run({
      source: sourceKey,
      last_file: files[files.length - 1] || null,
      last_offset: 0,
      last_session_id: null,
      last_timestamp: Date.now(),
      updated_at: Date.now(),
    });

    onProgress?.(++progressDone, projects.length);
  }

  return stats;
}

interface CollectionState {
  source: string;
  last_file: string | null;
  last_offset: number;
  last_session_id: string | null;
  last_timestamp: number | null;
  updated_at: number;
}
