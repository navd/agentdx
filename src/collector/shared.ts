import { basename } from 'path';
import type Database from 'better-sqlite3';
import type { Session, Message, ToolCall, ModelUsage } from '../core/types.js';

export interface CollectorStats {
  sessions: number;
  messages: number;
  toolCalls: number;
  errors: string[];
}

export function emptyStats(): CollectorStats {
  return { sessions: 0, messages: 0, toolCalls: 0, errors: [] };
}

export function truncate(s: string | null | undefined, max = 10000): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Minimum valid timestamp: 2023-01-01T00:00:00Z */
const MIN_TIMESTAMP = 1672531200000;

/**
 * Validates a session's started_at timestamp.
 * Rejects timestamps before 2023-01-01 or more than 1 day in the future.
 * Returns true if the timestamp is valid, false otherwise.
 */
export function isValidSessionTimestamp(startedAt: number): boolean {
  if (startedAt < MIN_TIMESTAMP) return false;
  if (startedAt > Date.now() + 86400000) return false;
  return true;
}

/**
 * Returns true if the error code indicates a permission denied error (EACCES or EPERM).
 */
export function isPermissionError(err: any): boolean {
  return err?.code === 'EACCES' || err?.code === 'EPERM';
}

export interface DbWriter {
  insertSession: Database.Statement;
  insertMessage: Database.Statement;
  insertToolCall: Database.Statement;
  insertModelUsage: Database.Statement;
  insertRepo: Database.Statement;
  insertSkill: Database.Statement;
  getWatermark: Database.Statement;
  setWatermark: Database.Statement;
  db: Database.Database;
}

export interface SkillInvocation {
  id: string;
  session_id: string;
  message_id: string | null;
  skill: string;
  source: 'slash' | 'command' | 'tool';
  timestamp: number;
}

// `<command-name>/foo</command-name>` (the leading slash is optional).
const CMD_TAG_RE = /<command-name>\s*\/?([A-Za-z][\w:-]*)\s*<\/command-name>/g;
// A user message that *is* a slash command: `/foo ...`. Rejects file paths by
// disallowing a second slash in the first token (e.g. `/Users/...`).
const SLASH_RE = /^\/([A-Za-z][\w-]*)(?:\s|$)/;

/** Pull the skill name out of a `Skill` tool call's JSON input, if present. */
function skillFromToolInput(input: string | null): string | null {
  if (!input) return null;
  try {
    const j = JSON.parse(input);
    return j && typeof j.skill === 'string' && j.skill ? j.skill : null;
  } catch {
    return null;
  }
}

/**
 * Detect skill / slash-command invocations within a parsed session from three
 * sources: the `Skill` tool, `<command-name>` tags, and a leading `/cmd` in a
 * user message. One row per invocation.
 */
export function extractSkills(parsed: ParsedSession): SkillInvocation[] {
  const out: SkillInvocation[] = [];
  const sid = parsed.session.id;
  let n = 0;

  for (const tc of parsed.toolCalls) {
    if (tc.tool_name !== 'Skill') continue;
    const skill = skillFromToolInput(tc.tool_input);
    if (skill) out.push({ id: `${sid}-sk-${n++}`, session_id: sid, message_id: tc.message_id ?? null, skill, source: 'tool', timestamp: tc.timestamp });
  }

  for (const m of parsed.messages) {
    if (m.role !== 'user' || !m.content_text) continue;
    let matched = false;
    CMD_TAG_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CMD_TAG_RE.exec(m.content_text))) {
      out.push({ id: `${sid}-sk-${n++}`, session_id: sid, message_id: m.id, skill: cm[1], source: 'command', timestamp: m.timestamp });
      matched = true;
    }
    if (matched) continue;
    const sm = SLASH_RE.exec(m.content_text.trim());
    if (sm) out.push({ id: `${sid}-sk-${n++}`, session_id: sid, message_id: m.id, skill: sm[1], source: 'slash', timestamp: m.timestamp });
  }

  // Collector-supplied skills from structured fields the heuristics can't reach.
  for (const sk of parsed.extraSkills || []) out.push(sk);

  return out;
}

/**
 * Derive skill_invocations from already-stored Claude messages + Skill tool
 * calls (Claude/Codex have no live skill extraction path). Idempotent and run
 * every collect, so historical AND newly-collected sessions are covered.
 */
