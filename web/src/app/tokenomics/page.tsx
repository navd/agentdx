import { fmtTok, fmtNum } from '@/lib/db';
import { fmtUsd, getModelPricing } from '@/lib/pricing';
import { type FinopsRow } from '@/lib/finops';
import { type ModelRow, type ModelsReport } from '@/lib/models';
import { getDataSource } from '@/lib/datasource';
import { RingChart } from '@/components/ring-chart';
import { AreaChart } from '@/components/area-chart';
import { Treemap } from '@/components/treemap';
import { Collapsible } from '@/components/collapsible';
import { CsvExport } from '@/components/csv-export';
import { ErrorBoundary } from '@/components/error-boundary';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const PALETTE = ['#15803D', '#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#0891B2', '#CA8A04', '#DC2626', '#059669', '#4F46E5', '#9333EA', '#0D9488'];
const PERIODS = [
  { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
  { key: 'qtd', label: 'QTD' }, { key: 'ytd', label: 'YTD' }, { key: 'all', label: 'All' },
];
const TABS = [
  { key: 'cost', label: 'Cost' },
  { key: 'models', label: 'Models' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortRepo(p: string): string {
  if (!p || p === '(unknown)') return '(unknown)';
  return p.split('/').filter(Boolean).slice(-2).join('/');
}
const shortModel = (m: string) => m.replace('claude-', '').replace(/-2025\d{4}$/, '');

export default async function TokenomicsPage({ searchParams }: { searchParams: Promise<{ period?: string; tab?: string }> }) {
  const sp = await searchParams;
  const period = PERIODS.some((p) => p.key === sp.period) ? sp.period! : '30d';
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : 'cost';
  const href = (t: string, p: string) => `/tokenomics?tab=${t}&period=${p}`;

  // Models report carries the shared KPI numbers (tokens, cache, sessions, spend).
  const m = await getDataSource().models(period);
  const t = m.totals;
  const empty = t.attributedTokens === 0 && t.grandTotal === 0;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Tokenomics</h1>
          <p className="page-sub">Tokens &amp; cost across {t.agentCount} agents &middot; {t.model_count} models &middot; {m.providers.length} providers</p>
        </div>
        <div className="page-head-actions" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {PERIODS.map((p) => (
              <Link key={p.key} href={href(tab, p.key)} className="chip" style={chip(p.key === period)}>{p.label}</Link>
            ))}
          </div>
        </div>
      </div>

      {empty ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          No token usage in this period. Try a wider window, or run <code>agentdx collect</code>.
        </div>
      ) : (
        <>
          {/* Shared KPI strip — the canonical numbers, identical across tabs */}
          <div className="grid mb-20" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Kpi label="Estimated spend" value={fmtUsd(t.estCostTotal)} foot={t.unpricedTokens > 0 ? `floor · ${fmtTok(t.unpricedTokens)} unpriced` : 'at API list prices'} />
            <Kpi label="Total tokens" value={fmtTok(t.grandTotal)} foot={t.grandTotal > t.attributedTokens ? `${((t.attributedTokens / t.grandTotal) * 100).toFixed(0)}% model-attributed` : 'input + output + cache'} />
            <Kpi label="Cache hit rate" value={`${t.cacheHitRate.toFixed(1)}%`} foot={`${fmtTok(t.cache_read)} cached`} />
            <Kpi label="Sessions" value={fmtNum(t.session_count)} foot={`${fmtNum(t.messages)} messages`} />
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-faint)', marginBottom: 16 }}>
            {TABS.map((x) => (
              <Link key={x.key} href={href(x.key, period)} style={tabStyle(x.key === tab)}>{x.label}</Link>
            ))}
          </div>

          {tab === 'cost' ? <CostTab period={period} /> : <ModelsTab report={m} />}
        </>
      )}
    </div>
  );
}

