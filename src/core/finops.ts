// FinOps cost aggregation — "what did each repo / model / agent / day cost in
// AI tokens, across ALL agents". Pure compute over the local SQLite db; reused
// by the `agentdx finops` CLI and the `/finops` dashboard page so both agree.
//
// Cost is priced PER MODEL (pricing keys off the model name), so every
// dimension (repo/agent/day) is computed by grouping model_usage by
// (dimension, model), pricing each model slice, then folding up to the
// dimension. Token total convention matches the rest of the app:
// input + output + cache_read.

import type Database from 'better-sqlite3';
import { estimateCostUsd, getModelPricing } from './pricing.js';

/** Token total used everywhere in the app (disjoint/additive). */
export const TOKEN_SQL = '(total_input_tokens + total_output_tokens + total_cache_read)';

export interface FinopsRow {
  key: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  sessions: number;
  /** Sum of priced model slices. null contributions are excluded but flagged. */
  costUsd: number;
  /** At least one model in this group had no price (cost is a floor, not exact). */
  hasUnpriced: boolean;
  /** Every model in this group is a local/$0 model. */
  local: boolean;
}

export interface DailyPoint {
  day: string;
  costUsd: number;
  tokens: number;
}

export interface FinopsReport {
  period: string;
  since: number | null;
  generatedAt: number;
  totals: {
    costUsd: number;
    tokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    sessions: number;
    repos: number;
    models: number;
    hasUnpriced: boolean;
  };
  byModel: FinopsRow[];
  byRepo: FinopsRow[];
  byAgent: FinopsRow[];
  daily: DailyPoint[];
}

export type GroupBy = 'model' | 'repo' | 'agent' | 'day';

/** Period → epoch-ms lower bound on sessions.started_at (null = all time). */
export function getPeriodMs(period: string): number | null {
  if (period === '30d') return Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (period === '90d') return Date.now() - 90 * 24 * 60 * 60 * 1000;
  if (period === 'qtd') {
    const now = new Date();
    const qMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    return Date.UTC(now.getUTCFullYear(), qMonth, 1);
  }
  if (period === 'ytd') return Date.UTC(new Date().getUTCFullYear(), 0, 1);
  // month=YYYY-MM → that calendar month in UTC
  const m = /^month=(\d{4})-(\d{2})$/.exec(period);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  return null; // 'all' or unknown → no lower bound
}

interface RawSlice {
  k: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  sessions: number;
}

// SQL expression that produces the group key for each dimension.
const GROUP_EXPR: Record<Exclude<GroupBy, 'day'>, string> = {
  model: 'mu.model',
  repo: "COALESCE(NULLIF(s.project_path, ''), '(unknown)')",
  agent: 's.agent',
};

function sliceQuery(keyExpr: string, since: number | null): string {
  const where = since != null ? 'WHERE s.started_at >= ?' : '';
  return `
    SELECT ${keyExpr} AS k, mu.model AS model,
      COALESCE(SUM(mu.input_tokens), 0) AS input,
      COALESCE(SUM(mu.output_tokens), 0) AS output,
      COALESCE(SUM(mu.cache_read), 0) AS cacheRead,
      COALESCE(SUM(mu.cache_write), 0) AS cacheWrite,
      COUNT(DISTINCT mu.session_id) AS sessions
    FROM model_usage mu
    JOIN sessions s ON s.id = mu.session_id
    ${where}
    GROUP BY k, mu.model`;
}