export function backfillSkills(db: Database.Database): number {
  // Idempotent (deterministic ids + INSERT OR IGNORE), so run every collect
  // rather than once: it derives Claude slash/Skill invocations from messages
  // and tool_calls (Claude/Codex have no live skill extraction), and the old
  // "skip if the table has any rows" guard broke once other agents (VS Code)
  // started inserting their own skills live during the same collect.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO skill_invocations (id, session_id, message_id, skill, source, timestamp)
    VALUES (@id, @session_id, @message_id, @skill, @source, @timestamp)
  `);
  let inserted = 0;
  const run = db.transaction(() => {
    const tools = db.prepare(`SELECT id, session_id, message_id, tool_input, timestamp FROM tool_calls WHERE tool_name = 'Skill'`).all() as any[];
    for (const tc of tools) {
      const skill = skillFromToolInput(tc.tool_input);
      if (!skill) continue;
      insert.run({ id: `${tc.id}-sk`, session_id: tc.session_id, message_id: tc.message_id ?? null, skill, source: 'tool', timestamp: tc.timestamp });
      inserted++;
    }
    const msgs = db.prepare(`SELECT id, session_id, content_text, timestamp FROM messages WHERE role = 'user' AND (content_text LIKE '/%' OR content_text LIKE '%command-name%')`).all() as any[];
    for (const m of msgs) {
      const text: string = m.content_text || '';
      let matched = false;
      CMD_TAG_RE.lastIndex = 0;
      let cm: RegExpExecArray | null;
      let k = 0;
      while ((cm = CMD_TAG_RE.exec(text))) {
        insert.run({ id: `${m.id}-sk-${k++}`, session_id: m.session_id, message_id: m.id, skill: cm[1], source: 'command', timestamp: m.timestamp });
        inserted++; matched = true;
      }
      if (matched) continue;
      const sm = SLASH_RE.exec(text.trim());
      if (sm) { insert.run({ id: `${m.id}-sk-0`, session_id: m.session_id, message_id: m.id, skill: sm[1], source: 'slash', timestamp: m.timestamp }); inserted++; }
    }
  });
  run();
  return inserted;
}

// sessions.tool_call_count is a denormalized counter that some collectors fill
// from the parser while their tool_calls rows are derived later (cursor) or
// differ (codex), so the column drifts from the actual row count — and pages
// that SUM the column then disagree with pages that COUNT the rows. Recompute it
// from the authoritative tool_calls table so every page agrees. Idempotent.
export function recomputeSessionToolCounts(db: Database.Database): void {
  db.prepare(`
    UPDATE sessions
    SET tool_call_count = (
      SELECT COUNT(*) FROM tool_calls WHERE tool_calls.session_id = sessions.id
    )
  `).run();
}

// Repository aggregates are a pure rollup of the `sessions` table. Recomputing
// them every collect (instead of incrementing per-session) keeps them exact and
// idempotent — a session re-collected across runs no longer inflates its repo.
// total_tokens uses the app-wide input+output+cache_read convention.
export function recomputeRepositories(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT project_path AS path,
      COUNT(*) AS session_count,
      SUM(total_input_tokens + total_output_tokens + total_cache_read) AS total_tokens,
      MAX(started_at) AS last_session_at
    FROM sessions
    WHERE project_path IS NOT NULL AND project_path != ''
    GROUP BY project_path
  `).all() as any[];

  const upsert = db.prepare(`
    INSERT INTO repositories (path, name, session_count, total_tokens, last_session_at)
    VALUES (@path, @name, @session_count, @total_tokens, @last_session_at)
    ON CONFLICT(path) DO UPDATE SET
      session_count = excluded.session_count,
      total_tokens = excluded.total_tokens,
      last_session_at = excluded.last_session_at
  `);

  const txn = db.transaction(() => {
    for (const r of rows) {
      upsert.run({
        path: r.path,
        name: basename(r.path) || r.path,
        session_count: r.session_count || 0,
        total_tokens: r.total_tokens || 0,
        last_session_at: r.last_session_at || null,
      });
    }
  });
  txn();
}

