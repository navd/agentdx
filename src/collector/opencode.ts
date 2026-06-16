import { existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir, platform } from 'os';
import Database from 'better-sqlite3';
import type { Message, ToolCall, ModelUsage } from '../core/types.js';
import { truncate, emptyStats, createDbWriter, persistSession, isPermissionError, type CollectorStats, type ParsedSession } from './shared.js';

/**
 * opencode (https://opencode.ai) persistence — a single SQLite database at
 * `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode`).
 *
 * Relevant tables (all read-only here):
 *  - `session`: one row per conversation with DIRECT token columns
 *    (tokens_input/output/reasoning/cache_read/cache_write), `cost`, `model`
 *    (JSON `{"id","providerID"}`), `agent` (build/plan/…), `directory` (cwd),
 *    `title`, `time_created`, `time_updated`.
 *  - `message`: per-message JSON in `data` — role, and for assistant turns a
 *    `tokens` object {input, output, reasoning, cache:{read,write}} + modelID.
 *  - `part`: message fragments in `data` JSON — type `text` (assistant/user
 *    text), `reasoning`, and `tool` ({tool, callID, state:{status,input,output}}).
 *
 * Token convention: opencode keeps input/output/cache disjoint (total =
 * input+output+reasoning+cache), matching AgentDX's input+output+cache_read
 * total. Reasoning tokens are billed as output, so we fold them into output.
 */

const AGENT = 'opencode';

/** Resolve opencode's data dir (where opencode.db lives), or null if absent. */
export function opencodeDbPath(): string | null {
  const home = homedir();
  const candidates: string[] = [];
  if (process.env.XDG_DATA_HOME) candidates.push(join(process.env.XDG_DATA_HOME, 'opencode'));
  if (platform() === 'win32' && process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'opencode'));
  candidates.push(join(home, '.local', 'share', 'opencode'));
  for (const dir of candidates) {
    const db = join(dir, 'opencode.db');
    if (existsSync(db)) return db;
  }
  return null;
}

/** Pull a human model name out of session.model (JSON) or a bare modelID. */
function modelName(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw.id || null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('{')) {
      try { const j = JSON.parse(s); return j?.id || null; } catch { return null; }
    }
    return s || null;
  }
  return null;
}

interface MsgParts {
  text: string[];
  tools: { tool: string; callID: string; state: any; ts: number }[];
}

