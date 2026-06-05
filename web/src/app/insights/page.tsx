import { getInsights } from '@/lib/insights';
import { EmptyState } from '@/components/empty-state';
import { ErrorBoundary } from '@/components/error-boundary';
import { RingChart } from '@/components/ring-chart';

export const dynamic = 'force-dynamic';

function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

const ARCH: Record<string, { label: string; color: string }> = {
  Shipper: { label: 'Shipper', color: 'var(--pos, #15803D)' },
  Thinker: { label: 'Thinker', color: '#8B5CF6' },
  Generalist: { label: 'Generalist', color: 'var(--info, #3B82F6)' },
  Quiet: { label: 'Quiet', color: 'var(--text-muted)' },
};

export default function InsightsPage() {
  const data = getInsights();

  if (!data.hasData) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Insights</h1>
            <p className="page-sub">What your agent usage actually means</p>
          </div>
        </div>
        <EmptyState
          icon="brain-circuit"
          title="No insights yet"
          description="Collect some sessions first — insights are derived from your real agent history."
          action={{ label: 'How to collect', href: '/settings' }}
        />
      </div>
    );
  }

  const { agents, verdict, insights, caveats, totals, tokenShare, modelIO } = data;

  // Caption for the token-share ring: spotlight the token-burner (most tokens
  // per shipped change), not merely the biggest holder.
  const burner = [...agents]
    .filter((a) => a.tokens > 0)
    .sort((a, z) => (z.tokens / Math.max(1, z.ship)) - (a.tokens / Math.max(1, a.ship)))[0];
  const burnerShare = burner && totals.tokens ? Math.round((100 * burner.tokens) / totals.tokens) : 0;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Insights</h1>
          <p className="page-sub">Judgements from {totals.sessions} sessions · {totals.ship.toLocaleString()} shipped changes · {fmtTok(totals.tokens)} tokens</p>
        </div>
      </div>

      {/* ── Verdict hero ───────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
        <div className="card-pad" style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 28, alignItems: 'center' }}>
          <div>
            <div className="f12 fw6" style={{ letterSpacing: 1.5, textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 10 }}>
              ◆ Verdict · best agent
            </div>
            <h2 style={{ fontSize: 26, lineHeight: 1.2, fontWeight: 700, margin: '0 0 12px' }}>{verdict.headline}</h2>
            <p className="f13" style={{ color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>{verdict.reason}</p>
          </div>

          {/* share-of-shipped-changes comparison */}
          <div className="col-flex gap-10">
            <div className="f12 muted" style={{ marginBottom: 2 }}>share of all shipped changes</div>
            {[...agents].sort((a, z) => z.ship - a.ship).map((a) => {
              const share = totals.ship ? (a.ship / totals.ship) * 100 : 0;
              const win = a.agent === verdict.winner;
              return (
                <div key={a.agent} className="row" style={{ alignItems: 'center', gap: 10 }}>
                  <span className="mono f12" style={{ width: 92, textAlign: 'right', color: win ? 'var(--accent)' : 'var(--text-muted)', fontWeight: win ? 700 : 500 }}>{a.agent}</span>
                  <div style={{ flex: 1, background: 'var(--surface-3)', borderRadius: 6, height: 22, position: 'relative', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(2, share)}%`, height: '100%', background: win ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 35%, var(--surface-3))', borderRadius: 6, transition: 'width .3s' }} />
                    <span className="mono" style={{ position: 'absolute', right: 8, top: 0, lineHeight: '22px', fontSize: 11, fontWeight: 700, color: share > 60 ? '#fff' : 'var(--text)' }}>
                      {share.toFixed(0)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Sentence-led insight cards ─────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 20 }}>
        {insights.map((ins) => (
          <div key={ins.key} className="card card-pad">
            <div className="f12 fw6" style={{ letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>{ins.title}</div>
            <div className="f15 fw6" style={{ fontSize: 15, lineHeight: 1.35, marginBottom: 6 }}>{ins.headline}</div>
            {ins.detail && <div className="f12" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>{ins.detail}</div>}
          </div>
        ))}
      </div>

      {/* ── Effort → output + token share ──────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: '1.5fr 1fr', gap: 16, marginBottom: 20 }}>
        <ErrorBoundary fallbackTitle="Cost-vs-output failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Cost vs output</h3>
              <p className="card-sub">share of tokens spent vs share of code shipped</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="row between f12 muted" style={{ marginBottom: 10, padding: '0 2px' }}>
              <span>← tokens spent</span>
              <span>shipped changes →</span>
            </div>
            <div className="col-flex gap-14">
              {[...agents].sort((a, z) => z.ship - a.ship).map((a) => {
                const tokPct = totals.tokens ? (a.tokens / totals.tokens) * 100 : 0;
                const shipPct = totals.ship ? (a.ship / totals.ship) * 100 : 0;
                const color = a.archetype === 'Thinker' ? '#8B5CF6' : a.archetype === 'Shipper' ? 'var(--accent)' : 'var(--info, #3B82F6)';
                return (
                  <div key={a.agent}>
                    <div className="row between" style={{ marginBottom: 4 }}>
                      <span className="mono f12 fw6">{a.agent}{(a.noTokenCapture || a.partialTokenCapture) && <span title={a.noTokenCapture ? 'Logs no tokens at all — share is not meaningful.' : 'Logs no cache-read tokens — share is understated but real.'} style={{ color: 'var(--warn)', marginLeft: 6, cursor: 'help' }}>⚠</span>}</span>
                      <span className="f12 muted">{a.archetype}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1fr', alignItems: 'center', gap: 0 }}>
                      {/* tokens (grows left from center) */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6 }}>
                        <span className="mono f12" style={{ color: 'var(--text-muted)' }}>{a.noTokenCapture ? '~0%' : tokPct.toFixed(0) + '%'}</span>{/* partial-capture agents show their real (understated) share, not ~0% */}
                        <div style={{ width: `${Math.max(1, tokPct)}%`, height: 16, background: 'color-mix(in srgb, var(--neg, #DC2626) 60%, var(--surface-3))', borderRadius: '4px 0 0 4px' }} />
                      </div>
                      <div style={{ width: 1, height: 26, background: 'var(--border-strong)' }} />
                      {/* shipped (grows right from center) */}
                      <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: `${Math.max(1, shipPct)}%`, height: 16, background: color, borderRadius: '0 4px 4px 0' }} />
                        <span className="mono f12" style={{ color: 'var(--text-muted)' }}>{shipPct.toFixed(0)}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="f12" style={{ color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 14 }}>
              A wide left bar with a thin right bar = tokens burned without shipping. The efficient agent is the mirror image: little spend, lots shipped.
              {agents.some((a) => a.noTokenCapture || a.partialTokenCapture) && (
                <> <strong style={{ color: 'var(--warn)' }}>⚠</strong> = token data incomplete: the agent logs no per-session tokens at all (VS Code, Antigravity) so its share is shown as ~0%, or logs no cache-read tokens (Cursor) so its real share is understated. Either way it&apos;s a measurement gap — don&apos;t read it as efficiency.</>
              )}
            </div>
          </div>
        </div>
        </ErrorBoundary>

        <ErrorBoundary fallbackTitle="Token share failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Where your tokens go</h3>
              <p className="card-sub">spend by agent</p>
            </div>
          </div>
          <div className="card-pad" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            {tokenShare.length > 0 && (
              <RingChart segments={tokenShare} centerLabel="tokens" centerValue={fmtTok(totals.tokens)} showLegend size={200} strokeWidth={28} />
            )}
            {burner && (
              <div className="f12" style={{ color: 'var(--text-muted)', lineHeight: 1.55, textAlign: 'center' }}>
                {burnerShare}% of all tokens went to <strong style={{ color: 'var(--text)' }}>{burner.agent}</strong> for just {burner.ship.toLocaleString()} shipped change{burner.ship === 1 ? '' : 's'}
                {burner.archetype === 'Thinker' ? ' — reasoning spend, not delivery.' : '.'}
              </div>
            )}
          </div>
        </div>
        </ErrorBoundary>
      </div>

      {/* ── Input vs output tokens, by model ───────────────────── */}
      {modelIO.length > 0 && (
        <ErrorBoundary fallbackTitle="Input/output by model failed to render">
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-head">
            <div>
              <h3 className="card-title">Input vs output tokens, by model</h3>
              <p className="card-sub">fresh tokens read in vs written out · color-coded by model · cache excluded</p>
            </div>
            <div className="right row gap-12 f12 muted">
              <span className="row gap-6"><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--text-muted)', display: 'inline-block' }} /> input</span>
              <span className="row gap-6"><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--text-muted)', opacity: 0.45, display: 'inline-block' }} /> output</span>
            </div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-14">
              {modelIO.map((m) => {
                const total = m.input + m.output;
                const inPct = total > 0 ? (m.input / total) * 100 : 0;
                const outPct = total > 0 ? (m.output / total) * 100 : 0;
                const shortName = m.model.replace(/-20\d{6}$/, '');
                return (
                  <a key={m.model} href={m.href} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
                    <div className="row between mb-4">
                      <span className="mono f12 fw6" style={{ color: m.color }}>{shortName}</span>
                      <span className="mono f12 muted">in {fmtTok(m.input)} · out {fmtTok(m.output)}</span>
                    </div>
                    <div style={{ display: 'flex', height: 16, borderRadius: 5, overflow: 'hidden', background: 'var(--surface-3)' }}>
                      <div style={{ width: `${inPct}%`, background: m.color }} title={`input ${inPct.toFixed(0)}%`} />
                      <div style={{ width: `${outPct}%`, background: m.color, opacity: 0.45 }} title={`output ${outPct.toFixed(0)}%`} />
                    </div>
                  </a>
                );
              })}
            </div>
            <div className="f12" style={{ color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 14 }}>
              Output is the model&apos;s actual generation — the expensive part. A thin output sliver against a wide input bar means the model reads far more than it writes (heavy context, light delivery).
            </div>
          </div>
        </div>
        </ErrorBoundary>
      )}

      {/* ── Agent scorecards ───────────────────────────────────── */}
      <ErrorBoundary fallbackTitle="Scorecards failed to render">
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">Agent scorecard</h3>
            <p className="card-sub">ranked by shipping efficiency</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl" style={{ fontSize: 12.5 }}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Role</th>
                <th className="num">Sessions</th>
                <th className="num">Edits</th>
                <th className="num">Commits</th>
                <th className="num">Tokens</th>
                <th className="num" title="Edits + commits shipped per 1 million tokens spent — higher is more efficient">Ship / 1M tok</th>
                <th className="num" title="Tokens spent per git commit — lower is leaner">Tok / commit</th>
                <th className="num" title="Share of this agent's tool calls that returned an error">Error rate</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const arch = ARCH[a.archetype];
                return (
                  <tr key={a.agent}>
                    <td><span className="mono fw6">{a.agent}</span></td>
                    <td><span className="badge" style={{ background: `color-mix(in srgb, ${arch.color} 14%, transparent)`, color: arch.color }}>{arch.label}</span></td>
                    <td className="num">{a.sessions}</td>
                    <td className="num">{a.edits.toLocaleString()}</td>
                    <td className="num">{a.commits}</td>
                    <td className="num mono">{fmtTok(a.tokens)}</td>
                    <td className="num mono fw6">{a.shipPerMtok < 1 ? a.shipPerMtok.toFixed(1) : Math.round(a.shipPerMtok)}</td>
                    <td className="num mono">{a.tokPerCommit != null ? fmtTok(a.tokPerCommit) : '—'}</td>
                    <td className="num mono">{a.errRate != null ? a.errRate.toFixed(1) + '%' : <span className="muted">no signal</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      </ErrorBoundary>

      {/* ── Caveats (honesty) ──────────────────────────────────── */}
      {caveats.length > 0 && (
        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          <div className="f12 fw6" style={{ letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>What we don&apos;t claim</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-muted)' }}>
            {caveats.map((c, i) => (
              <li key={i} className="f12" style={{ lineHeight: 1.6 }}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