// One-time heal for session rows frozen by the old `ON CONFLICT(id) DO NOTHING`
// insert: a still-open session collected across runs kept its first-seen (low)
// totals while model_usage was refreshed every run. Raise each stale session's
// totals to the per-model sums (MAX never lowers a correct row). Guarded so it
// runs exactly once. Sessions whose files are re-parsed afterwards are kept
// current by the new DO UPDATE insert.
export function healStaleSessions(db: Database.Database): void {
  const MARKER = 'session_total_reheal_v1';
  if (db.prepare(`SELECT 1 FROM collection_state WHERE source = ?`).get(MARKER)) return;

  // MAX() makes the UPDATE itself idempotent, but still commit it atomically
  // with the guard marker so the heal and its "done" flag can't desync.
  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE sessions SET
        total_input_tokens  = MAX(total_input_tokens,  COALESCE((SELECT SUM(input_tokens)  FROM model_usage WHERE session_id = sessions.id), 0)),
        total_output_tokens = MAX(total_output_tokens, COALESCE((SELECT SUM(output_tokens) FROM model_usage WHERE session_id = sessions.id), 0)),
        total_cache_read    = MAX(total_cache_read,    COALESCE((SELECT SUM(cache_read)    FROM model_usage WHERE session_id = sessions.id), 0)),
        total_cache_write   = MAX(total_cache_write,   COALESCE((SELECT SUM(cache_write)   FROM model_usage WHERE session_id = sessions.id), 0))
      WHERE id IN (SELECT DISTINCT session_id FROM model_usage)
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO collection_state
        (source, last_file, last_offset, last_session_id, last_timestamp, updated_at)
      VALUES (?, NULL, 0, NULL, ?, ?)
    `).run(MARKER, Date.now(), Date.now());
  });
  txn();
}

export function createDbWriter(db: Database.Database): DbWriter {
  return {
    insertSession: db.prepare(`
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
    `),
    insertMessage: db.prepare(`
      INSERT INTO messages (id, session_id, parent_id, role, model, content_text,
        content_type, timestamp, input_tokens, output_tokens, cache_read, cache_write, seq)
      VALUES (@id, @session_id, @parent_id, @role, @model, @content_text,
        @content_type, @timestamp, @input_tokens, @output_tokens, @cache_read, @cache_write, @seq)
      ON CONFLICT(id) DO NOTHING
    `),
    insertToolCall: db.prepare(`
      INSERT INTO tool_calls (id, session_id, message_id, tool_name, tool_input,
        tool_output, is_error, duration_ms, timestamp)
      VALUES (@id, @session_id, @message_id, @tool_name, @tool_input,
        @tool_output, @is_error, @duration_ms, @timestamp)
      ON CONFLICT(id) DO NOTHING
    `),
    insertModelUsage: db.prepare(`
      INSERT OR REPLACE INTO model_usage (session_id, model, input_tokens, output_tokens,
        cache_read, cache_write, message_count)
      VALUES (@session_id, @model, @input_tokens, @output_tokens,
        @cache_read, @cache_write, @message_count)
    `),
    insertRepo: db.prepare(`
      INSERT OR IGNORE INTO repositories (path, name, session_count, total_tokens)
      VALUES (@path, @name, 0, 0)
    `),
    insertSkill: db.prepare(`
      INSERT OR IGNORE INTO skill_invocations (id, session_id, message_id, skill, source, timestamp)
      VALUES (@id, @session_id, @message_id, @skill, @source, @timestamp)
    `),
    getWatermark: db.prepare(`SELECT * FROM collection_state WHERE source = ?`),
    setWatermark: db.prepare(`
      INSERT OR REPLACE INTO collection_state (source, last_file, last_offset, last_session_id, last_timestamp, updated_at)
      VALUES (@source, @last_file, @last_offset, @last_session_id, @last_timestamp, @updated_at)
    `),
    db,
  };
}

export interface ParsedSession {
  session: Session;
  messages: Message[];
  toolCalls: ToolCall[];
  modelUsage: Map<string, ModelUsage>;
  // Skill/command invocations a collector extracted from agent-specific
  // structured fields (e.g. VS Code's req.slashCommand, Continue's
  // editorState prompt-blocks) that the generic message/tool heuristics can't
  // see. Merged into skill_invocations alongside extractSkills' own findings.
  extraSkills?: SkillInvocation[];
}

export function persistSession(w: DbWriter, parsed: ParsedSession, stats: CollectorStats): void {
  // Validate session timestamp before inserting
  if (!isValidSessionTimestamp(parsed.session.started_at)) {
    console.warn(`[collector] Skipping session ${parsed.session.id}: invalid started_at ${parsed.session.started_at} (before 2023-01-01 or more than 1 day in the future)`);
    return;
  }

  const txn = w.db.transaction(() => {
    w.insertSession.run(parsed.session);
    for (const msg of parsed.messages) w.insertMessage.run(msg);
    for (const tc of parsed.toolCalls) w.insertToolCall.run(tc);
    for (const [, mu] of parsed.modelUsage) w.insertModelUsage.run(mu);
    for (const sk of extractSkills(parsed)) w.insertSkill.run(sk);

    if (parsed.session.project_path) {
      const name = basename(parsed.session.project_path) || parsed.session.project_path;
      w.insertRepo.run({ path: parsed.session.project_path, name });
    }
  });

  txn();
  stats.sessions++;
  stats.messages += parsed.messages.length;
  stats.toolCalls += parsed.toolCalls.length;
}
