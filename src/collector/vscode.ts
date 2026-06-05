import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir, platform } from 'os';
import Database from 'better-sqlite3';
import type { Message, ToolCall, ModelUsage } from '../core/types.js';
import { truncate, emptyStats, createDbWriter, persistSession, isPermissionError, type CollectorStats, type ParsedSession, type SkillInvocation } from './shared.js';

/**
 * VS Code Copilot Chat persistence (two formats, both handled):
 *
 *  1. Panel chat — stored in each workspace's state.vscdb under the
 *     `interactive.sessions` ItemTable key: a JSON array of session objects
 *     { sessionId, creationDate, customTitle, requests:[{ message, response,
 *       result, agent, slashCommand }] }.
 *  2. Newer agent-mode — separate JSON files at
 *     workspaceStorage/<id>/chatSessions/*.json (same session shape).
 *
 * In both, message.text is the user turn, response[] holds assistant text
 * ({value} / {content:{value}}) and tool invocations
 * ({kind:'toolInvocationSerialized'…}). The model name isn't reliably stored,
 * and token counts aren't present → 0.
 */

const AGENT = 'vscode';

function vscodeBases(): string[] {
  const home = homedir();
  const p = platform();
  const variants = ['Code', 'Code - Insiders', 'VSCodium'];
  const root = p === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : p === 'win32'
      ? (process.env.APPDATA || join(home, 'AppData', 'Roaming'))
      : join(home, '.config');
  return variants.map((v) => join(root, v, 'User')).filter((d) => existsSync(d));
}

function msgText(message: any): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.parts)) {
    return message.parts.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return '';
}

function responseText(response: any): string {
  if (!response) return '';
  if (typeof response === 'string') return response;
  const arr = Array.isArray(response) ? response : [response];
  const out: string[] = [];
  for (const part of arr) {
    if (typeof part === 'string') out.push(part);
    else if (typeof part?.value === 'string') out.push(part.value);
    else if (typeof part?.content?.value === 'string') out.push(part.content.value);
    else if (typeof part?.content === 'string') out.push(part.content);
  }
  return out.join('');
}

const TOOL_KINDS = new Set(['toolInvocationSerialized', 'toolInvocation', 'prepareToolInvocation']);

function extractTools(response: any): { name: string; output: string }[] {
  if (!Array.isArray(response)) return [];
  const tools: { name: string; output: string }[] = [];
  for (const part of response) {
    if (part && typeof part === 'object' && TOOL_KINDS.has(part.kind)) {
      const name = part.toolSpecificData?.toolName || part.toolId || part.name || part.toolCallId || 'tool';
      const output = typeof part.resultDetails === 'string' ? part.resultDetails
        : part.invocationMessage?.value || part.pastTenseMessage?.value || '';
      tools.push({ name: String(name), output: String(output) });
    }
  }
  return tools;
}

/** Parse a single Copilot chat-session object (from either storage format). */
function parseSessionObject(s: any, fallbackId: string): ParsedSession | null {
  const requests = Array.isArray(s?.requests) ? s.requests : null;
  if (!requests || requests.length === 0) return null;

  const sessionId = `vscode-${s.sessionId || fallbackId}`;
  const creation = Number(s.creationDate) || 0;
  const last = Number(s.lastMessageDate) || creation;
  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  const skills: SkillInvocation[] = [];
  const modelUsage = new Map<string, ModelUsage>();
  let model: string | null = null;
  let firstUserMessage: string | null = null;
  let turnCount = 0;
  let toolCallCount = 0;
  let seq = 0;
  let startedAt = creation;
  let endedAt = last;
  const step = requests.length > 1 && last > creation ? (last - creation) / (requests.length - 1) : 0;

  requests.forEach((req: any, i: number) => {
    const ts = Number(req.timestamp) || (creation ? Math.round(creation + i * step) : 0);
    if (ts) { if (!startedAt || ts < startedAt) startedAt = ts; if (ts > endedAt) endedAt = ts; }
    const reqModel = req.modelId || req.result?.metadata?.modelId || null;
    if (reqModel && !model) model = reqModel;

    const ut = msgText(req.message);
    if (ut) {
      if (!firstUserMessage) firstUserMessage = ut;
      turnCount++;
      messages.push({
        id: `${sessionId}-u${i}`, session_id: sessionId, parent_id: null, role: 'user', model: null,
        content_text: truncate(ut), content_type: 'text', timestamp: ts,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, seq: seq++,
      });
    }

    // Copilot stores the invoked slash command (/explain, /fix, /tests, …) as a
    // structured field on the request — the message text starts with @workspace
    // etc., so the generic slash heuristic never sees it.
    const slash = req.slashCommand?.name;
    if (typeof slash === 'string' && slash) {
      skills.push({ id: `${sessionId}-vsk-${i}`, session_id: sessionId, message_id: `${sessionId}-u${i}`, skill: slash, source: 'command', timestamp: ts });
    }

    const at = responseText(req.response);
    const tools = extractTools(req.response);
    if (at || tools.length) {
      const aid = `${sessionId}-a${i}`;
      messages.push({
        id: aid, session_id: sessionId, parent_id: null, role: 'assistant', model: reqModel || model,
        content_text: truncate(at), content_type: tools.length ? 'tool_use' : 'text', timestamp: ts,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, seq: seq++,
      });
      tools.forEach((t, ti) => {
        toolCallCount++;
        toolCalls.push({
          id: `${sessionId}-tc${i}-${ti}`, session_id: sessionId, message_id: aid,
          tool_name: t.name, tool_input: null, tool_output: truncate(t.output, 5000),
          is_error: 0, duration_ms: null, timestamp: ts,
        });
      });
    }
  });

  if (messages.length === 0) return null;
  if (model) {
    modelUsage.set(model, {
      session_id: sessionId, model, input_tokens: 0, output_tokens: 0,
      cache_read: 0, cache_write: 0, message_count: messages.filter((m) => m.role === 'assistant').length,
    });
  }

  return {
    session: {
      id: sessionId, agent: AGENT, agent_version: null,
      title: s.customTitle || (firstUserMessage ? (firstUserMessage as string).slice(0, 100) : null),
      status: 'completed', project_path: null, repository_url: null, git_branch: null, git_sha: null,
      model_primary: model, started_at: startedAt, ended_at: endedAt,
      duration_ms: endedAt > startedAt ? endedAt - startedAt : null,
      total_input_tokens: 0, total_output_tokens: 0, total_cache_read: 0, total_cache_write: 0,
      turn_count: turnCount, tool_call_count: toolCallCount,
      first_user_message: truncate(firstUserMessage, 500),
      source_path: null, collected_at: Date.now(),
    },
    messages, toolCalls, modelUsage, extraSkills: skills,
  };
}

