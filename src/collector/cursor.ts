import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join, basename } from 'path';
import { homedir, platform } from 'os';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { Session, Message, ToolCall, ModelUsage } from '../core/types.js';
import { truncate, emptyStats, createDbWriter, persistSession, isPermissionError, type CollectorStats, type ParsedSession } from './shared.js';

/**
 * Cursor stores data in two places:
 *
 * 1. Agent transcripts: ~/.cursor/projects/<encoded-path>/agent-transcripts/<uuid>/<uuid>.jsonl
 *    Format: {role, message: {content: [{type, text|name|input}]}}
 *    - No tool IDs on tool_use blocks (generate synthetic ones)
 *    - No tool_result blocks (tool outputs not stored)
 *    - No per-message timestamps (use file mtime)
 *    - No token usage data IN THE TRANSCRIPT (see #3)
 *    - Model field absent or "fast"
 *    - Subagent transcripts in subagents/<uuid>.jsonl
 *
 * 2. AI tracking DB: ~/.cursor/ai-tracking/ai-code-tracking.db
 *    - scored_commits: AI attribution per git commit (unique to Cursor!)
 *    - conversation_summaries: title/model per conversation (may be empty)
 *
 * 3. App state DB: <Cursor user globalStorage>/state.vscdb (SQLite)
 *    - cursorDiskKV table, rows keyed `bubbleId:<composerId>:<bubbleId>`.
 *    - The transcript <uuid> IS the composerId, so bubbles join directly.
 *    - Each bubble value carries `"tokenCount":{"inputTokens":N,"outputTokens":M}`.
 *      Token data is SPARSE — Cursor only persists it for some bubbles — but
 *      where present it is the only real usage signal Cursor exposes. We sum
 *      it per composer to populate session token totals (transcripts give 0).
 */

function decodeProjectPath(dirName: string): string {
  // Cursor encodes paths by replacing / with -
  // Problem: directories with dashes/dots/underscores become ambiguous
  // e.g. "data-cloud-core-schema-registry" could be data_cloud_core.schema_registry
  //
  // Strategy: build path left-to-right, at each step check if the segment
  // exists as a directory. If not, try joining with next segment(s) using
  // common separators (-, _, .)
  const parts = dirName.split('-');

  function resolve(idx: number, currentPath: string): string | null {
    if (idx >= parts.length) {
      return existsSync(currentPath) ? currentPath : null;
    }

    // Try consuming 1, 2, 3... segments as a single directory name
    // with different join characters
    const maxLookahead = Math.min(6, parts.length - idx);
    for (let count = 1; count <= maxLookahead; count++) {
      const segment = parts.slice(idx, idx + count);

      // Try different separators between sub-parts
      const candidates = count === 1
        ? [segment[0]]
        : [
            segment.join('-'),
            segment.join('_'),
            segment.join('.'),
            segment.join(''),
          ];

      for (const name of candidates) {
        const candidate = join(currentPath, name);
        if (existsSync(candidate)) {
          const result = resolve(idx + count, candidate);
          if (result) return result;
        }
      }
    }
    return null;
  }

  const resolved = resolve(0, '/');
  if (resolved) return resolved;

  // Fallback: fuzzy match — find the deepest existing ancestor, then
  // look for a child dir whose name contains remaining segments
  let bestPath = '/';
  let consumed = 0;
  for (let i = 0; i < parts.length; i++) {
    const candidate = join(bestPath, parts[i]);
    if (existsSync(candidate)) {
      bestPath = candidate;
      consumed = i + 1;
    } else {
      break;
    }
  }

  if (consumed < parts.length && existsSync(bestPath)) {
    const remaining = parts.slice(consumed);
    try {
      const children = readdirSync(bestPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      // Find a child that contains all remaining segments (in order)
      const pattern = remaining.join('.*');
      const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) =>
        m === '.' || m === '*' ? m : '\\' + m
      ));
      const match = children.find(c => regex.test(c.replace(/[_.-]/g, '-')));
      if (match) return join(bestPath, match);

      // Or find a child that starts with the first remaining segment (any separator)
      const prefix = remaining[0];
      const prefixMatch = children.find(c => c.startsWith(prefix) || c.replace(/[_.-]/g, '-').startsWith(remaining.join('-')));
      if (prefixMatch) return join(bestPath, prefixMatch);
    } catch {}
  }

  // Final fallback: simple dash-to-slash
  return '/' + parts.join('/');
}

