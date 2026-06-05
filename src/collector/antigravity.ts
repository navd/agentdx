import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type Database from 'better-sqlite3';
import type { Message, ToolCall, ModelUsage } from '../core/types.js';
import { truncate, emptyStats, createDbWriter, persistSession, isPermissionError, type CollectorStats, type ParsedSession } from './shared.js';

/**
 * Antigravity (Google's agentic IDE, a VS Code fork) stores each agent
 * "trajectory" under ~/.gemini/antigravity/. The readable per-trajectory
 * record is a JSONL transcript at:
 *
 *   ~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl
 *
 * Each line is a step: { step_index, source, type, status, created_at,
 * content?, thinking?, tool_calls? }. Types observed:
 *   USER_INPUT        — user prompt (content wrapped in <USER_REQUEST>…)
 *   PLANNER_RESPONSE  — assistant turn (content = final text, thinking = reasoning)
 *   CODE_ACTION       — file create/edit (content = result)
 *   RUN_COMMAND       — shell command (content = result)
 *   LIST_DIRECTORY    — directory read
 *   CONVERSATION_HISTORY — meta, skipped
 *
 * Token counts are NOT in the transcript (they live in the binary
 * conversations/<uuid>.pb), so token totals are 0 for now.
 */

const AGENT = 'antigravity';

interface Step {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string | null;
  thinking?: string | null;
  tool_calls?: unknown;
}

// type → canonical tool name (so existing tool-category / ship metrics apply)
const TOOL_MAP: Record<string, string> = {
  CODE_ACTION: 'Write',
  RUN_COMMAND: 'Bash',
  LIST_DIRECTORY: 'Read',
};

function antigravityRoot(): string {
  return join(homedir(), '.gemini', 'antigravity');
}