/** Fold per-(key,model) slices into priced, per-key rows. */
function foldSlices(rows: RawSlice[]): Map<string, FinopsRow> {
  const map = new Map<string, FinopsRow>();
  for (const r of rows) {
    let row = map.get(r.k);
    if (!row) {
      row = {
        key: r.k, label: r.k, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        tokens: 0, sessions: 0, costUsd: 0, hasUnpriced: false, local: true,
      };
      map.set(r.k, row);
    }
    row.input += r.input;
    row.output += r.output;
    row.cacheRead += r.cacheRead;
    row.cacheWrite += r.cacheWrite;
    const cost = estimateCostUsd(r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
    const pricing = getModelPricing(r.model);
    if (cost == null) row.hasUnpriced = true;
    else row.costUsd += cost;
    if (!pricing?.local) row.local = false;
  }
  for (const row of map.values()) row.tokens = row.input + row.output + row.cacheRead;
  return map;
}

// Per-group session counts (a session that touches N models is one session, not
// N — so distinct-count from the sessions table, never a sum of slice counts).
function sessionCounts(db: Database.Database, keyExpr: string, since: number | null): Map<string, number> {
  const where = since != null ? 'WHERE s.started_at >= ?' : '';
  const sql = `SELECT ${keyExpr} AS k, COUNT(*) AS c FROM sessions s ${where} GROUP BY k`;
  const stmt = db.prepare(sql);
  const rows = (since != null ? stmt.all(since) : stmt.all()) as { k: string; c: number }[];
  return new Map(rows.map((r) => [String(r.k), r.c]));
}

function dimension(db: Database.Database, dim: Exclude<GroupBy, 'day'>, since: number | null): FinopsRow[] {
  const keyExpr = GROUP_EXPR[dim];
  const stmt = db.prepare(sliceQuery(keyExpr, since));
  const slices = (since != null ? stmt.all(since) : stmt.all()) as RawSlice[];
  const folded = foldSlices(slices);
  // model dimension's session count = distinct sessions per model (from slices)
  if (dim !== 'model') {
    const counts = sessionCounts(db, GROUP_EXPR[dim], since);
    for (const row of folded.values()) row.sessions = counts.get(row.key) ?? 0;
  } else {
    // sum of distinct-per-model counts (each row is a single model → exact)
    const bySess = new Map<string, number>();
    for (const sl of slices) bySess.set(sl.k, (bySess.get(sl.k) ?? 0) + sl.sessions);
    for (const row of folded.values()) row.sessions = bySess.get(row.key) ?? 0;
  }
  return [...folded.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

function dailySeries(db: Database.Database, since: number | null): DailyPoint[] {
  const where = since != null ? 'WHERE s.started_at >= ?' : '';
  const sql = `
    SELECT DATE(s.started_at / 1000, 'unixepoch') AS day, mu.model AS model,
      COALESCE(SUM(mu.input_tokens), 0) AS input,
      COALESCE(SUM(mu.output_tokens), 0) AS output,
      COALESCE(SUM(mu.cache_read), 0) AS cacheRead,
      COALESCE(SUM(mu.cache_write), 0) AS cacheWrite
    FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
    ${where}
    GROUP BY day, mu.model
    ORDER BY day ASC`;
  const stmt = db.prepare(sql);
  const rows = (since != null ? stmt.all(since) : stmt.all()) as (RawSlice & { day: string })[];
  const map = new Map<string, DailyPoint>();
  for (const r of rows) {
    let pt = map.get(r.day);
    if (!pt) { pt = { day: r.day, costUsd: 0, tokens: 0 }; map.set(r.day, pt); }
    const cost = estimateCostUsd(r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
    if (cost != null) pt.costUsd += cost;
    pt.tokens += r.input + r.output + r.cacheRead;
  }
  return [...map.values()];
}

/** Build the full FinOps report for a period. */
export function buildFinopsReport(db: Database.Database, period = '30d'): FinopsReport {
  const since = getPeriodMs(period);
  const byModel = dimension(db, 'model', since);
  const byRepo = dimension(db, 'repo', since);
  const byAgent = dimension(db, 'agent', since);
  const daily = dailySeries(db, since);

  const totals = byModel.reduce(
    (t, r) => {
      t.costUsd += r.costUsd; t.input += r.input; t.output += r.output;
      t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite;
      if (r.hasUnpriced) t.hasUnpriced = true;
      return t;
    },
    { costUsd: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, repos: byRepo.length, models: byModel.length, hasUnpriced: false },
  );
  totals.tokens = totals.input + totals.output + totals.cacheRead;
  const whereSess = since != null ? 'WHERE started_at >= ?' : '';
  const sc = db.prepare(`SELECT COUNT(*) AS c FROM sessions ${whereSess}`);
  totals.sessions = ((since != null ? sc.get(since) : sc.get()) as { c: number }).c;

  return { period, since, generatedAt: Date.now(), totals, byModel, byRepo, byAgent, daily };
}