function parseSession(sdb: Database.Database, row: any): ParsedSession | null {
  const sessionId = `opencode-${row.id}`;
  const startedAt = Number(row.time_created) || 0;
  const endedAt = Number(row.time_updated) || startedAt;
  const model = modelName(row.model);
  const projectPath = row.directory && row.directory !== '/' ? String(row.directory) : null;

  // Group this session's parts by message_id in one query.
  const partRows = sdb.prepare('SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC').all(row.id) as any[];
  const partsByMsg = new Map<string, MsgParts>();
  for (const p of partRows) {
    let d: any;
    try { d = JSON.parse(p.data); } catch { continue; }
    const mp = partsByMsg.get(p.message_id) || { text: [], tools: [] };
    if (d.type === 'text' && typeof d.text === 'string') {
      mp.text.push(d.text);
    } else if (d.type === 'tool' && d.tool) {
      mp.tools.push({ tool: String(d.tool), callID: String(d.callID || ''), state: d.state || {}, ts: Number(p.time_created) || 0 });
    }
    partsByMsg.set(p.message_id, mp);
  }

  const msgRows = sdb.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC').all(row.id) as any[];
  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  const modelUsage = new Map<string, ModelUsage>();
  let firstUserMessage: string | null = null;
  let turnCount = 0;
  let toolCallCount = 0;
  let seq = 0;

  for (const m of msgRows) {
    let d: any;
    try { d = JSON.parse(m.data); } catch { continue; }
    const role = d.role === 'user' ? 'user' : 'assistant';
    const ts = Number(m.time_created) || startedAt;
    const mp = partsByMsg.get(m.id) || { text: [], tools: [] };
    const text = mp.text.join('\n').trim();

    let inTok = 0, outTok = 0, cacheR = 0, cacheW = 0;
    let msgModel: string | null = null;
    if (role === 'assistant') {
      msgModel = (d.modelID ? String(d.modelID) : null) || model;
      const t = d.tokens || {};
      inTok = Math.max(0, Number(t.input) || 0);
      // Reasoning tokens bill as output, so fold them in (keeps cost honest).
      outTok = Math.max(0, Number(t.output) || 0) + Math.max(0, Number(t.reasoning) || 0);
      cacheR = Math.max(0, Number(t?.cache?.read) || 0);
      cacheW = Math.max(0, Number(t?.cache?.write) || 0);
    } else {
      turnCount++;
      if (!firstUserMessage && text) firstUserMessage = text;
    }

    if (text || (role === 'assistant' && mp.tools.length)) {
      messages.push({
        id: `${sessionId}-${m.id}`, session_id: sessionId, parent_id: null, role,
        model: role === 'assistant' ? msgModel : null,
        content_text: truncate(text), content_type: mp.tools.length ? 'tool_use' : 'text',
        timestamp: ts, input_tokens: inTok, output_tokens: outTok, cache_read: cacheR, cache_write: cacheW, seq: seq++,
      });
    }

    // Count every assistant message under its model (matching the other
    // collectors), not just token-bearing ones — tokens may legitimately be 0.
    if (role === 'assistant' && msgModel) {
      const mu = modelUsage.get(msgModel) || { session_id: sessionId, model: msgModel, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, message_count: 0 };
      mu.input_tokens += inTok; mu.output_tokens += outTok; mu.cache_read += cacheR; mu.cache_write += cacheW; mu.message_count += 1;
      modelUsage.set(msgModel, mu);
    }

    // Tool invocations live in this message's parts.
    mp.tools.forEach((t, ti) => {
      toolCallCount++;
      const st = t.state || {};
      const isError = st.status === 'error' ? 1 : 0;
      const inputStr = st.input != null ? (() => { try { return JSON.stringify(st.input); } catch { return null; } })() : null;
      const outputStr = typeof st.output === 'string' ? st.output : (st.error ? String(st.error) : null);
      toolCalls.push({
        id: `${sessionId}-tc-${m.id}-${t.callID || ti}`, session_id: sessionId,
        message_id: `${sessionId}-${m.id}`, tool_name: t.tool, tool_input: truncate(inputStr, 5000),
        tool_output: truncate(outputStr, 5000), is_error: isError, duration_ms: null, timestamp: t.ts || ts,
      });
    });
  }

  if (messages.length === 0) return null;

  // Session-level totals come straight from the session row's columns (the
  // ground-truth opencode aggregates), folding reasoning into output.
  const totalInput = Math.max(0, Number(row.tokens_input) || 0);
  const totalOutput = Math.max(0, Number(row.tokens_output) || 0) + Math.max(0, Number(row.tokens_reasoning) || 0);
  const totalCacheR = Math.max(0, Number(row.tokens_cache_read) || 0);
  const totalCacheW = Math.max(0, Number(row.tokens_cache_write) || 0);

  return {
    session: {
      id: sessionId, agent: AGENT, agent_version: row.version ? String(row.version) : null,
      title: row.title ? String(row.title) : (firstUserMessage ? firstUserMessage.slice(0, 100) : null),
      status: row.time_archived ? 'archived' : 'completed', project_path: projectPath,
      repository_url: null, git_branch: null, git_sha: null, model_primary: model,
      started_at: startedAt, ended_at: endedAt, duration_ms: endedAt > startedAt ? endedAt - startedAt : null,
      total_input_tokens: totalInput, total_output_tokens: totalOutput,
      total_cache_read: totalCacheR, total_cache_write: totalCacheW,
      turn_count: turnCount, tool_call_count: toolCallCount,
      first_user_message: truncate(firstUserMessage, 500),
      source_path: null, collected_at: Date.now(),
    },
    messages, toolCalls, modelUsage,
  };
}

export async function collectOpencode(db: Database.Database, dbPath: string, onProgress?: (done: number, total: number) => void): Promise<CollectorStats> {
  const stats = emptyStats();
  const w = createDbWriter(db);
  const sourceKey = 'opencode::sessions';
  const watermark = w.getWatermark.get(sourceKey) as any;

  let sdb: Database.Database | null = null;
  try {
    sdb = new Database(dbPath, { readonly: true, fileMustExist: true });
    // Sessions whose totals changed since the last collect (time_updated)
    // are re-read; the session upsert + ON CONFLICT inserts make it idempotent.
    const sessions = sdb.prepare('SELECT * FROM session ORDER BY time_updated ASC').all() as any[];
    let progressDone = 0;
    onProgress?.(0, sessions.length);

    for (const row of sessions) {
      onProgress?.(++progressDone, sessions.length);
      const updated = Number(row.time_updated) || 0;
      if (watermark?.last_timestamp && updated <= watermark.last_timestamp) continue;
      try {
        const parsed = parseSession(sdb, row);
        if (parsed) persistSession(w, parsed, stats);
      } catch (err: any) {
        stats.errors.push(`opencode ${row.id}: ${err.message}`);
      }
    }

    if (sessions.length > 0) {
      w.setWatermark.run({
        source: sourceKey, last_file: null, last_offset: 0, last_session_id: null,
        last_timestamp: Date.now(), updated_at: Date.now(),
      });
    }
  } catch (err: any) {
    if (isPermissionError(err)) {
      console.warn(`[opencode] Permission denied reading ${dbPath}, skipping`);
    } else {
      stats.errors.push(`opencode: ${err.message}`);
    }
  } finally {
    try { sdb?.close(); } catch {}
  }

  return stats;
}
