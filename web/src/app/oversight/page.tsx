import { getDb, fmtNum } from '@/lib/db';
import { getOversight, type OversightFile } from '@/lib/oversight';
import { RingChart } from '@/components/ring-chart';
import { AreaChart } from '@/components/area-chart';
import { Treemap } from '@/components/treemap';
import { GaugeChart } from '@/components/gauge-chart';
import { Collapsible } from '@/components/collapsible';
import { EmptyState } from '@/components/empty-state';
import Link from 'next/link';
import { basename } from 'path';

export const dynamic = 'force-dynamic';

const C_AI = '#6366F1';
const C_HUMAN = '#46A35E';
const C_MIXED = '#E0A458';
const C_UNKNOWN = '#8A8F98';

/** green (human) → amber → red (AI) for a 0..100 AI percentage. */
function aiColor(pctVal: number): string {
  const t = Math.max(0, Math.min(100, pctVal)) / 100;
  const green = [70, 163, 94], amber = [224, 164, 88], red = [229, 72, 77];
  const [a, b, k] = t < 0.5 ? [green, amber, t * 2] : [amber, red, (t - 0.5) * 2];
  const ch = (i: number) => Math.round(a[i] + (b[i] - a[i]) * k);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

function pct(n: number): string {
  if (!isFinite(n)) return '—';
  return n >= 99.95 ? '100%' : `${n.toFixed(n < 10 ? 1 : 0)}%`;
}

function Chip({ text }: { text: string }) {
  // Category lives in the dot + border colour; the TEXT stays high-contrast
  // (var(--text) on a surface) so it passes WCAG on both themes. Coloured text
  // here was 1.94:1 — unreadable.
  const tone = /never reviewed/.test(text) ? C_AI
    : /touches/.test(text) ? C_MIXED
    : /error/.test(text) ? '#E5484D' : 'var(--text-muted)';
  return (
    <span className="tag-mono" style={{ borderColor: tone, color: 'var(--text)', background: 'var(--surface-2)', fontSize: 10, padding: '1px 6px', marginRight: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: tone, display: 'inline-block', flexShrink: 0 }} />
      {text}
    </span>
  );
}

export default async function OversightPage({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  const sp = await searchParams;
  const db = getDb();
  const data = getOversight(db, sp?.repo || null);

  if (data.repos.length === 0) {
    return (
      <main className="page page-wide">
        <div className="page-head"><h1 className="page-title">Authorship &amp; Oversight</h1></div>
        <EmptyState
          icon="shield-check"
          title="No git history analyzed yet"
          description="Run a collect inside repos you build with AI agents. AgentDX reads git blame + log locally to compute who actually wrote what — nothing leaves your machine."
        />
      </main>
    );
  }

  const { stock, signals, trend } = data;
  const ringSegments = [
    { key: 'ai', value: stock.ai, color: C_AI, label: 'AI' },
    { key: 'mixed', value: stock.mixed, color: C_MIXED, label: 'Mixed' },
    { key: 'human', value: stock.human, color: C_HUMAN, label: 'Human' },
    { key: 'unknown', value: stock.unknown, color: C_UNKNOWN, label: 'Unattributed' },
  ].filter((s) => s.value > 0);

  const trendSeries = [
    { key: 'AI', color: C_AI, data: trend.ai },
    { key: 'Mixed', color: C_MIXED, data: trend.mixed },
    { key: 'Human', color: C_HUMAN, data: trend.human },
  ];
  // Thin the 26 weekly ticks so they don't overlap into mush — keep every 4th.
  const trendLabels = trend.labels.map((l, i) => (i % 4 === 0 ? l : ''));

  const treemapItems = data.treemap.map((t) => ({
    key: t.file,
    value: t.total,
    label: basename(t.file),
    subLabel: `${pct(t.aiPct)} AI-assisted · ${fmtNum(t.total)} ln`,
    color: aiColor(t.aiPct),
    // Open the MOST RECENT session that edited this file directly. If no captured
    // session touched it (hand-committed / uncollected), fall back to the repo's
    // session list, with the file param so the page can explain the miss.
    href: t.sessionId
      ? `/sessions/${t.sessionId}`
      : `/sessions?file=${encodeURIComponent(`${t.repo.replace(/\/+$/, '')}/${t.file}`)}&project=${encodeURIComponent(basename(t.repo))}`,
  }));

  return (
    <main className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Authorship &amp; Oversight</h1>
          <p className="page-sub">Who actually wrote this code — and where you&apos;ve stopped looking.</p>
        </div>
      </div>

      {/* Repo selector */}
      <div className="row gap-8 mb-20" style={{ flexWrap: 'wrap' }}>
        <RepoTab href="/oversight" label="All repos" active={!data.selectedRepo} sub={`${data.repos.length} repos`} />
        {data.repos.map((r) => (
          <RepoTab key={r.path} href={`/oversight?repo=${encodeURIComponent(r.path)}`} label={r.name} active={data.selectedRepo === r.path} sub={`${fmtNum(r.files)} files`} />
        ))}
      </div>

      {/* ── Q1 headline: stock + flow, co-equal ─────────────────── */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '1.1fr 1fr 1fr', gap: 14 }}>
        <div className="card card-pad">
          <div className="card-title">Surviving code (blame)</div>
          <div className="card-sub">What&apos;s in the tree today</div>
          <div className="row gap-8" style={{ alignItems: 'center', marginTop: 8 }}>
            <RingChart segments={ringSegments} size={150} strokeWidth={22} centerValue={pct(signals.aiStockPct)} centerLabel="AI-assisted" />
            <div className="col-flex gap-14">
              <SplitRow color={C_AI} label="AI" value={stock.ai} total={stock.total} />
              <SplitRow color={C_MIXED} label="Mixed" value={stock.mixed} total={stock.total} />
              <SplitRow color={C_HUMAN} label="Human" value={stock.human} total={stock.total} />
              {stock.unknown > 0 && <SplitRow color={C_UNKNOWN} label="Unattributed" value={stock.unknown} total={stock.total} />}
            </div>
          </div>
        </div>

        <div className="card card-pad">
          <div className="card-title">Lines written (churn)</div>
          <div className="card-sub">Flow over time — incl. rewrites</div>
          <div className="stat-value" style={{ color: C_AI, fontSize: 38, marginTop: 14 }}>{pct(signals.aiChurnPct)}</div>
          <div className="stat-label">of all lines committed came from AI-assisted commits</div>
          <div className="row gap-8" style={{ marginTop: 12 }}>
            <span className="f12 muted">AI {fmtNum(data.churn.ai + data.churn.mixed)}</span>
            <span className="f12 muted">·</span>
            <span className="f12 muted">Human {fmtNum(data.churn.human)}</span>
          </div>
        </div>

        <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
          <div className="card-title" style={{ marginBottom: 10 }}>AI-assisted share of code</div>
          <GaugeChart value={signals.aiStockPct} label="" />
        </div>
      </div>

      {/* ── Q4 control signals ──────────────────────────────────── */}
      <div className="grid g-4 mb-20">
        <Stat value={fmtNum(signals.unreviewedAiFiles)} label="AI files, never reviewed" foot={`${pct(signals.unreviewedAiPct)} of files — no human commit or read`} tone={C_AI} />
        <Stat value={isFinite(signals.aiHumanRatio) ? `${signals.aiHumanRatio.toFixed(1)}×` : '∞'} label="AI-assisted : human lines" foot="surviving-code ratio" />
        <Stat value={pct(signals.velocityGapPct)} label="AI share of code, last 4 weeks" foot={signals.velocityRising ? 'rising vs all-time ▲' : 'steady vs all-time'} tone={signals.velocityRising ? '#E5484D' : undefined} />
        <Stat value={fmtNum(data.blindspotTotal)} label="Blindspot files" foot={`AI-authored · unseen${data.blindspotTotal > 25 ? ' · top 25 listed' : ''}`} />
      </div>

      {/* ── Q4 trend ────────────────────────────────────────────── */}
      <div className="card card-pad mb-20">
        <div className="card-head"><div className="card-title">Authorship over time</div><div className="card-sub">Weekly lines committed, by attribution (last 26 weeks)</div></div>
        <AreaChart series={trendSeries} labels={trendLabels} height={200} stacked />
      </div>

      {/* ── Q1 treemap ──────────────────────────────────────────── */}
      <div className="card card-pad mb-20">
        <div className="card-head"><div className="card-title">Every file, sized by lines, colored by AI authorship</div><div className="card-sub">Red = AI-assisted · green = human · click to drill into sessions</div></div>
        {treemapItems.length > 0 ? <Treemap items={treemapItems} /> : <p className="muted f13">No files to map.</p>}
      </div>

      {/* ── Q2 review queue ─────────────────────────────────────── */}
      <div className="card mb-20">
        <div className="card-head card-pad" style={{ paddingBottom: 8 }}>
          <div className="card-title">Review queue — files you should look at first</div>
          <div className="card-sub">Ranked by AI authorship × blast radius × risk surface × never-reviewed × recency × error rate. Every score is explained.</div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>#</th><th>File</th><th style={{ textAlign: 'right' }}>AI</th><th style={{ textAlign: 'right' }}>Lines</th><th style={{ textAlign: 'right' }}>Score</th><th>Why</th></tr></thead>
            <tbody>
              {data.reviewQueue.slice(0, 25).map((f, i) => (
                <tr key={f.repo + f.file}>
                  <td className="muted f12">{i + 1}</td>
                  <td className="mono f12" title={f.file}>{shortPath(f.file)}</td>
                  <td className="mono f12" style={{ textAlign: 'right', color: aiColor(f.aiPct) }}>{pct(f.aiPct)}</td>
                  <td className="mono f12 muted" style={{ textAlign: 'right' }}>{fmtNum(f.totalLines)}</td>
                  <td className="mono f12 fw6" style={{ textAlign: 'right' }}>{Math.round(f.score)}</td>
                  <td>{f.reasons.slice(0, 4).map((r) => <Chip key={r} text={r} />)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Q3 blindspots ───────────────────────────────────────── */}
      <div className="card card-pad mb-20">
        <div className="card-head"><div className="card-title">Blindspots</div><div className="card-sub">AI wrote it, no human has committed to or read it, and other code depends on it. The stuff you don&apos;t know you don&apos;t know.</div></div>
        {data.blindspots.length === 0 ? (
          <p className="muted f13">No blindspots — every AI-authored file has had human eyes. Good.</p>
        ) : (
          <div className="col-flex gap-14" style={{ marginTop: 8 }}>
            {data.blindspots.slice(0, 12).map((f) => (
              <div key={f.repo + f.file} className="row between" style={{ alignItems: 'center' }}>
                <div>
                  <div className="mono f12 fw6" title={f.file}>{shortPath(f.file)}</div>
                  <div className="f12 muted">{fmtNum(f.aiLines + f.mixedLines)} AI-assisted lines{f.fanIn > 0 ? ` · ${f.fanIn} dependents` : ''}{f.risk.length ? ` · ${f.risk.join(', ')}` : ''}</div>
                </div>
                <span className="tag-mono" style={{ borderColor: C_AI, color: C_AI }}>unseen</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Honesty footer ──────────────────────────────────────── */}
      <Collapsible title="How these numbers are computed (and where they're soft)">
        <div className="f12 muted col-flex gap-14" style={{ lineHeight: 1.6 }}>
          <p><b>Line counts are exact</b> — straight from <span className="mono">git blame</span> (surviving lines) and <span className="mono">git log</span> (churn). <b>The AI/human label is a heuristic.</b> A commit is &quot;AI-assisted&quot; when an agent session edited the same files within ~24h (your file_events overlap), or a <span className="mono">Co-authored-by</span> trailer / bot email names an AI. Each commit carries a confidence; we never claim line-precise authorship.</p>
          <p><b>Mixed</b> = a commit that touched both agent-edited and hand-edited files, or a squashed/rebased history where blame can&apos;t separate the two. Repos with rewritten history skew toward &quot;mixed&quot; — that&apos;s honest uncertainty, not AI.</p>
          <p><b>Centrality</b> (deps) is an approximate import-graph count{data.centralityAvailable ? '' : ' — unavailable for this repo'}. <b>Reviewed</b> = a human commit touched the file OR it was read back in a later session (lenient).</p>
          <p><b>Coverage:</b> {data.coverage.analyzed} repos with local git history analyzed; repos that are remote-only or have no local <span className="mono">.git</span> are skipped. Counts cover <b>source code only</b> — data, config, docs, and generated files (lockfiles, <span className="mono">*.manifest.json</span>, graph dumps) are excluded so they can&apos;t inflate the split.</p>
        </div>
      </Collapsible>
    </main>
  );
}

function RepoTab({ href, label, active, sub }: { href: string; label: string; active: boolean; sub: string }) {
  return (
    <Link href={href} className="card" style={{ padding: '6px 12px', textDecoration: 'none', borderColor: active ? 'var(--accent)' : undefined, background: active ? 'var(--surface-2)' : undefined }}>
      <div className="f13 fw6">{label}</div>
      <div className="f12 muted">{sub}</div>
    </Link>
  );
}

function SplitRow({ color, label, value, total }: { color: string; label: string; value: number; total: number }) {
  return (
    <div className="row between" style={{ alignItems: 'center', gap: 10, minWidth: 150 }}>
      <span className="row gap-8" style={{ alignItems: 'center' }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block' }} />
        <span className="f12">{label}</span>
      </span>
      <span className="mono f12 muted">{total ? Math.round((value / total) * 100) : 0}%</span>
    </div>
  );
}

function Stat({ value, label, foot, tone }: { value: string; label: string; foot: string; tone?: string }) {
  return (
    <div className="card stat">
      <div className="stat-value" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-foot">{foot}</div>
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length <= 3 ? p : '…/' + parts.slice(-3).join('/');
}