function discoverProjects(cursorDir: string): Array<{ dir: string; projectPath: string; encodedName: string }> {
  const projectsDir = join(cursorDir, 'projects');
  if (!existsSync(projectsDir)) return [];

  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'empty-window')
      .map(d => ({
        dir: join(projectsDir, d.name),
        projectPath: decodeProjectPath(d.name),
        encodedName: d.name,
      }));
  } catch (err: any) {
    if (isPermissionError(err)) {
      console.warn(`[cursor] Permission denied reading ${projectsDir}, skipping`);
      return [];
    }
    throw err;
  }
}

function discoverSessions(projectDir: string): Array<{ id: string; dir: string; mainFile: string }> {
  const transcriptsDir = join(projectDir, 'agent-transcripts');
  if (!existsSync(transcriptsDir)) return [];

  const results: Array<{ id: string; dir: string; mainFile: string }> = [];
  try {
    for (const entry of readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mainFile = join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
      if (existsSync(mainFile)) {
        results.push({ id: entry.name, dir: join(transcriptsDir, entry.name), mainFile });
      }
    }
  } catch (err: any) {
    if (isPermissionError(err)) {
      console.warn(`[cursor] Permission denied reading ${transcriptsDir}, skipping`);
    }
    /* skip unreadable */
  }
  return results;
}

function discoverSubagents(sessionDir: string): string[] {
  const subDir = join(sessionDir, 'subagents');
  if (!existsSync(subDir)) return [];
  try {
    return readdirSync(subDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(subDir, f));
  } catch { return []; }
}

function extractText(content: any): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    if (block.type === 'tool_use') parts.push(`[tool: ${block.name}]`);
  }
  return parts.join('\n') || null;
}

async function parseCursorJsonl(
  filePath: string,
  sessionId: string,
  projectPath: string | null,
): Promise<ParsedSession | null> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  let firstUserMessage: string | null = null;
  let turnCount = 0;
  let toolCallCount = 0;
  let seq = 0;
  let fileCreated = 0;
  let fileModified = 0;

  try {
    const stat = statSync(filePath);
    fileCreated = stat.birthtimeMs || stat.ctimeMs;
    fileModified = stat.mtimeMs;
  } catch {}

  // Estimate per-message timestamps by distributing across file lifespan
  const allLines: any[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { allLines.push(JSON.parse(line)); } catch { continue; }
  }

  if (allLines.length === 0) return null;

  const duration = fileModified - fileCreated;
  const timeStep = allLines.length > 1 ? duration / (allLines.length - 1) : 0;

  for (let i = 0; i < allLines.length; i++) {
    const obj = allLines[i];
    const role = obj.role;
    if (!role || !obj.message?.content) continue;

    const content = obj.message.content;
    const estimatedTs = Math.round(fileCreated + (i * timeStep));
    const msgId = `${sessionId}-${seq}`;

    if (role === 'user') {
      let text = extractText(content);
      // Strip <user_query> wrapper
      if (text) text = text.replace(/<\/?user_query>/g, '').trim();
      if (text && !firstUserMessage) firstUserMessage = text;
      turnCount++;

      messages.push({
        id: msgId,
        session_id: sessionId,
        parent_id: null,
        role: 'user',
        model: null,
        content_text: truncate(text),
        content_type: 'text',
        timestamp: estimatedTs,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
        seq: seq++,
      });
    } else if (role === 'assistant') {
      const text = extractText(content);

      // Extract tool uses — Cursor has no IDs, generate synthetic ones
      if (Array.isArray(content)) {
        for (let bi = 0; bi < content.length; bi++) {
          const block = content[bi];
          if (block.type === 'tool_use' && block.name) {
            const tcId = `${sessionId}-tc-${seq}-${bi}`;
            toolCalls.push({
              id: tcId,
              session_id: sessionId,
              message_id: msgId,
              tool_name: block.name,
              tool_input: truncate(JSON.stringify(block.input), 5000),
              tool_output: null, // Cursor doesn't store tool outputs
              is_error: 0,
              duration_ms: null,
              timestamp: estimatedTs,
            });
            toolCallCount++;
          }
        }
      }

      messages.push({
        id: msgId,
        session_id: sessionId,
        parent_id: null,
        role: 'assistant',
        model: null, // Cursor doesn't store model per message
        content_text: truncate(text),
        content_type: toolCallCount > 0 ? 'tool_use' : 'text',
        timestamp: estimatedTs,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
        seq: seq++,
      });
    }
  }

  if (messages.length === 0) return null;

  const durationMs = fileModified > fileCreated ? Math.round(fileModified - fileCreated) : null;

  const session: Session = {
    id: sessionId,
    agent: 'cursor',
    agent_version: null,
    title: firstUserMessage ? firstUserMessage.slice(0, 100) : null,
    status: 'completed',
    project_path: projectPath,
    repository_url: null,
    git_branch: null,
    git_sha: null,
    model_primary: null, // Unknown — Cursor doesn't expose in transcripts
    started_at: Math.round(fileCreated),
    ended_at: Math.round(fileModified),
    duration_ms: durationMs,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read: 0,
    total_cache_write: 0,
    turn_count: turnCount,
    tool_call_count: toolCallCount,
    first_user_message: truncate(firstUserMessage, 500),
    source_path: filePath,
    collected_at: Date.now(),
  };

  return { session, messages, toolCalls, modelUsage: new Map() };
}

