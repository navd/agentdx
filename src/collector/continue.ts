import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type Database from 'better-sqlite3';
import type { Message, ToolCall, ModelUsage } from '../core/types.js';
import { truncate, emptyStats, createDbWriter, persistSession, isPermissionError, type CollectorStats, type ParsedSession, type SkillInvocation } from './shared.js';

/** Walk a ProseMirror editorState doc collecting Continue slash/prompt command
 *  names. A slash command is a node `{ type: 'prompt-block', attrs: { item: { name } } }`. */
function promptBlockNames(node: any, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'prompt-block' && node.attrs?.item?.name) out.push(String(node.attrs.item.name));
  if (Array.isArray(node.content)) for (const c of node.content) promptBlockNames(c, out);
}

/**
 * Continue.dev stores chat sessions under ~/.continue/sessions/:
 *   - sessions.json — index: [{ sessionId, title, dateCreated, workspaceDirectory, messageCount }]
 *   - <sessionId>.json — { chatModelTitle, history:[…], workspaceDirectory, title }
 *
 * history entries: { message:{ role, content, toolCalls? }, toolCallStates?, promptLogs? }
 *   user      — content is a string or a JSON array [{type:'text',text}]
 *   assistant — content string + optional toolCalls [{id, function:{name,arguments}}]
 *   tool      — content = tool result, toolCallId links back to the assistant call
 *
 * Tokens are logged separately (no sessionId) in
 * ~/.continue/dev_data/<schema>/tokensGenerated.jsonl
 * ({timestamp, model, provider, promptTokens, generatedTokens}); we attribute
 * each event to the session that was active at its timestamp.
 */

const AGENT = 'continue';

interface IndexEntry {
  sessionId: string;
  title?: string;
  dateCreated?: string | number;
  workspaceDirectory?: string;
}

interface TokenEvent { t: number; model: string; input: number; output: number; }

function continueRoot(): string {
  return join(homedir(), '.continue');
}

function extractContent(content: any): string {
  if (typeof content === 'string') {
    const s = content.trim();
    if (s.startsWith('[')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return arr.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
      } catch { /* fall through */ }
    }
    return content;
  }
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

function fileToPath(uri: string | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('file://')) { try { return decodeURIComponent(new URL(uri).pathname); } catch { return uri.replace('file://', ''); } }
  return uri;
}

/** Read tokensGenerated.jsonl across schema dirs into time-sorted events. */
function loadTokenEvents(root: string): TokenEvent[] {
  const events: TokenEvent[] = [];
  const devData = join(root, 'dev_data');
  if (!existsSync(devData)) return events;
  // schema version dirs (e.g. 0.2.0) — scan each for tokensGenerated.jsonl
  let dirs: string[] = [];
  try { dirs = readdirSync(devData, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(devData, e.name)); } catch {}
  for (const d of dirs) {
    const f = join(d, 'tokensGenerated.jsonl');
    if (!existsSync(f)) continue;
    try {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          const t = Date.parse(e.timestamp);
          if (Number.isNaN(t)) continue;
          events.push({ t, model: e.model || 'unknown', input: e.promptTokens || 0, output: e.generatedTokens || 0 });
        } catch { /* skip bad line */ }
      }
    } catch { /* unreadable */ }
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

