import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

let _db: Database.Database | null = null;

function getDbPath(): string {
  // Canonical location — same path the CLI writes to. AGENTDX_DB (set by the
  // CLI when it launches the dashboard) always wins.
  return process.env.AGENTDX_DB || join(homedir(), '.agentdx', 'agentdx.db');
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const path = getDbPath();
  // Ensure the parent dir exists so a read-only open never fails with
  // "directory does not exist" (the file itself is created by `collect`).
  try { mkdirSync(join(path, '..'), { recursive: true }); } catch {}
  _db = new Database(path, { readonly: true });
  _db.pragma('journal_mode = WAL');
  return _db;
}

// Re-exported from the client-safe module so existing `@/lib/db` imports keep
// working, while client components can import them from '@/lib/format' without
// pulling in better-sqlite3.
export { fmtTok, fmtNum, fmtDuration, timeAgo } from './format';

/**
 * Agents that actually emit a tool-error signal.
 *
 * Only Claude Code records per-tool-call errors; the Codex/Cursor/Antigravity
 * collectors store is_error=0 for every call. So a 0%
 * error rate for those agents means "no signal", NOT "flawless". Derive the
 * set from data: an agent has signal if it has at least one is_error=1 row.
 * Use this to render "no signal" instead of a misleading "0% / clean".
 */
export function getErrorSignalAgents(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT s.agent AS agent
    FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
    WHERE tc.is_error = 1
  `).all() as { agent: string }[];
  return new Set(rows.map((r) => r.agent));
}

export function getPeriodMs(period: string): number | null {
  if (period === '30d') return Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (period === '90d') return Date.now() - 90 * 24 * 60 * 60 * 1000;
  // Compare against started_at, which is a UTC epoch, so build the quarter/year
  // boundary in UTC too. Local-midnight boundaries shifted the cutoff by the UTC
  // offset and inconsistently across periods (QTD in summer vs YTD in winter).
  if (period === 'qtd') {
    const now = new Date();
    const qMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    return Date.UTC(now.getUTCFullYear(), qMonth, 1);
  }
  if (period === 'ytd') {
    return Date.UTC(new Date().getUTCFullYear(), 0, 1);
  }
  return null;
}
