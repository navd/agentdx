import { getDb, fmtTok, fmtNum } from '@/lib/db';
import { CsvExport } from '@/components/csv-export';
import { RingChart } from '@/components/ring-chart';
import { AreaChart } from '@/components/area-chart';
import { Collapsible } from '@/components/collapsible';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface ModelRow {
  model: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cache_pct: number;
  messages: number;
}

function deriveProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('claude-')) return 'Anthropic';
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'OpenAI';
  if (m.startsWith('qwen') || m.startsWith('deepseek')) return 'Ollama';
  if (m.startsWith('gemini')) return 'Google';
  return 'Other';
}

function isLocalProvider(provider: string): boolean {
  return provider === 'Ollama';
}

const MODEL_COLORS: string[] = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)'];

function getModelsData() {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_read) as cache_read,
      SUM(cache_write) as cache_write,
      SUM(message_count) as messages,
      COUNT(DISTINCT model) as model_count,
      COUNT(DISTINCT session_id) as session_count
    FROM model_usage
    WHERE model != '<synthetic>'
  `).get() as any;

  const agentCount = db.prepare(`SELECT COUNT(DISTINCT agent) as c FROM sessions`).get() as any;

  // Grand total straight from the sessions table — the SAME number every other
  // page shows. model_usage only covers tokens attributable to a named model
  // (some sessions have tokens but no model_usage row), so summing it
  // undercounts the true total. Keep the headline consistent; surface the
  // attributed share separately.
  const grand = db.prepare(
    `SELECT COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_read), 0) AS t FROM sessions`,
  ).get() as any;

  const models = db.prepare(`
    SELECT
      model,
      COUNT(DISTINCT session_id) as sessions,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_read) as cache_read,
      SUM(cache_write) as cache_write,
      SUM(input_tokens + output_tokens + cache_read) as total_tokens,
      CASE WHEN SUM(input_tokens + cache_read) > 0
        -- Cap at 99.9% when ANY fresh input exists, so a 99.98% rate never
        -- rounds up to a misleading flat 100%. Only true 0-fresh-input hits 100.
        THEN MIN(ROUND(SUM(cache_read) * 100.0 / SUM(input_tokens + cache_read), 1),
                 CASE WHEN SUM(input_tokens) > 0 THEN 99.9 ELSE 100 END)
        ELSE 0
      END as cache_pct,
      SUM(message_count) as messages
    FROM model_usage
    WHERE model != '<synthetic>'
    GROUP BY model
    ORDER BY total_tokens DESC
  `).all() as ModelRow[];

  // Provider aggregation
  const perModel = db.prepare(`
    SELECT model, SUM(input_tokens + output_tokens + cache_read) as total
    FROM model_usage WHERE model != '<synthetic>' GROUP BY model
  `).all() as { model: string; total: number }[];

  const providerMap = new Map<string, { models: Set<string>; totalTokens: number }>();
  for (const row of perModel) {
    const prov = deriveProvider(row.model);
    const entry = providerMap.get(prov) || { models: new Set<string>(), totalTokens: 0 };
    entry.models.add(row.model);
    entry.totalTokens += row.total || 0;
    providerMap.set(prov, entry);
  }

  const providers: { name: string; mode: 'BYOK' | 'Local'; modelCount: number; totalTokens: number }[] = [];
  for (const [name, data] of providerMap) {
    providers.push({ name, mode: isLocalProvider(name) ? 'Local' : 'BYOK', modelCount: data.models.size, totalTokens: data.totalTokens });
  }
  providers.sort((a, b) => b.totalTokens - a.totalTokens);

  // Per-session per-model token spans. A session's tokens are spread across the
  // weeks it was actually active (below) instead of dumped into its start week —
  // otherwise one long-running session spikes a single week and leaves the rest
  // empty. model_usage already includes rolled-in sub-agent tokens.
  const tokenSpans = db.prepare(`
    SELECT s.started_at AS start, COALESCE(s.ended_at, s.started_at) AS finish,
      mu.model AS model, (mu.input_tokens + mu.output_tokens + mu.cache_read) AS tokens
    FROM model_usage mu
    JOIN sessions s ON s.id = mu.session_id
    WHERE mu.model != '<synthetic>' AND (mu.input_tokens + mu.output_tokens + mu.cache_read) > 0
  `).all() as any[];

  // Spread each span across its weeks proportional to the time spent in each.
  const WEEK_MS = 7 * 86400000;
  const weekStartMs = (ms: number) => {
    const d = new Date(ms);
    const monday = (d.getUTCDay() + 6) % 7; // days since Monday
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - monday * 86400000;
  };
  const weekAcc = new Map<string, Map<string, number>>();
  const addWeek = (wms: number, model: string, tok: number) => {
    const wk = new Date(wms).toISOString().slice(0, 10);
    if (!weekAcc.has(wk)) weekAcc.set(wk, new Map());
    const mm = weekAcc.get(wk)!;
    mm.set(model, (mm.get(model) || 0) + tok);
  };
  for (const r of tokenSpans) {
    const start = r.start as number;
    const finish = Math.max(r.finish as number, start);
    const totalMs = finish - start;
    const lastWeek = weekStartMs(finish);
    if (totalMs <= 0) { addWeek(weekStartMs(start), r.model, r.tokens); continue; }
    for (let w = weekStartMs(start); w <= lastWeek; w += WEEK_MS) {
      const overlap = Math.min(finish, w + WEEK_MS) - Math.max(start, w);
      if (overlap > 0) addWeek(w, r.model, (r.tokens * overlap) / totalMs);
    }
  }
  const weeklyTokens = [...weekAcc.entries()].flatMap(([week, mm]) =>
    [...mm.entries()].map(([model, tokens]) => ({ week, model, tokens }))
  ).sort((a, b) => a.week.localeCompare(b.week));

  const reliability = db.prepare(`
    SELECT COUNT(*) as total_tool_calls,
      SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as failed_calls,
      AVG(duration_ms) as avg_tool_latency
    FROM tool_calls
  `).get() as any;

  // NOTE: per-model latency/fail-rate was removed — tool_calls has no model
  // column, so joining via session pooled multi-model sessions and credited
  // every model with the same (fabricated) tool stats.

  return { totals, grandTotal: grand.t || 0, agentCount, models, providers, weeklyTokens, reliability };
}

export default function ModelsPage() {
  const { totals, grandTotal, agentCount, models, providers, weeklyTokens, reliability } = getModelsData();

  if (models.length === 0) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Models &amp; Tokens</h1>
            <p className="page-sub">No model usage data</p>
          </div>
        </div>
        <EmptyState
          icon="brain-circuit"
          title="No models found"
          description="No model usage has been recorded yet. Run `agentdx collect` to ingest your coding-agent history."
          action={{ label: 'Collector status', href: '/collector' }}
        />
      </div>
    );
  }

  const inputTokens = totals.input_tokens || 0;
  const outputTokens = totals.output_tokens || 0;
  const cacheRead = totals.cache_read || 0;
  const totalTokens = inputTokens + outputTokens + cacheRead;
  const cacheHitRate = (inputTokens + cacheRead) > 0
    // Cap at 99.9% when any fresh input exists (see per-model cache_pct).
    ? Math.min((cacheRead / (inputTokens + cacheRead)) * 100, inputTokens > 0 ? 99.9 : 100).toFixed(1)
    : '0.0';

  // Ring chart segments
  const ringSegments = models.slice(0, 8).map((m, i) => ({
    key: m.model,
    value: m.total_tokens,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
    label: m.model.replace('claude-', '').replace('-20250514', ''),
    href: `/sessions?model=${encodeURIComponent(m.model)}`,
  }));

  // Area chart data (weekly). Fill every week between first and last so an
  // empty week shows as zero instead of collapsing the axis into a false gap.
  const presentWeeks = [...new Set(weeklyTokens.map((r: any) => r.week as string))].sort();
  const allWeeks: string[] = [];
  if (presentWeeks.length > 0) {
    const DAY = 86400000;
    let cur = new Date(presentWeeks[0] + 'T00:00:00Z').getTime();
    const end = new Date(presentWeeks[presentWeeks.length - 1] + 'T00:00:00Z').getTime();
    while (cur <= end && allWeeks.length < 52) {
      allWeeks.push(new Date(cur).toISOString().slice(0, 10));
      cur += 7 * DAY;
    }
  }
  const topModels = models.slice(0, 5).map(m => m.model);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekLabels = allWeeks.map(w => {
    const d = new Date(w + 'T00:00:00Z');
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  });

  const areaSeries = topModels.map((model, i) => {
    const data = allWeeks.map(week => {
      const row = weeklyTokens.find((r: any) => r.week === week && r.model === model);
      return row ? row.tokens : 0;
    });
    return { key: model.replace('claude-', '').replace('-20250514', ''), color: MODEL_COLORS[i % MODEL_COLORS.length], data };
  });

  // Token composition
  const inputPct = totalTokens > 0 ? (inputTokens / totalTokens) * 100 : 0;
  const outputPct = totalTokens > 0 ? (outputTokens / totalTokens) * 100 : 0;
  const cachePct = totalTokens > 0 ? (cacheRead / totalTokens) * 100 : 0;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Models &amp; Tokens</h1>
          <p className="page-sub">Usage visibility across {agentCount.c} agents &middot; {providers.length} providers</p>
        </div>
        <div className="page-head-actions">
          <CsvExport data={models.map(m => ({ model: m.model, input_tokens: m.input_tokens, output_tokens: m.output_tokens, cache_read: m.cache_read, messages: m.messages }))} filename="models-usage.csv" />
        </div>
      </div>

      {/* Visual row: Ring chart + KPI tiles */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '240px 1fr' }}>
        <ErrorBoundary fallbackTitle="Ring chart failed to render">
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <RingChart
            segments={ringSegments}
            size={200}
            strokeWidth={28}
            centerValue={fmtTok(totalTokens)}
            centerLabel={`${models.length} models`}
          />
        </div>
        </ErrorBoundary>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div className="card stat" style={{ padding: '14px 16px' }}>
            <div className="stat-label">Total tokens</div>
            <div className="stat-value" style={{ fontSize: 24 }}>{fmtTok(grandTotal)}</div>
            <div className="stat-foot">{grandTotal > totalTokens ? `${((totalTokens / grandTotal) * 100).toFixed(1)}% attributed to a model` : 'input + output + cache'}</div>
          </div>
          <div className="card stat" style={{ padding: '14px 16px' }}>
            <div className="stat-label">Cache hit rate</div>
            <div className="stat-value" style={{ fontSize: 24 }}>{cacheHitRate}%</div>
            <div className="stat-foot">{fmtTok(cacheRead)} cached</div>
          </div>
          <div className="card stat" style={{ padding: '14px 16px' }}>
            <div className="stat-label">Messages</div>
            <div className="stat-value" style={{ fontSize: 24 }}>{fmtNum(totals.messages || 0)}</div>
            <div className="stat-foot">{fmtNum(totals.session_count || 0)} sessions</div>
          </div>
          <div className="card stat" style={{ padding: '14px 16px' }}>
            <div className="stat-label">Tool calls</div>
            <div className="stat-value" style={{ fontSize: 24 }}>{fmtNum(reliability.total_tool_calls || 0)}</div>
            <div className="stat-foot">{reliability.failed_calls || 0} failed</div>
          </div>
          <div className="card stat" style={{ padding: '14px 16px' }}>
            <div className="stat-label">Providers</div>
            <div className="stat-value" style={{ fontSize: 24 }}>{providers.length}</div>
            <div className="stat-foot">{providers.map(p => p.name).join(', ')}</div>
          </div>
          <div className="card stat" style={{ padding: '14px 16px' }}>
            <div className="stat-label">Avg tool latency</div>
            <div className="stat-value" style={{ fontSize: 24 }}>{reliability.avg_tool_latency ? `${Math.round(reliability.avg_tool_latency)}ms` : '—'}</div>
            <div className="stat-foot">Claude Code &amp; Codex · others log no timing</div>
          </div>
        </div>
      </div>

      {/* Token usage over time (area chart) */}
      {areaSeries.length > 0 && allWeeks.length > 1 && (
        <ErrorBoundary fallbackTitle="Token usage chart failed to render">
        <div className="card mb-20">
          <div className="card-head">
            <div>
              <h3 className="card-title">Token usage over time</h3>
              <p className="card-sub">weekly tokens by model · click week to drill down</p>
            </div>
          </div>
          <div className="card-pad">
            <AreaChart
              series={areaSeries}
              labels={weekLabels}
              height={200}
              stacked={true}
              hrefTemplate="/sessions?month={label}"
            />
          </div>
        </div>
        </ErrorBoundary>
      )}

      {/* Token composition bar */}
      <ErrorBoundary fallbackTitle="Token composition chart failed to render">
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Token composition</h3>
            <p className="card-sub">input vs output vs cache</p>
          </div>
        </div>
        <div className="card-pad">
          {/* Three explicit colors — the old CSS classes made cache blend into the
              dark track and input/output share a green, so it read as one bar. */}
          <div style={{ display: 'flex', height: 18, borderRadius: 6, overflow: 'hidden', background: 'var(--surface-3)' }}>
            {inputPct > 0 && <div style={{ width: `${inputPct}%`, background: '#22C55E' }} title={`Input ${inputPct.toFixed(1)}%`} />}
            {outputPct > 0 && <div style={{ width: `${Math.max(outputPct, 0.6)}%`, background: '#F59E0B' }} title={`Output ${outputPct.toFixed(1)}%`} />}
            {cachePct > 0 && <div style={{ width: `${cachePct}%`, background: '#6366F1' }} title={`Cache ${cachePct.toFixed(1)}%`} />}
          </div>
          <div className="tok-legend" style={{ marginTop: 10 }}>
            <div className="item"><span style={{ width: 10, height: 10, borderRadius: 2, background: '#22C55E', display: 'inline-block' }} /><span className="v">Input · {fmtTok(inputTokens)} ({inputPct.toFixed(1)}%)</span></div>
            <div className="item"><span style={{ width: 10, height: 10, borderRadius: 2, background: '#F59E0B', display: 'inline-block' }} /><span className="v">Output · {fmtTok(outputTokens)} ({outputPct.toFixed(1)}%)</span></div>
            <div className="item"><span style={{ width: 10, height: 10, borderRadius: 2, background: '#6366F1', display: 'inline-block' }} /><span className="v">Cache · {fmtTok(cacheRead)} ({cachePct.toFixed(1)}%)</span></div>
          </div>
        </div>
      </div>
      </ErrorBoundary>

      {/* Provider cards */}
      {providers.length > 0 && (
        <div className="grid g-4 mb-20" style={{ gridTemplateColumns: `repeat(${Math.min(providers.length, 4)}, 1fr)` }}>
          {providers.map(p => (
            <div className="card" key={p.name} style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <strong style={{ fontSize: 15 }}>{p.name}</strong>
                <span style={{
                  display: 'inline-block', padding: '2px 7px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                  letterSpacing: '.05em', textTransform: 'uppercase',
                  background: p.mode === 'Local' ? 'var(--accent-soft)' : 'var(--surface-3)',
                  color: p.mode === 'Local' ? 'var(--accent)' : 'var(--text-muted)',
                }}>{p.mode}</span>
              </div>
              <span className="st st-merged"><span className="dot"></span>Connected</span>
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 16 }}>
                <span>{p.modelCount} model{p.modelCount !== 1 ? 's' : ''}</span>
                <span>{fmtTok(p.totalTokens)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Models detail table (collapsible) */}
      <div className="card">
        <Collapsible title="Model details" count={models.length}>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th className="num">Sessions</th>
                  <th className="num">Input</th>
                  <th className="num">Output</th>
                  <th className="num">Cache</th>
                  <th className="num">Total</th>
                  <th className="num">Cache %</th>
                </tr>
              </thead>
              <tbody>
                {models.map(m => {
                  return (
                    <tr key={m.model} className="clickable">
                      <td>
                        <Link href={`/sessions?model=${encodeURIComponent(m.model)}`}>
                          <span className="tag-model">{m.model}</span>
                        </Link>
                      </td>
                      <td><span className="f12 muted">{deriveProvider(m.model)}</span></td>
                      <td className="num">{fmtNum(m.sessions)}</td>
                      <td className="num">{fmtTok(m.input_tokens)}</td>
                      <td className="num">{fmtTok(m.output_tokens)}</td>
                      <td className="num">{fmtTok(m.cache_read)}</td>
                      <td className="num fw6">{fmtTok(m.total_tokens)}</td>
                      <td className="num"><span className="mono f12">{m.cache_pct}%</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Collapsible>
      </div>
    </div>
  );
}
