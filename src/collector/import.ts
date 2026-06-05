import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import type Database from 'better-sqlite3';
import type { Session, Message, ToolCall, ModelUsage } from '../core/types.js';
import { truncate, emptyStats, createDbWriter, persistSession, type CollectorStats, type ParsedSession } from './shared.js';

/**
 * Generic JSONL importer.
 *
 * Reads a newline-delimited JSON file where each line is one message in a
 * portable, agent-agnostic shape. This lets users pull sessions from any tool
 * (or a custom export) into AgentDX without a bespoke collector.
 *
 * Per-line fields (all optional except session_id + role):
 *   session_id   string   groups lines into a session (required)
 *   role         string   "user" | "assistant" | "tool" | "system"
 *   content      string   message text
 *   model        string   model name (assistant lines)
 *   timestamp    number|string  epoch ms or ISO date
 *   input_tokens, output_tokens, cache_read, cache_write   number
 *   tool_name    string   present → recorded as a tool call
 *   tool_input   any      serialized into the tool call
 *   tool_output  string   tool result text
 *   is_error     boolean  tool call failed
 *   project_path string   session-level (first non-empty wins)
 *   title        string   session-level (first non-empty wins)
 */

interface ImportLine {
  session_id?: string;
  role?: string;
  content?: string;
  model?: string;
  timestamp?: number | string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: string;
  is_error?: boolean;
  project_path?: string;
  title?: string;
}

interface Accum {
  messages: Message[];
  toolCalls: ToolCall[];
  models: Map<string, ModelUsage>;
  firstUser: string | null;
  projectPath: string | null;
  title: string | null;
  minTs: number;
  maxTs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  tools: number;
  seq: number;
}

function parseTs(v: number | string | undefined): number | null {
  if (typeof v === 'number' && v > 0) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export async function runImport(
  db: Database.Database,
  filePath: string,
  opts: { agent?: string } = {},
): Promise<CollectorStats> {
  const stats = emptyStats();
  if (!existsSync(filePath)) {
    stats.errors.push(`import: file not found: ${filePath}`);
    return stats;
  }

  const agent = opts.agent || 'imported';
  const w = createDbWriter(db);
  const bySession = new Map<string, Accum>();

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;

    let obj: ImportLine;
    try { obj = JSON.parse(line); } catch { stats.errors.push(`import: bad JSON on line ${lineNo}`); continue; }
    if (!obj || !obj.session_id || !obj.role) continue;

    const sid = `${agent}-${obj.session_id}`;
    let acc = bySession.get(sid);
    if (!acc) {
      acc = {
        messages: [], toolCalls: [], models: new Map(),
        firstUser: null, projectPath: null, title: null,
        minTs: Infinity, maxTs: 0,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        turns: 0, tools: 0, seq: 0,
      };
      bySession.set(sid, acc);
    }

    const ts = parseTs(obj.timestamp) ?? (acc.maxTs || Date.now());
    if (ts < acc.minTs) acc.minTs = ts;
    if (ts > acc.maxTs) acc.maxTs = ts;
    if (!acc.projectPath && obj.project_path) acc.projectPath = obj.project_path;
    if (!acc.title && obj.title) acc.title = obj.title;

    const input = Number(obj.input_tokens) || 0;
    const output = Number(obj.output_tokens) || 0;
    const cacheRead = Number(obj.cache_read) || 0;
    const cacheWrite = Number(obj.cache_write) || 0;
    acc.input += input; acc.output += output; acc.cacheRead += cacheRead; acc.cacheWrite += cacheWrite;

    const role = obj.role === 'assistant' || obj.role === 'tool' || obj.role === 'system' ? obj.role : 'user';
    if (role === 'user') {
      acc.turns++;
      if (obj.content && !acc.firstUser) acc.firstUser = obj.content;
    }

    const msgId = `${sid}-${acc.seq}`;
    acc.messages.push({
      id: msgId,
      session_id: sid,
      parent_id: null,
      role,
      model: obj.model || null,
      content_text: truncate(obj.content ?? null),
      content_type: obj.tool_name ? 'tool_use' : 'text',
      timestamp: ts,
      input_tokens: input,
      output_tokens: output,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      seq: acc.seq++,
    });

    if (obj.tool_name) {
      acc.tools++;
      acc.toolCalls.push({
        id: `${msgId}-tc`,
        session_id: sid,
        message_id: msgId,
        tool_name: obj.tool_name,
        tool_input: obj.tool_input != null ? truncate(JSON.stringify(obj.tool_input), 5000) : null,
        tool_output: truncate(obj.tool_output ?? null, 5000),
        is_error: obj.is_error ? 1 : 0,
        duration_ms: null,
        timestamp: ts,
      });
    }

    if (obj.model) {
      const mu = acc.models.get(obj.model) || {
        session_id: sid, model: obj.model,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, message_count: 0,
      };
      mu.input_tokens += input; mu.output_tokens += output;
      mu.cache_read += cacheRead; mu.cache_write += cacheWrite; mu.message_count++;
      acc.models.set(obj.model, mu);
    }
  }

  for (const [sid, acc] of bySession) {
    if (acc.messages.length === 0) continue;
    const startedAt = acc.minTs === Infinity ? Date.now() : acc.minTs;
    const endedAt = acc.maxTs || startedAt;

    // Primary model = the one with the most messages.
    let modelPrimary: string | null = null;
    let best = -1;
    for (const [, mu] of acc.models) {
      if (mu.message_count > best) { best = mu.message_count; modelPrimary = mu.model; }
    }

    const session: Session = {
      id: sid,
      agent,
      agent_version: null,
      title: acc.title || (acc.firstUser ? acc.firstUser.slice(0, 100) : null),
      status: 'completed',
      project_path: acc.projectPath,
      repository_url: null,
      git_branch: null,
      git_sha: null,
      model_primary: modelPrimary,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt > startedAt ? endedAt - startedAt : null,
      total_input_tokens: acc.input,
      total_output_tokens: acc.output,
      total_cache_read: acc.cacheRead,
      total_cache_write: acc.cacheWrite,
      turn_count: acc.turns,
      tool_call_count: acc.tools,
      first_user_message: truncate(acc.firstUser, 500),
      source_path: filePath,
      collected_at: Date.now(),
    };

    const parsed: ParsedSession = { session, messages: acc.messages, toolCalls: acc.toolCalls, modelUsage: acc.models };
    try {
      persistSession(w, parsed, stats);
    } catch (err: any) {
      stats.errors.push(`import ${sid}: ${err.message}`);
    }
  }

  return stats;
}