function extractGitBranch(projectPath: string): string | null {
  const headFile = join(projectPath, '.git', 'HEAD');
  if (!existsSync(headFile)) return null;
  try {
    const head = readFileSync(headFile, 'utf8').trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    return match ? match[1] : null;
  } catch { return null; }
}

/** Locate Cursor's app state DB (state.vscdb) for the current platform. */
function findCursorStateDb(): string | null {
  const home = homedir();
  const p = platform();
  const base =
    p === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
      : p === 'win32'
        ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage')
        : join(home, '.config', 'Cursor', 'User', 'globalStorage');
  const dbPath = join(base, 'state.vscdb');
  return existsSync(dbPath) ? dbPath : null;
}

interface CursorBubble {
  type: number;          // 1 = user, 2 = assistant
  text: string;
  input: number;
  output: number;
  ts: number | null;     // epoch ms, if the bubble carried a timestamp
  tools: number;         // approx tool activity in this bubble
}

interface ComposerMeta { createdAt: number; mode: string }

interface CursorState {
  metas: Map<string, ComposerMeta>;
  bubbles: Map<string, CursorBubble[]>;
}

/** Parse a bubble's createdAt (ISO string or epoch ms) into epoch ms, or null. */
function bubbleTs(v: any): number | null {
  if (typeof v === 'number' && v > 0) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Load Cursor's app state DB (state.vscdb): composer metadata + per-composer
 * bubbles (messages with token counts). This is the only place Cursor stores
 * real token usage. Returns empty maps if the DB is missing, locked, or its
 * schema has drifted (best-effort — Cursor remains usable without it).
 */
function loadCursorState(): CursorState {
  const metas = new Map<string, ComposerMeta>();
  const bubbles = new Map<string, CursorBubble[]>();
  const dbPath = findCursorStateDb();
  if (!dbPath) return { metas, bubbles };

  let sdb: BetterSqlite3.Database | null = null;
  try {
    sdb = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });

    // Composer metadata
    const metaRows = sdb
      .prepare(`SELECT key, value FROM cursorDiskKV WHERE key GLOB 'composerData:*'`)
      .all() as Array<{ key: string; value: string }>;
    for (const row of metaRows) {
      const id = row.key.slice('composerData:'.length);
      try {
        const d = JSON.parse(row.value);
        if (!d || typeof d !== 'object') continue;
        metas.set(id, {
          createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
          mode: typeof d.unifiedMode === 'string' ? d.unifiedMode : 'agent',
        });
      } catch { /* skip malformed */ }
    }

    // Bubbles (messages). These blobs are large; keep only the fields we need.
    const bubbleRows = sdb
      .prepare(`SELECT key, value FROM cursorDiskKV WHERE key GLOB 'bubbleId:*'`)
      .all() as Array<{ key: string; value: string }>;
    for (const row of bubbleRows) {
      const composerId = row.key.split(':')[1];
      if (!composerId) continue;
      let d: any;
      try { d = JSON.parse(row.value); } catch { continue; }
      if (!d || typeof d !== 'object') continue;
      const tc = d.tokenCount || {};
      const b: CursorBubble = {
        type: typeof d.type === 'number' ? d.type : 0,
        text: typeof d.text === 'string' ? d.text : '',
        input: Number(tc.inputTokens) || 0,
        output: Number(tc.outputTokens) || 0,
        ts: bubbleTs(d.createdAt),
        tools: (Array.isArray(d.toolResults) ? d.toolResults.length : 0) +
               (Array.isArray(d.codeBlocks) ? d.codeBlocks.length : 0),
      };
      const list = bubbles.get(composerId);
      if (list) list.push(b);
      else bubbles.set(composerId, [b]);
    }
  } catch {
    // DB locked / unreadable / schema drift — skip state ingestion entirely.
    return { metas: new Map(), bubbles: new Map() };
  } finally {
    try { sdb?.close(); } catch { /* ignore */ }
  }
  return { metas, bubbles };
}