/* ---------- Cost lens: where the money went (repo / agent / time) ---------- */
async function CostTab({ period }: { period: string }) {
  const f = await getDataSource().finops(period);

  const repoCells = f.byRepo.filter((r) => r.costUsd > 0).slice(0, 24).map((r, i) => ({
    key: r.key, value: r.costUsd, label: shortRepo(r.label), subLabel: fmtUsd(r.costUsd),
    color: PALETTE[i % PALETTE.length], href: `/sessions?project=${encodeURIComponent(r.label)}`,
  }));
  const modelCostRing = f.byModel.filter((r) => r.costUsd > 0).slice(0, 10).map((r, i) => ({
    key: r.key, value: r.costUsd, color: PALETTE[i % PALETTE.length],
    label: shortModel(r.label), href: `/sessions?model=${encodeURIComponent(r.label)}`,
  }));
  const dayLabels = f.daily.map((d) => d.day.slice(5));
  const costSeries = [{ key: 'cost', color: '#15803D', data: f.daily.map((d) => Number(d.costUsd.toFixed(2))) }];
  const csv = [
    ...f.byRepo.map((r) => ({ dimension: 'repo', ...flatFin(r) })),
    ...f.byModel.map((r) => ({ dimension: 'model', ...flatFin(r) })),
    ...f.byAgent.map((r) => ({ dimension: 'agent', ...flatFin(r) })),
  ];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}><CsvExport data={csv} filename={`tokenomics-cost-${period}.csv`} /></div>
      <div className="grid mb-20" style={{ gridTemplateColumns: '1fr 280px', gap: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="card-title" style={{ marginBottom: 12 }}>Spend by repository</div>
          <ErrorBoundary fallbackTitle="Treemap failed to render">
            {repoCells.length ? <Treemap items={repoCells} /> : <Muted>No priced repo spend in this period.</Muted>}
          </ErrorBoundary>
        </div>
        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          <div className="card-title" style={{ marginBottom: 12 }}>Cost by model</div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ErrorBoundary fallbackTitle="Ring failed to render">
              {modelCostRing.length ? <RingChart segments={modelCostRing} size={190} strokeWidth={26} centerValue={fmtUsd(f.totals.costUsd)} centerLabel="spend" /> : <Muted>No priced model spend.</Muted>}
            </ErrorBoundary>
          </div>
        </div>
      </div>

      {f.daily.length > 1 && (
        <div className="card mb-20" style={{ padding: 16 }}>
          <div className="card-title" style={{ marginBottom: 12 }}>Daily spend ($)</div>
          <ErrorBoundary fallbackTitle="Trend failed to render">
            <AreaChart series={costSeries} labels={dayLabels} stacked={false} xLabel="day" />
          </ErrorBoundary>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <FinTable title="By repository" rows={f.byRepo} hrefBase="project" labelFn={shortRepo} />
        <FinTable title="By agent" rows={f.byAgent} hrefBase="agent" />
      </div>
      <p className="page-sub" style={{ marginTop: 16 }}>
        Estimated at public API list prices. Flat-rate plans (Claude Max / Cursor pooled) have no per-request truth — directional. Local models cost $0.
      </p>
    </>
  );
}

/* ---------- Models lens: what we run, how efficient (model / token shape) ---------- */
function ModelsTab({ report: m }: { report: ModelsReport }) {
  const t = m.totals;
  const tokenRing = m.models.slice(0, 8).map((r, i) => ({
    key: r.model, value: r.total_tokens, color: PALETTE[i % PALETTE.length],
    label: shortModel(r.model), href: `/sessions?model=${encodeURIComponent(r.model)}`,
  }));

  // Token composition.
  const tot = t.attributedTokens || 1;
  const inputPct = (t.input / tot) * 100, outputPct = (t.output / tot) * 100, cachePct = (t.cache_read / tot) * 100;

  // Weekly area (fill gaps so empty weeks read as zero).
  const present = [...new Set(m.weekly.map((r) => r.week))].sort();
  const weeks: string[] = [];
  if (present.length) {
    let cur = new Date(present[0] + 'T00:00:00Z').getTime();
    const end = new Date(present[present.length - 1] + 'T00:00:00Z').getTime();
    while (cur <= end && weeks.length < 52) { weeks.push(new Date(cur).toISOString().slice(0, 10)); cur += 7 * 86400000; }
  }
  const weekLabels = weeks.map((w) => { const d = new Date(w + 'T00:00:00Z'); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; });
  const topModels = m.models.slice(0, 5).map((x) => x.model);
  const areaSeries = topModels.map((model, i) => ({
    key: shortModel(model), color: PALETTE[i % PALETTE.length],
    data: weeks.map((w) => m.weekly.find((r) => r.week === w && r.model === model)?.tokens ?? 0),
  }));

  const errRate = t.session_count >= 0 && m.reliability.total_tool_calls > 0
    ? (m.reliability.failed_calls / m.reliability.total_tool_calls) * 100 : null;
  const csv = m.models.map((x) => ({ model: x.model, provider: x.provider, sessions: x.sessions, input: x.input, output: x.output, cache_read: x.cache_read, total: x.total_tokens, cache_pct: x.cache_pct, est_cost_usd: x.cost_usd?.toFixed(2) ?? '' }));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}><CsvExport data={csv} filename={`tokenomics-models-${m.period}.csv`} /></div>

      <div className="grid mb-20" style={{ gridTemplateColumns: '280px 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          <div className="card-title" style={{ marginBottom: 12 }}>Tokens by model</div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ErrorBoundary fallbackTitle="Ring failed to render">
              <RingChart segments={tokenRing} size={190} strokeWidth={26} centerValue={fmtTok(t.attributedTokens)} centerLabel={`${t.model_count} models`} />
            </ErrorBoundary>
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="card-title" style={{ marginBottom: 12 }}>Token composition</div>
          <div style={{ display: 'flex', height: 18, borderRadius: 6, overflow: 'hidden', background: 'var(--surface-3)' }}>
            {inputPct > 0 && <div style={{ width: `${inputPct}%`, background: '#22C55E' }} title={`Input ${inputPct.toFixed(1)}%`} />}
            {outputPct > 0 && <div style={{ width: `${Math.max(outputPct, 0.6)}%`, background: '#F59E0B' }} title={`Output ${outputPct.toFixed(1)}%`} />}
            {cachePct > 0 && <div style={{ width: `${cachePct}%`, background: '#6366F1' }} title={`Cache ${cachePct.toFixed(1)}%`} />}
          </div>
          <div className="tok-legend" style={{ marginTop: 12 }}>
            <div className="item"><Dot c="#22C55E" /><span className="v">Input · {fmtTok(t.input)} ({inputPct.toFixed(1)}%)</span></div>
            <div className="item"><Dot c="#F59E0B" /><span className="v">Output · {fmtTok(t.output)} ({outputPct.toFixed(1)}%)</span></div>
            <div className="item"><Dot c="#6366F1" /><span className="v">Cache · {fmtTok(t.cache_read)} ({cachePct.toFixed(1)}%)</span></div>
          </div>
          {/* Reliability — honest about which agents emit a signal. */}
          <div style={{ marginTop: 16, display: 'flex', gap: 24, fontSize: 12, color: 'var(--text-muted)' }}>
            <span>Tool calls <b style={{ color: 'var(--text)' }}>{fmtNum(m.reliability.total_tool_calls)}</b></span>
            <span>Errors <b style={{ color: 'var(--text)' }}>{errRate != null ? `${errRate.toFixed(1)}%` : '—'}</b></span>
            <span>Avg latency <b style={{ color: 'var(--text)' }}>{m.reliability.avg_tool_latency ? `${Math.round(m.reliability.avg_tool_latency)}ms` : '—'}</b></span>
            <span className="muted" style={{ fontSize: 11 }}>error/latency: Claude Code &amp; Codex only — others log no signal</span>
          </div>
        </div>
      </div>

      {areaSeries.length > 0 && weeks.length > 1 && (
        <div className="card mb-20">
          <div className="card-head"><div><h3 className="card-title">Token usage over time</h3><p className="card-sub">weekly tokens by model · click a week to drill in</p></div></div>
          <div className="card-pad">
            <ErrorBoundary fallbackTitle="Token usage chart failed to render">
              <AreaChart series={areaSeries} labels={weekLabels} height={200} stacked hrefTemplate="/sessions?month={label}" />
            </ErrorBoundary>
          </div>
        </div>
      )}

      {m.providers.length > 0 && (
        <div className="grid g-4 mb-20" style={{ gridTemplateColumns: `repeat(${Math.min(m.providers.length, 4)}, 1fr)` }}>
          {m.providers.map((p) => (
            <div className="card" key={p.name} style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <strong style={{ fontSize: 15 }}>{p.name}</strong>
                <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 3, fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', background: p.mode === 'Local' ? 'var(--accent-soft)' : 'var(--surface-3)', color: p.mode === 'Local' ? 'var(--accent)' : 'var(--text-muted)' }}>{p.mode}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 16 }}>
                <span>{p.modelCount} model{p.modelCount !== 1 ? 's' : ''}</span>
                <span>{fmtTok(p.totalTokens)}</span>
                <span className="fw6">{p.mode === 'Local' ? '$0' : p.estCost !== null ? `~${fmtUsd(p.estCost)}` : '—'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <Collapsible title="Model details" count={m.models.length} defaultOpen>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Model</th><th>Provider</th><th className="num">Sessions</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cache</th><th className="num">Total</th><th className="num">Cache %</th><th className="num">Est. cost</th></tr></thead>
              <tbody>
                {m.models.map((x: ModelRow) => {
                  const pricing = getModelPricing(x.model);
                  return (
                    <tr key={x.model} className="clickable">
                      <td><Link href={`/sessions?model=${encodeURIComponent(x.model)}`}><span className="tag-model">{x.model}</span></Link></td>
                      <td><span className="f12 muted">{x.provider}</span></td>
                      <td className="num">{fmtNum(x.sessions)}</td>
                      <td className="num">{fmtTok(x.input)}</td>
                      <td className="num">{fmtTok(x.output)}</td>
                      <td className="num">{fmtTok(x.cache_read)}</td>
                      <td className="num fw6">{fmtTok(x.total_tokens)}</td>
                      <td className="num"><span className="mono f12">{x.cache_pct}%</span></td>
                      <td className="num">{x.cost_usd == null ? <span className="f12 muted" title="No public API price known">unpriced</span> : <span className="mono f12 fw6">{x.local ? '$0 (local)' : fmtUsd(x.cost_usd)}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Collapsible>
      </div>
    </>
  );
}

/* ---------- small helpers / presentational ---------- */
function Kpi({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="card stat" style={{ padding: '14px 16px' }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: 24 }}>{value}</div>
      <div className="stat-foot">{foot}</div>
    </div>
  );
}
const Dot = ({ c }: { c: string }) => <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />;
const Muted = ({ children }: { children: React.ReactNode }) => <div style={{ color: 'var(--text-subtle)', fontSize: 13 }}>{children}</div>;

function chip(active: boolean): React.CSSProperties {
  return { padding: '4px 10px', fontSize: 12, borderRadius: 6, textDecoration: 'none', background: active ? 'var(--accent)' : 'var(--surface-2)', color: active ? '#fff' : 'var(--text-muted)' };
}
function tabStyle(active: boolean): React.CSSProperties {
  return { padding: '8px 16px', fontSize: 13, fontWeight: 600, textDecoration: 'none', color: active ? 'var(--text)' : 'var(--text-muted)', borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent', marginBottom: -1 };
}

function flatFin(r: FinopsRow) {
  return { key: r.label, input: r.input, output: r.output, cache_read: r.cacheRead, cache_write: r.cacheWrite, tokens: r.tokens, sessions: r.sessions, cost_usd: r.costUsd.toFixed(4), has_unpriced: r.hasUnpriced ? 1 : 0, local: r.local ? 1 : 0 };
}

function FinTable({ title, rows, hrefBase, labelFn }: { title: string; rows: FinopsRow[]; hrefBase: string; labelFn?: (s: string) => string }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="card-title" style={{ padding: '12px 16px' }}>{title}</div>
      <table className="data-table" style={{ width: '100%' }}>
        <thead><tr><th style={{ textAlign: 'left' }}>Name</th><th style={{ textAlign: 'right' }}>Cost</th><th style={{ textAlign: 'right' }}>Tokens</th><th style={{ textAlign: 'right' }}>Sessions</th></tr></thead>
        <tbody>
          {rows.slice(0, 25).map((r) => (
            <tr key={r.key}>
              <td style={{ textAlign: 'left' }}><Link href={`/sessions?${hrefBase}=${encodeURIComponent(r.label)}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>{labelFn ? labelFn(r.label) : r.label}</Link></td>
              <td style={{ textAlign: 'right' }} className="mono">{r.local ? <span style={{ color: 'var(--text-subtle)' }}>$0 local</span> : (r.hasUnpriced ? '~' : '') + fmtUsd(r.costUsd)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{fmtTok(r.tokens)}</td>
              <td style={{ textAlign: 'right' }} className="mono">{r.sessions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
