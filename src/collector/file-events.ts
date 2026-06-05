import type Database from 'better-sqlite3';
import type { FileEvent } from '../core/types.js';

/**
 * Derive file-touch events from tool calls. File paths are not a first-class
 * column anywhere — they live inside each tool call's JSON `tool_input`. This
 * module pulls them out into `file_events` so the knowledge graph can have
 * real file nodes and session↔file edges.
 *
 * Honesty note: line counts are approximate (newline counts of the changed
 * blocks), and tokens are NEVER attributed to a file here — token weights live
 * on session/model/message rows, where they are actually measured.
 */

type Op = FileEvent['op'];

/** tool_name (lowercased) → operation. Tools not listed are ignored. */
const TOOL_OP: Record<string, Op> = {
  read: 'read',
  read_file: 'read',
  view: 'read',
  edit: 'edit',
  multiedit: 'edit',
  strreplace: 'edit',
  str_replace: 'edit',
  str_replace_editor: 'edit',
  notebookedit: 'edit',
  write: 'write',
  write_file: 'write',
  create_file: 'create',
};

function countLines(s: unknown): number {
  if (typeof s !== 'string' || s.length === 0) return 0;
  return s.split('\n').length;
}

function extOf(path: string): string | null {
  const base = path.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : null;
}

/** Make a relative path absolute against the session's repo root, if possible. */
function normalizePath(path: string, repoPath: string | null): string {
  if (/^([a-zA-Z]:[\\/]|[\\/]|~)/.test(path)) return path; // absolute or ~
  if (repoPath) return `${repoPath.replace(/[\\/]$/, '')}/${path}`;
  return path;
}

interface RawTouch { file_path: string; op: Op; lines_added: number; lines_removed: number; }

/**
 * Parse one tool call's input into zero or more file touches.
 * Handles the three shapes seen across agents:
 *  - `{ file_path | path, old_string?, new_string?, content? }` (Claude/Cursor)
 *  - `{ ..., edits: [{old_string,new_string}] }` (MultiEdit)
 *  - `{ command: "*** Update File: ...\n@@ ...\n+a\n-b" }` (Codex apply_patch)
 */
export function parseTouches(toolName: string, toolInput: string | null): RawTouch[] {
  if (!toolInput) return [];
  let j: any;
  try { j = JSON.parse(toolInput); } catch { return []; }
  if (!j || typeof j !== 'object') return [];

  const tn = toolName.toLowerCase();

  if (tn === 'apply_patch' && typeof j.command === 'string') {
    return parseApplyPatch(j.command);
  }

  // Codex (and other shell-routing agents) mutate files through the shell, not
  // a structured edit tool. Parse the common, unambiguous mutation forms out of
  // the command string so codex isn't a blank on the file graph.
  if (tn === 'exec_command' || tn === 'bash' || tn === 'shell') {
    const cmd = typeof j.cmd === 'string' ? j.cmd : typeof j.command === 'string' ? j.command : null;
    return cmd ? parseShell(cmd) : [];
  }

  const path: string | undefined = j.file_path || j.path || j.notebook_path || j.filePath;
  if (!path || typeof path !== 'string') return [];

  const op = TOOL_OP[tn];
  if (!op) return [];

  let added = 0, removed = 0;
  if (Array.isArray(j.edits)) {
    for (const e of j.edits) { added += countLines(e?.new_string); removed += countLines(e?.old_string); }
  } else if (op === 'edit') {
    added = countLines(j.new_string); removed = countLines(j.old_string);
  } else if (op === 'write' || op === 'create') {
    added = countLines(j.content ?? j.file_text ?? j.text);
  }

  return [{ file_path: path, op, lines_added: added, lines_removed: removed }];
}

/** Parse a Codex `apply_patch` command body into per-file touches. */
function parseApplyPatch(command: string): RawTouch[] {
  const out: RawTouch[] = [];
  const lines = command.split('\n');
  let cur: RawTouch | null = null;
  for (const line of lines) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      const op: Op = m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : 'edit';
      cur = { file_path: m[2].trim(), op, lines_added: 0, lines_removed: 0 };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) cur.lines_added++;
    else if (line.startsWith('-') && !line.startsWith('---')) cur.lines_removed++;
  }
  if (cur) out.push(cur);
  return out;
}

/** A token that plausibly names a real file (has an extension, no glob/flag). */
function looksLikeFile(p: string): boolean {
  if (!p || p.startsWith('-') || p.startsWith('$')) return false;
  if (p.includes('/dev/') || /[*?]/.test(p)) return false;
  const base = p.split(/[\\/]/).pop() || '';
  return /\.[A-Za-z0-9]{1,12}$/.test(base);
}

/**
 * Parse unambiguous file mutations out of a shell command. Conservative on
 * purpose — only forms that clearly WRITE/EDIT/DELETE a file, never reads
 * (cat/sed -n/head), to avoid flooding the graph with false touches.
 */