/** Build a session (+messages) from a composer's bubbles. Null if no content. */
function buildComposerSession(
  composerId: string,
  meta: ComposerMeta | undefined,
  rawBubbles: CursorBubble[],
): ParsedSession | null {
  // Order bubbles by timestamp when available; fall back to insertion order.
  const bubbles = rawBubbles
    .map((b, i) => ({ b, i }))
    .sort((a, z) => {
      if (a.b.ts != null && z.b.ts != null && a.b.ts !== z.b.ts) return a.b.ts - z.b.ts;
      if (a.b.ts != null && z.b.ts == null) return -1;
      if (a.b.ts == null && z.b.ts != null) return 1;
      return a.i - z.i;
    })
    .map((x) => x.b);

  const messages: Message[] = [];
  let firstUserMessage: string | null = null;
  let totalInput = 0;
  let totalOutput = 0;
  let turnCount = 0;
  let toolCallCount = 0;
  let seq = 0;

  const tsList = bubbles.map((b) => b.ts).filter((t): t is number => t != null);
  const startedAt = meta?.createdAt && meta.createdAt > 0
    ? meta.createdAt
    : (tsList.length ? Math.min(...tsList) : 0);
  const endedAt = tsList.length ? Math.max(...tsList) : startedAt;

  for (const b of bubbles) {
    const role = b.type === 1 ? 'user' : b.type === 2 ? 'assistant' : null;
    if (!role) continue;
    if (!b.text && b.input === 0 && b.output === 0) continue;

    totalInput += b.input;
    totalOutput += b.output;
    toolCallCount += b.tools;
    if (role === 'user') {
      turnCount++;
      if (b.text && !firstUserMessage) firstUserMessage = b.text;
    }

    const ts = b.ts ?? (startedAt + seq);
    messages.push({
      id: `${composerId}-${seq}`,
      session_id: composerId,
      parent_id: null,
      role,
      model: null,
      content_text: truncate(b.text || null),
      content_type: 'text',
      timestamp: ts,
      input_tokens: b.input,
      output_tokens: b.output,
      cache_read: 0,
      cache_write: 0,
      seq: seq++,
    });
  }

  if (messages.length === 0) return null;

  const session: Session = {
    id: composerId,
    agent: 'cursor',
    agent_version: null,
    title: firstUserMessage ? firstUserMessage.slice(0, 100) : null,
    status: 'completed',
    project_path: null,        // composerData does not reliably carry a path
    repository_url: null,
    git_branch: null,
    git_sha: null,
    model_primary: null,       // Cursor does not expose the model in this store
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: endedAt > startedAt ? endedAt - startedAt : null,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cache_read: 0,
    total_cache_write: 0,
    turn_count: turnCount,
    tool_call_count: toolCallCount,
    first_user_message: truncate(firstUserMessage, 500),
    source_path: `state.vscdb#${composerId}`,
    collected_at: Date.now(),
  };

  return { session, messages, toolCalls: [], modelUsage: new Map() };
}

