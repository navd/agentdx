import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb } from '../core/db.js';
import { resolveConfig, checkSources } from '../core/config.js';
import { collectClaude } from './claude.js';
import { collectCowork, coworkBaseDir } from './cowork.js';
import { collectCodex, backfillCodexTokens } from './codex.js';
import { collectCursor } from './cursor.js';
import { collectAntigravity } from './antigravity.js';
import { collectVSCode } from './vscode.js';
import { collectContinue } from './continue.js';
import { backfillSkills, healStaleSessions, recomputeRepositories, recomputeSessionToolCounts } from './shared.js';
import { backfillFileEvents } from './file-events.js';
import { collectGit } from './git.js';

interface CollectorResult {
  source: string;
  sessions: number;
  messages: number;
  toolCalls: number;
  errors: string[];
  totalSessions?: number;
  totalMessages?: number;
  totalToolCalls?: number;
}

/** Timeout in milliseconds for a single collector (5 minutes). */
const COLLECTOR_TIMEOUT_MS = 300000;

export interface CollectHooks {
  onAgentStart?: (agent: string) => void;
  onAgentProgress?: (agent: string, done: number, total: number) => void;
  onAgentDone?: (agent: string, stats: { sessions: number; messages: number; toolCalls: number }) => void;
}

async function runAgent(
  name: string,
  collectFn: (onProgress: (done: number, total: number) => void) => Promise<{ sessions: number; messages: number; toolCalls: number; errors: string[] }>,
  runInsert: any,
  runUpdate: any,
  results: CollectorResult[],
  hooks?: CollectHooks,
) {
  const runInfo = runInsert.run({ started_at: Date.now(), source: name });
  const runId = runInfo.lastInsertRowid;
  hooks?.onAgentStart?.(name);
  const onProgress = (done: number, total: number) => hooks?.onAgentProgress?.(name, done, total);
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Collector '${name}' timed out after ${COLLECTOR_TIMEOUT_MS / 1000}s`)), COLLECTOR_TIMEOUT_MS);
    });
    const stats = await Promise.race([collectFn(onProgress), timeoutPromise]);
    runUpdate.run({
      id: runId,
      completed_at: Date.now(),
      sessions_added: stats.sessions,
      messages_added: stats.messages,
      tool_calls_added: stats.toolCalls,
      errors: stats.errors.length ? JSON.stringify(stats.errors) : null,
      status: stats.errors.length > 0 ? 'completed_with_errors' : 'completed',
    });
    results.push({ source: name, ...stats });
    hooks?.onAgentDone?.(name, { sessions: stats.sessions, messages: stats.messages, toolCalls: stats.toolCalls });
  } catch (err: any) {
    runUpdate.run({
      id: runId,
      completed_at: Date.now(),
      sessions_added: 0,
      messages_added: 0,
      tool_calls_added: 0,
      errors: JSON.stringify([err.message || String(err)]),
      status: 'failed',
    });
    results.push({ source: name, sessions: 0, messages: 0, toolCalls: 0, errors: [err.message || String(err)] });
    hooks?.onAgentDone?.(name, { sessions: 0, messages: 0, toolCalls: 0 });
  }
}

export async function runCollection(overrides: { claudeDir?: string; codexDir?: string; dbPath?: string } = {}, hooks?: CollectHooks) {
  const config = resolveConfig(overrides);
  const sources = checkSources(config);
  const db = getDb(config.dbPath);
  const home = homedir();

  const runInsert = db.prepare(`
    INSERT INTO collection_runs (started_at, source, status)
    VALUES (@started_at, @source, 'running')
  `);
  const runUpdate = db.prepare(`
    UPDATE collection_runs SET completed_at = @completed_at, sessions_added = @sessions_added,
      messages_added = @messages_added, tool_calls_added = @tool_calls_added,
      errors = @errors, status = @status
    WHERE id = @id
  `);

  const results: CollectorResult[] = [];

  // One-time heal: de-include cache from Codex token totals stored by older
  // builds (cache-inclusive input → double-counted under input+output+cache).
  // Runs BEFORE collection so on a fresh DB it touches zero codex rows and just
  // sets its guard; on an existing DB it heals the old rows before new
  // (already-correct) ones are added. No-op after the first run.
  try {
    backfillCodexTokens(db);
  } catch {
    // token heal is best-effort
  }

  // Claude Code
  if (sources.claude) {
    await runAgent('claude-code', (op) => collectClaude(db, config.claudeDir, op), runInsert, runUpdate, results, hooks);
  }

  // Cowork (Claude desktop app, local agent mode)
  const coworkBase = coworkBaseDir();
  if (coworkBase) {
    await runAgent('cowork', (op) => collectCowork(db, coworkBase, op), runInsert, runUpdate, results, hooks);
  }

  // Codex
  if (sources.codex) {
    await runAgent('codex', (op) => collectCodex(db, config.codexDir, op), runInsert, runUpdate, results, hooks);
  }

  // Cursor
  const cursorDir = join(home, '.cursor');
  if (existsSync(join(cursorDir, 'projects'))) {
    await runAgent('cursor', (op) => collectCursor(db, cursorDir, op), runInsert, runUpdate, results, hooks);
  }

  // Antigravity
  await runAgent('antigravity', (op) => collectAntigravity(db, op), runInsert, runUpdate, results, hooks);

  // VS Code (Copilot Chat)
  await runAgent('vscode', (op) => collectVSCode(db, op), runInsert, runUpdate, results, hooks);

  // Continue.dev
  await runAgent('continue', (op) => collectContinue(db, op), runInsert, runUpdate, results, hooks);

  // One-time backfill: derive skill invocations from already-stored data
  // (collection skips existing sessions, so new extraction logic needs this
  // to populate historical rows). No-op once the table is populated.
  try {
    backfillSkills(db);
  } catch {
    // skill backfill is best-effort
  }

  // Incremental backfill: derive file_events from tool_calls not yet processed.
  // Cheap on every collect (only scans unprocessed tool calls) and picks up
  // newly collected sessions as well as historical ones.
  try {
    backfillFileEvents(db);
  } catch {
    // file-event backfill is best-effort
  }

  // One-time heal for sessions frozen low by the old insert (see
  // healStaleSessions). Runs after collection so model_usage is current.
  try {
    healStaleSessions(db);
  } catch {
    // session heal is best-effort
  }

  // Keep sessions.tool_call_count exactly equal to the tool_calls row count so
  // SUM(column) and COUNT(rows) agree across every page. Idempotent; every collect.
  try {
    recomputeSessionToolCounts(db);
  } catch {
    // tool-count rollup is best-effort
  }

  // Rebuild repository aggregates as an exact rollup of the (now-final)
  // sessions table. Idempotent; every collect.
  try {
    recomputeRepositories(db);
  } catch {
    // repo rollup is best-effort
  }

  // Git ground truth for the Authorship & Oversight view. Runs after
  // file_events are backfilled (commit↔session overlap depends on them).
  // Incremental per repo (keyed off HEAD sha); best-effort.
  try {
    collectGit(db);
  } catch {
    // git collection is best-effort — never block a collect over it
  }

  // Attach per-agent DB totals so the CLI summary reflects everything captured,
  // not just what this (incremental) run added. Otherwise an already-collected
  // agent shows "no sessions" even though its data is in the database.
  const totalSessions = new Map<string, number>();
  const totalMessages = new Map<string, number>();
  const totalToolCalls = new Map<string, number>();
  for (const r of db.prepare('SELECT agent AS a, COUNT(*) AS c FROM sessions GROUP BY agent').all() as any[]) totalSessions.set(r.a, r.c);
  for (const r of db.prepare('SELECT s.agent AS a, COUNT(*) AS c FROM messages m JOIN sessions s ON s.id = m.session_id GROUP BY s.agent').all() as any[]) totalMessages.set(r.a, r.c);
  for (const r of db.prepare('SELECT s.agent AS a, COUNT(*) AS c FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id GROUP BY s.agent').all() as any[]) totalToolCalls.set(r.a, r.c);
  for (const r of results as any[]) {
    r.totalSessions = totalSessions.get(r.source) || 0;
    r.totalMessages = totalMessages.get(r.source) || 0;
    r.totalToolCalls = totalToolCalls.get(r.source) || 0;
  }

  // AgentDX is 100% local — no telemetry, no network calls of any kind.
  return { config, results };
}
