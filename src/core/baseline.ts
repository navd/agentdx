// Per-repo session baselines — "is this session normal for this repo?".
// Powers `agentdx statusline`: a live meter comparing the current session to
// the repo's own historical median/p90. CLI-only (not synced to the web app).

import type Database from 'better-sqlite3';
import { estimateCostUsd } from './pricing.js';
import { TOKEN_SQL } from './finops.js';

export interface RepoBaseline {
  repo: string;
  sessions: number;
  medianTokens: number;
  p90Tokens: number;
  medianCostUsd: number;
  p90CostUsd: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/**
 * Baseline stats for one repo (matched on sessions.project_path). Returns null
 * when the repo has no recorded sessions.
 */
export function repoBaseline(db: Database.Database, repo: string): RepoBaseline | null {
  const tokRows = db.prepare(`SELECT ${TOKEN_SQL} AS tok FROM sessions WHERE project_path = ?`).all(repo) as { tok: number }[];
  // Baseline = a TYPICAL session, so drop empty (0-token) sessions — aborted or
  // uncaptured runs would otherwise drag the median to zero.
  const tokens = tokRows.map((r) => Number(r.tok) || 0).filter((t) => t > 0);
  if (!tokens.length) return null;

  // Per-session cost = sum of priced model slices for that session.
  const costRows = db.prepare(`
    SELECT mu.session_id AS sid, mu.model AS model,
      COALESCE(SUM(mu.input_tokens), 0) AS input,
      COALESCE(SUM(mu.output_tokens), 0) AS output,
      COALESCE(SUM(mu.cache_read), 0) AS cacheRead,
      COALESCE(SUM(mu.cache_write), 0) AS cacheWrite
    FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
    WHERE s.project_path = ?
    GROUP BY mu.session_id, mu.model`).all(repo) as { sid: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  const costBySession = new Map<string, number>();
  for (const r of costRows) {
    const c = estimateCostUsd(r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }) || 0;
    costBySession.set(r.sid, (costBySession.get(r.sid) || 0) + c);
  }
  const costs = [...costBySession.values()].filter((c) => c > 0);

  return {
    repo,
    sessions: tokens.length,
    medianTokens: median(tokens),
    p90Tokens: percentile(tokens, 90),
    medianCostUsd: median(costs),
    p90CostUsd: percentile(costs, 90),
  };
}