export async function collectCursor(
  db: Database.Database,
  cursorDir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<CollectorStats> {
  const stats = emptyStats();
  const w = createDbWriter(db);

  // Cursor's app state DB holds token usage + chats that have no transcript.
  const state = loadCursorState();
  const tokenTotals = new Map<string, { input: number; output: number }>();
  for (const [cid, bubs] of state.bubbles) {
    let input = 0, output = 0;
    for (const b of bubs) { input += b.input; output += b.output; }
    if (input || output) tokenTotals.set(cid, { input, output });
  }
  const ingested = new Set<string>();

  const projects = discoverProjects(cursorDir);
  const progressTotal = projects.length + state.bubbles.size;
  let progressDone = 0;
  onProgress?.(0, progressTotal);

  for (const { dir, projectPath, encodedName } of projects) {
    const sourceKey = `cursor::${dir}`;
    const watermark = w.getWatermark.get(sourceKey) as any;
    const sessions = discoverSessions(dir);

    // Try to get git branch from actual project dir
    const gitBranch = extractGitBranch(projectPath);

    for (const sess of sessions) {
      try {
        const mainStat = statSync(sess.mainFile);
        if (watermark?.last_timestamp && mainStat.mtimeMs < watermark.last_timestamp) continue;

        const parsed = await parseCursorJsonl(sess.mainFile, sess.id, projectPath);
        if (!parsed || parsed.messages.length === 0) continue;

        // Enrich with git info
        parsed.session.git_branch = gitBranch;

        // Enrich with token totals from state.vscdb (composerId === transcript id)
        const tok = tokenTotals.get(sess.id);
        if (tok) {
          parsed.session.total_input_tokens = tok.input;
          parsed.session.total_output_tokens = tok.output;
        }

        persistSession(w, parsed, stats);
        ingested.add(sess.id);

        // Subagent transcripts
        const subFiles = discoverSubagents(sess.dir);
        for (const subFile of subFiles) {
          try {
            const subId = `cursor-sub-${basename(subFile, '.jsonl')}`;
            const subParsed = await parseCursorJsonl(subFile, subId, projectPath);
            if (!subParsed || subParsed.messages.length === 0) continue;
            subParsed.session.git_branch = gitBranch;
            persistSession(w, subParsed, stats);
          } catch (err: any) {
            stats.errors.push(`cursor subagent ${basename(subFile)}: ${err.message}`);
          }
        }
      } catch (err: any) {
        if (isPermissionError(err)) {
          console.warn(`[cursor] Permission denied processing session ${sess.id}, skipping`);
        } else {
          stats.errors.push(`cursor ${sess.id}: ${err.message}`);
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

    onProgress?.(++progressDone, progressTotal);
  }

  // Ingest composer sessions from state.vscdb that have no agent-transcript.
  // Transcripts (above) win for overlapping ids — they carry project path and
  // tool-call detail — so we only add composers not already ingested.
  for (const [composerId, bubs] of state.bubbles) {
    onProgress?.(++progressDone, progressTotal);
    if (ingested.has(composerId)) continue;
    try {
      const parsed = buildComposerSession(composerId, state.metas.get(composerId), bubs);
      if (!parsed) continue;
      persistSession(w, parsed, stats);
      ingested.add(composerId);
    } catch (err: any) {
      stats.errors.push(`cursor composer ${composerId}: ${err.message}`);
    }
  }

  return stats;
}