/** All trajectory transcript files on disk. */
function discoverTranscripts(root: string): { uuid: string; file: string }[] {
  const brain = join(root, 'brain');
  if (!existsSync(brain)) return [];
  const out: { uuid: string; file: string }[] = [];
  for (const entry of readdirSync(brain, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(brain, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(file)) out.push({ uuid: entry.name, file });
  }
  return out;
}

function ts(s: string | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/** Pull the human request out of `<USER_REQUEST>…</USER_REQUEST>`, else trim tags. */
function userText(content: string): string {
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (m) return m[1].trim();
  return content.replace(/<\/?[A-Z_]+>/g, '').trim();
}

/** Best-effort model name from a `Model Selection` settings-change note. */
function detectModel(content: string): string | null {
  const m = content.match(/Model Selection`?\s+from\s+.*?\s+to\s+`?([^`(\n]+?)(?:\s*\(|`|\n)/i);
  return m ? m[1].trim() : null;
}

/** First file:// path in the text → its directory, used as the project path. */
function extractProjectPath(content: string): string | null {
  const m = content.match(/file:\/\/(\/[^\s"')]+)/);
  if (!m) return null;
  try { return dirname(decodeURIComponent(m[1])); } catch { return dirname(m[1]); }
}

function parseTranscript(uuid: string, file: string): ParsedSession | null {
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch { return null; }
  if (lines.length === 0) return null;

  const steps: Step[] = [];
  for (const line of lines) {
    try { steps.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  steps.sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));

  const sessionId = `antigravity-${uuid}`;
  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  let model: string | null = null;
  let firstUserMessage: string | null = null;
  let projectPath: string | null = null;
  let turnCount = 0;
  let toolCallCount = 0;
  let startedAt = 0;
  let endedAt = 0;
  let seq = 0;
  let lastMessageId: string | null = null;

  for (const step of steps) {
    const t = ts(step.created_at);
    if (t) { if (!startedAt || t < startedAt) startedAt = t; if (t > endedAt) endedAt = t; }
    const content = typeof step.content === 'string' ? step.content : null;
    if (!projectPath && content) projectPath = extractProjectPath(content);

    if (step.type === 'USER_INPUT' && content) {
      if (!model) model = detectModel(content);
      const text = userText(content);
      if (!text) continue;
      if (!firstUserMessage) firstUserMessage = text;
      turnCount++;
      const id = `${sessionId}-${seq}`;
      messages.push({
        id, session_id: sessionId, parent_id: null, role: 'user', model: null,
        content_text: truncate(text), content_type: 'text', timestamp: t || startedAt,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, seq: seq++,
      });
      lastMessageId = id;
    } else if (step.type === 'PLANNER_RESPONSE') {
      const text = content || (typeof step.thinking === 'string' ? step.thinking : null);
      if (!text) continue;
      const id = `${sessionId}-${seq}`;
      messages.push({
        id, session_id: sessionId, parent_id: null, role: 'assistant', model,
        content_text: truncate(text), content_type: 'text', timestamp: t || startedAt,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, seq: seq++,
      });
      lastMessageId = id;
    } else if (TOOL_MAP[step.type || '']) {
      toolCallCount++;
      toolCalls.push({
        id: `${sessionId}-tc-${toolCallCount}`,
        session_id: sessionId,
        message_id: lastMessageId,
        tool_name: TOOL_MAP[step.type!],
        tool_input: null,
        tool_output: truncate(content, 5000),
        is_error: step.status && !/^(DONE|SUCCESS|COMPLETED)$/i.test(step.status) ? 1 : 0,
        duration_ms: null,
        timestamp: t || startedAt,
      });
    }
  }

  if (messages.length === 0) return null;

  const modelUsage = new Map<string, ModelUsage>();
  if (model) {
    modelUsage.set(model, {
      session_id: sessionId, model, input_tokens: 0, output_tokens: 0,
      cache_read: 0, cache_write: 0, message_count: messages.filter((m) => m.role === 'assistant').length,
    });
  }

  return {
    session: {
      id: sessionId,
      agent: AGENT,
      agent_version: null,
      title: firstUserMessage ? firstUserMessage.slice(0, 100) : null,
      status: 'completed',
      project_path: projectPath,
      repository_url: null,
      git_branch: null,
      git_sha: null,
      model_primary: model,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt > startedAt ? endedAt - startedAt : null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read: 0,
      total_cache_write: 0,
      turn_count: turnCount,
      tool_call_count: toolCallCount,
      first_user_message: truncate(firstUserMessage, 500),
      source_path: file,
      collected_at: Date.now(),
    },
    messages,
    toolCalls,
    modelUsage,
  };
}

export async function collectAntigravity(db: Database.Database, onProgress?: (done: number, total: number) => void): Promise<CollectorStats> {
  const stats = emptyStats();
  const root = antigravityRoot();
  if (!existsSync(root)) return stats;

  const w = createDbWriter(db);
  const transcripts = discoverTranscripts(root);
  let progressDone = 0;
  onProgress?.(0, transcripts.length);

  const sourceKey = `antigravity::${root}`;
  const watermark = w.getWatermark.get(sourceKey) as any;

  for (const { uuid, file } of transcripts) {
    onProgress?.(++progressDone, transcripts.length);
    try {
      // Skip transcripts unchanged since last collection.
      const mtime = statSync(file).mtimeMs;
      if (watermark?.last_timestamp && mtime <= watermark.last_timestamp) continue;
      const parsed = parseTranscript(uuid, file);
      if (!parsed || parsed.messages.length === 0) continue;
      persistSession(w, parsed, stats);
    } catch (err: any) {
      if (isPermissionError(err)) {
        console.warn(`[antigravity] Permission denied reading ${file}, skipping`);
      } else {
        stats.errors.push(`antigravity ${uuid}: ${err.message}`);
      }
    }
  }

  w.setWatermark.run({
    source: sourceKey,
    last_file: null,
    last_offset: 0,
    last_session_id: null,
    last_timestamp: Date.now(),
    updated_at: Date.now(),
  });

  return stats;
}
