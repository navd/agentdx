// GENERATED from src/core/models.ts by scripts/sync-shared.mjs — do not edit.
// Model/token aggregation — the "Models" lens of the Tokenomics page. Pure
// compute over the local SQLite db; period-aware so it shares the DataSource
// surface with FinOps. Cost reuses the shared pricing engine; token total is
// input + output + cache_read.

import type Database from 'better-sqlite3';
import { estimateCostUsd, getModelPricing } from './pricing';
import { getPeriodMs } from './finops';

export interface ModelRow {
  model: string; provider: string; sessions: number;
  input: number; output: number; cache_read: number; cache_write: number;
  total_tokens: number; cache_pct: number; messages: number;
  cost_usd: number | null; local: boolean;
}
export interface ProviderRow { name: string; mode: 'BYOK' | 'Local'; modelCount: number; totalTokens: number; estCost: number | null; }
export interface WeeklyPoint { week: string; model: string; tokens: number; }
export interface ModelsReport {
  period: string; since: number | null;
  totals: {
    input: number; output: number; cache_read: number; cache_write: number;
    messages: number; model_count: number; session_count: number;
    grandTotal: number; attributedTokens: number; cacheHitRate: number;
    estCostTotal: number; unpricedTokens: number; agentCount: number;
  };
  models: ModelRow[];
  providers: ProviderRow[];
  weekly: WeeklyPoint[];
  reliability: { total_tool_calls: number; failed_calls: number; avg_tool_latency: number | null };
}

function deriveProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('claude-')) return 'Anthropic';
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'OpenAI';
  if (m.startsWith('qwen') || m.startsWith('deepseek')) return 'Ollama';
  if (m.startsWith('gemini')) return 'Google';
  return 'Other';
}
const isLocalProvider = (p: string) => p === 'Ollama';