function parseSession(root: string, entry: IndexEntry, tokensFor: { input: number; output: number; model: string | null }): ParsedSession | null {
  const file = join(root, 'sessions', `${entry.sessionId}.json`);
  let data: any;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const history = Array.isArray(data?.history) ? data.history : null;
  if (!history || history.length === 0) return null;

  const sessionId = `continue-${entry.sessionId}`;
  const created = Number(entry.dateCreated) || 0;
  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  const skills: SkillInvocation[] = [];
  const model: string | null = data.chatModelTitle || tokensFor.model || null;
  let firstUserMessage: string | null = null;
  let turnCount = 0;
  let toolCallCount = 0;
  let seq = 0;

  // First pass: collect tool results keyed by toolCallId.
  const toolResults = new Map<string, string>();
  for (const h of history) {
    if (h?.message?.role === 'tool' && h.message.toolCallId) {
      toolResults.set(h.message.toolCallId, extractContent(h.message.content));
    }
  }

  history.forEach((h: any, i: number) => {
    const m = h?.message;
    if (!m) return;
    const ts = created ? created + i : created; // no per-message ts; keep order
    if (m.role === 'user') {
      const text = extractContent(m.content);
      if (!text) return;
      if (!firstUserMessage) firstUserMessage = text;
      turnCount++;
      messages.push({
        id: `${sessionId}-u${i}`, session_id: sessionId, parent_id: null, role: 'user', model: null,
        content_text: truncate(text), content_type: 'text', timestamp: ts,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, seq: seq++,
      });
      // Continue keeps the invoked slash/prompt command in the ProseMirror
      // editorState (the plain message text has it already expanded).
      const names: string[] = [];
      promptBlockNames(h.editorState, names);
      names.forEach((nm, k) => skills.push({ id: `${sessionId}-csk-${i}-${k}`, session_id: sessionId, message_id: `${sessionId}-u${i}`, skill: nm, source: 'command', timestamp: ts }));
    } else if (m.role === 'assistant') {
      const text = extractContent(m.content);
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const aid = `${sessionId}-a${i}`;
      messages.push({
        id: aid, session_id: sessionId, parent_id: null, role: 'assistant', model,
        content_text: truncate(text), content_type: calls.length ? 'tool_use' : 'text', timestamp: ts,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, seq: seq++,
      });
      for (const c of calls) {
        toolCallCount++;
        const name = c?.function?.name || c?.name || 'tool';
        toolCalls.push({
          id: c?.id || `${sessionId}-tc${i}-${toolCallCount}`,
          session_id: sessionId, message_id: aid, tool_name: String(name),
          tool_input: truncate(c?.function?.arguments || null, 5000),
          tool_output: truncate(c?.id ? toolResults.get(c.id) ?? null : null, 5000),
          is_error: 0, duration_ms: null, timestamp: ts,
        });
      }
    }
    // tool-role messages are folded into their call's output above
  });

  if (messages.length === 0) return null;

  const modelUsage = new Map<string, ModelUsage>();
  if (model) {
    modelUsage.set(model, {
      session_id: sessionId, model,
      input_tokens: tokensFor.input, output_tokens: tokensFor.output,
      cache_read: 0, cache_write: 0,
      message_count: messages.filter((mm) => mm.role === 'assistant').length,
    });
  }

  return {
    session: {
      id: sessionId, agent: AGENT, agent_version: null,
      title: data.title || entry.title || (firstUserMessage ? (firstUserMessage as string).slice(0, 100) : null),
      status: 'completed', project_path: fileToPath(data.workspaceDirectory || entry.workspaceDirectory),
      repository_url: null, git_branch: null, git_sha: null,
      model_primary: model, started_at: created, ended_at: created,
      duration_ms: null,
      total_input_tokens: tokensFor.input, total_output_tokens: tokensFor.output,
      total_cache_read: 0, total_cache_write: 0,
      turn_count: turnCount, tool_call_count: toolCallCount,
      first_user_message: truncate(firstUserMessage, 500),
      source_path: file, collected_at: Date.now(),
    },
    messages, toolCalls, modelUsage, extraSkills: skills,
  };
}

export async function collectContinue(db: Database.Database, onProgress?: (done: number, total: number) => void): Promise<CollectorStats> {
  const stats = emptyStats();
  const root = continueRoot();
  const indexFile = join(root, 'sessions', 'sessions.json');
  if (!existsSync(indexFile)) return stats;

  let index: IndexEntry[];
  try {
    const parsed = JSON.parse(readFileSync(indexFile, 'utf8'));
    index = Array.isArray(parsed) ? parsed : [];
  } catch { return stats; }
  if (index.length === 0) return stats;

  // Attribute token events to the session active at each event's timestamp.
  const events = loadTokenEvents(root);
  const sorted = [...index].filter((e) => e.sessionId).sort((a, b) => (Number(a.dateCreated) || 0) - (Number(b.dateCreated) || 0));
  const tokensBy = new Map<string, { input: number; output: number; model: string | null }>();
  for (const e of sorted) tokensBy.set(e.sessionId, { input: 0, output: 0, model: null });
  for (const ev of events) {
    // last session created at or before the event
    let target: IndexEntry | null = null;
    for (const s of sorted) { if ((Number(s.dateCreated) || 0) <= ev.t) target = s; else break; }
    if (!target) target = sorted[0];
    if (!target) continue;
    const agg = tokensBy.get(target.sessionId)!;
    agg.input += ev.input; agg.output += ev.output; if (!agg.model) agg.model = ev.model;
  }

  let progressDone = 0;
  onProgress?.(0, index.length);
  const w = createDbWriter(db);
  const sourceKey = `continue::${root}`;
  const watermark = w.getWatermark.get(sourceKey) as any;

  for (const entry of index) {
    onProgress?.(++progressDone, index.length);
    if (!entry.sessionId) continue;
    try {
      const file = join(root, 'sessions', `${entry.sessionId}.json`);
      if (!existsSync(file)) continue;
      const mtime = statSync(file).mtimeMs;
      if (watermark?.last_timestamp && mtime <= watermark.last_timestamp) continue;
      const tok = tokensBy.get(entry.sessionId) || { input: 0, output: 0, model: null };
      const parsed = parseSession(root, entry, tok);
      if (!parsed || parsed.messages.length === 0) continue;
      persistSession(w, parsed, stats);
    } catch (err: any) {
      if (isPermissionError(err)) console.warn(`[continue] Permission denied for ${entry.sessionId}, skipping`);
      else stats.errors.push(`continue ${entry.sessionId}: ${err.message}`);
    }
  }

  w.setWatermark.run({
    source: sourceKey, last_file: null, last_offset: 0, last_session_id: null,
    last_timestamp: Date.now(), updated_at: Date.now(),
  });

  return stats;
}