/** Read the `interactive.sessions` chat array out of a workspace state.vscdb. */
function readStateDbSessions(dbPath: string): any[] {
  let sdb: Database.Database | null = null;
  try {
    sdb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = sdb.prepare("SELECT value FROM ItemTable WHERE key = 'interactive.sessions'").get() as any;
    if (!row?.value) return [];
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  } finally {
    try { sdb?.close(); } catch {}
  }
}

export async function collectVSCode(db: Database.Database, onProgress?: (done: number, total: number) => void): Promise<CollectorStats> {
  const stats = emptyStats();
  const w = createDbWriter(db);

  // Build the work list: each workspace contributes its state.vscdb (panel
  // chat) + any chatSessions/*.json files (agent mode).
  const work: { kind: 'statedb' | 'file'; path: string }[] = [];
  for (const base of vscodeBases()) {
    const wsRoot = join(base, 'workspaceStorage');
    if (!existsSync(wsRoot)) continue;
    for (const e of readdirSync(wsRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sdb = join(wsRoot, e.name, 'state.vscdb');
      if (existsSync(sdb)) work.push({ kind: 'statedb', path: sdb });
      const csDir = join(wsRoot, e.name, 'chatSessions');
      if (existsSync(csDir)) {
        try { for (const f of readdirSync(csDir)) if (f.endsWith('.json')) work.push({ kind: 'file', path: join(csDir, f) }); } catch {}
      }
    }
  }

  let progressDone = 0;
  onProgress?.(0, work.length);
  const sourceKey = 'vscode::sessions';
  const watermark = w.getWatermark.get(sourceKey) as any;

  for (const item of work) {
    onProgress?.(++progressDone, work.length);
    try {
      const mtime = statSync(item.path).mtimeMs;
      // state.vscdb changes constantly (VS Code writes other keys), so the
      // watermark only skips chat-session FILES; state DBs are always re-read.
      if (item.kind === 'file' && watermark?.last_timestamp && mtime <= watermark.last_timestamp) continue;

      const objs = item.kind === 'statedb'
        ? readStateDbSessions(item.path)
        : (() => { try { return [JSON.parse(readFileSync(item.path, 'utf8'))]; } catch { return []; } })();

      objs.forEach((obj, idx) => {
        const parsed = parseSessionObject(obj, `${basename(item.path)}-${idx}`);
        if (parsed && parsed.messages.length) persistSession(w, parsed, stats);
      });
    } catch (err: any) {
      if (isPermissionError(err)) {
        console.warn(`[vscode] Permission denied reading ${item.path}, skipping`);
      } else {
        stats.errors.push(`vscode ${basename(item.path)}: ${err.message}`);
      }
    }
  }

  if (work.length > 0) {
    w.setWatermark.run({
      source: sourceKey, last_file: null, last_offset: 0, last_session_id: null,
      last_timestamp: Date.now(), updated_at: Date.now(),
    });
  }

  return stats;
}