function parseShell(cmd: string): RawTouch[] {
  // Embedded apply_patch piped through the shell (common in Codex).
  if (/\*\*\* (Begin Patch|Update File:|Add File:|Delete File:)/.test(cmd)) {
    const t = parseApplyPatch(cmd.slice(cmd.indexOf('*** ')));
    if (t.length) return t;
  }
  const found = new Map<string, RawTouch>();
  const add = (file: string, op: Op) => {
    const f = file.replace(/['"]/g, '');
    if (!looksLikeFile(f) || found.size >= 12) return;
    const k = `${f}|${op}`;
    if (!found.has(k)) found.set(k, { file_path: f, op, lines_added: 0, lines_removed: 0 });
  };
  for (const seg of cmd.split(/[\n;|&]+/)) {
    if (/\bsed\b/.test(seg) && /\s-i\b/.test(seg)) {
      const toks = seg.trim().split(/\s+/);
      add(toks[toks.length - 1], 'edit');
    }
    for (const m of seg.matchAll(/\btee\b\s+(?:-a\s+)?([^\s|&;]+)/g)) add(m[1], 'write');
    for (const m of seg.matchAll(/\btouch\b\s+([^|&;]+)/g)) m[1].trim().split(/\s+/).forEach((t) => add(t, 'create'));
    if (/\brm\b/.test(seg)) for (const t of seg.replace(/.*\brm\b/, '').split(/\s+/)) add(t, 'delete');
  }
  // output redirects: `> file`, `>> file` (skips `2>`, `>&`, `>/dev/null`)
  for (const m of cmd.matchAll(/(?:^|[\s);])>>?\s*([^\s|&;()<>]+)/g)) add(m[1], 'write');
  return [...found.values()];
}

/** Transient/build artifacts that should never become file-graph nodes. */
const NOISE_DIR = /(^|[\\/])\.?(git|node_modules|dist|build|next|target|coverage|__pycache__|tmp)([\\/]|$)/;
const NOISE_TMP = /(^|[\\/])(tmp|private[\\/]var|var[\\/]folders)[\\/]/;
const NOISE_EXT = new Set(['tfplan', 'out', 'log', 'lock', 'tmp', 'pyc', 'o', 'class', 'coverage', 'zip']);

function isNoise(path: string, ext: string | null): boolean {
  if (NOISE_TMP.test(path) || NOISE_DIR.test(path)) return true;
  if (ext && NOISE_EXT.has(ext)) return true;
  if (/(^|[\\/])\.coverage/.test(path)) return true;
  return false;
}

/** Build FileEvent rows for one stored tool-call row. */
export function eventsFromToolCall(
  tc: { id: string; session_id: string; tool_name: string; tool_input: string | null; is_error?: number; timestamp: number },
  ctx: { agent: string | null; repo_path: string | null },
): FileEvent[] {
  const touches = parseTouches(tc.tool_name, tc.tool_input);
  const out: FileEvent[] = [];
  touches.forEach((t, i) => {
    const file_path = normalizePath(t.file_path, ctx.repo_path);
    const ext = extOf(file_path);
    if (isNoise(file_path, ext)) return;
    out.push({
      id: `${tc.id}#${i}`,
      tool_call_id: tc.id,
      session_id: tc.session_id,
      agent: ctx.agent,
      file_path,
      repo_path: ctx.repo_path,
      op: t.op,
      tool_name: tc.tool_name,
      ext,
      lines_added: t.lines_added,
      lines_removed: t.lines_removed,
      is_error: tc.is_error ? 1 : 0,
      timestamp: tc.timestamp,
    });
  });
  return out;
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO file_events
    (id, tool_call_id, session_id, agent, file_path, repo_path, op, tool_name, ext, lines_added, lines_removed, is_error, timestamp)
  VALUES
    (@id, @tool_call_id, @session_id, @agent, @file_path, @repo_path, @op, @tool_name, @ext, @lines_added, @lines_removed, @is_error, @timestamp)
`;

/**
 * Backfill file_events from already-stored tool calls. Idempotent and
 * incremental: only processes tool_calls not already represented in
 * file_events, so it stays cheap on every collect (unlike a full re-scan).
 */
export function backfillFileEvents(db: Database.Database): number {
  const insert = db.prepare(INSERT_SQL);
  let inserted = 0;
  const run = db.transaction(() => {
    const rows = db.prepare(`
      SELECT tc.id, tc.session_id, tc.tool_name, tc.tool_input, tc.is_error, tc.timestamp,
             s.agent AS agent, s.project_path AS repo_path
      FROM tool_calls tc
      JOIN sessions s ON s.id = tc.session_id
      WHERE tc.id NOT IN (SELECT tool_call_id FROM file_events)
    `).all() as any[];
    for (const r of rows) {
      for (const ev of eventsFromToolCall(r, { agent: r.agent, repo_path: r.repo_path })) {
        insert.run(ev);
        inserted++;
      }
    }
  });
  run();
  return inserted;
}