export function buildModelsReport(db: Database.Database, period = '30d'): ModelsReport {
  const since = getPeriodMs(period);
  const w = since != null ? 'AND s.started_at >= ?' : '';
  const args = since != null ? [since] : [];

  const totals = db.prepare(`
    SELECT COALESCE(SUM(mu.input_tokens),0) AS input, COALESCE(SUM(mu.output_tokens),0) AS output,
      COALESCE(SUM(mu.cache_read),0) AS cache_read, COALESCE(SUM(mu.cache_write),0) AS cache_write,
      COALESCE(SUM(mu.message_count),0) AS messages, COUNT(DISTINCT mu.model) AS model_count,
      COUNT(DISTINCT mu.session_id) AS session_count
    FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
    WHERE mu.model != '<synthetic>' ${w}`).get(...args) as any;

  const agentRow = db.prepare(`SELECT COUNT(DISTINCT agent) AS c FROM sessions s ${since != null ? 'WHERE s.started_at >= ?' : ''}`).get(...args) as any;
  const grand = db.prepare(`SELECT COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_read),0) AS t FROM sessions s ${since != null ? 'WHERE s.started_at >= ?' : ''}`).get(...args) as any;

  const rawModels = db.prepare(`
    SELECT mu.model AS model, COUNT(DISTINCT mu.session_id) AS sessions,
      COALESCE(SUM(mu.input_tokens),0) AS input, COALESCE(SUM(mu.output_tokens),0) AS output,
      COALESCE(SUM(mu.cache_read),0) AS cache_read, COALESCE(SUM(mu.cache_write),0) AS cache_write,
      COALESCE(SUM(mu.input_tokens + mu.output_tokens + mu.cache_read),0) AS total_tokens,
      CASE WHEN SUM(mu.input_tokens + mu.cache_read) > 0
        THEN MIN(ROUND(SUM(mu.cache_read) * 100.0 / SUM(mu.input_tokens + mu.cache_read), 1),
                 CASE WHEN SUM(mu.input_tokens) > 0 THEN 99.9 ELSE 100 END)
        ELSE 0 END AS cache_pct,
      COALESCE(SUM(mu.message_count),0) AS messages
    FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
    WHERE mu.model != '<synthetic>' ${w}
    GROUP BY mu.model ORDER BY total_tokens DESC`).all(...args) as any[];

  let estCostTotal = 0, unpricedTokens = 0;
  const providerMap = new Map<string, { models: Set<string>; totalTokens: number; cost: number; priced: boolean }>();
  const models: ModelRow[] = rawModels.map((m) => {
    const cost = estimateCostUsd(m.model, { input: m.input, output: m.output, cacheRead: m.cache_read, cacheWrite: m.cache_write });
    const provider = deriveProvider(m.model);
    const pricing = getModelPricing(m.model);
    if (cost == null) unpricedTokens += m.total_tokens; else estCostTotal += cost;
    const pe = providerMap.get(provider) || { models: new Set<string>(), totalTokens: 0, cost: 0, priced: false };
    pe.models.add(m.model); pe.totalTokens += m.total_tokens;
    if (cost != null) { pe.cost += cost; pe.priced = true; }
    providerMap.set(provider, pe);
    return { model: m.model, provider, sessions: m.sessions, input: m.input, output: m.output, cache_read: m.cache_read, cache_write: m.cache_write, total_tokens: m.total_tokens, cache_pct: m.cache_pct, messages: m.messages, cost_usd: cost, local: !!pricing?.local };
  });

  const providers: ProviderRow[] = [...providerMap.entries()].map(([name, d]) => ({
    name, mode: (isLocalProvider(name) ? 'Local' : 'BYOK') as 'Local' | 'BYOK', modelCount: d.models.size, totalTokens: d.totalTokens,
    estCost: d.priced || isLocalProvider(name) ? d.cost : null,
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  // Weekly token spans, spread proportionally across the weeks a session spanned.
  const spans = db.prepare(`
    SELECT s.started_at AS start, COALESCE(s.ended_at, s.started_at) AS finish, mu.model AS model,
      (mu.input_tokens + mu.output_tokens + mu.cache_read) AS tokens
    FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
    WHERE mu.model != '<synthetic>' AND (mu.input_tokens + mu.output_tokens + mu.cache_read) > 0 ${w}`).all(...args) as any[];
  const WEEK_MS = 7 * 86400000;
  const weekStartMs = (ms: number) => {
    const d = new Date(ms);
    const monday = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - monday * 86400000;
  };
  const weekAcc = new Map<string, Map<string, number>>();
  const addWeek = (wms: number, model: string, tok: number) => {
    const wk = new Date(wms).toISOString().slice(0, 10);
    if (!weekAcc.has(wk)) weekAcc.set(wk, new Map());
    const mm = weekAcc.get(wk)!;
    mm.set(model, (mm.get(model) || 0) + tok);
  };
  for (const r of spans) {
    const start = r.start as number;
    const finish = Math.max(r.finish as number, start);
    const totalMs = finish - start;
    if (totalMs <= 0) { addWeek(weekStartMs(start), r.model, r.tokens); continue; }
    const lastWeek = weekStartMs(finish);
    for (let wk = weekStartMs(start); wk <= lastWeek; wk += WEEK_MS) {
      const overlap = Math.min(finish, wk + WEEK_MS) - Math.max(start, wk);
      if (overlap > 0) addWeek(wk, r.model, (r.tokens * overlap) / totalMs);
    }
  }
  const weekly: WeeklyPoint[] = [...weekAcc.entries()]
    .flatMap(([week, mm]) => [...mm.entries()].map(([model, tokens]) => ({ week, model, tokens })))
    .sort((a, b) => a.week.localeCompare(b.week));

  const reliability = db.prepare(`
    SELECT COUNT(*) AS total_tool_calls, SUM(CASE WHEN tc.is_error = 1 THEN 1 ELSE 0 END) AS failed_calls,
      AVG(tc.duration_ms) AS avg_tool_latency
    FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id ${since != null ? 'WHERE s.started_at >= ?' : ''}`).get(...args) as any;

  const attributedTokens = (totals.input || 0) + (totals.output || 0) + (totals.cache_read || 0);
  const cacheHitRate = (totals.input + totals.cache_read) > 0
    ? Math.min((totals.cache_read / (totals.input + totals.cache_read)) * 100, totals.input > 0 ? 99.9 : 100)
    : 0;

  return {
    period, since,
    totals: {
      input: totals.input, output: totals.output, cache_read: totals.cache_read, cache_write: totals.cache_write,
      messages: totals.messages, model_count: totals.model_count, session_count: totals.session_count,
      grandTotal: grand.t || 0, attributedTokens, cacheHitRate, estCostTotal, unpricedTokens, agentCount: agentRow.c || 0,
    },
    models, providers, weekly,
    reliability: { total_tool_calls: reliability.total_tool_calls || 0, failed_calls: reliability.failed_calls || 0, avg_tool_latency: reliability.avg_tool_latency },
  };
}
