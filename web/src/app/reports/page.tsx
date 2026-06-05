import { getDb, fmtTok, fmtNum, timeAgo } from '@/lib/db';
import Link from 'next/link';
import { Collapsible } from '@/components/collapsible';
import { DrilldownTiles } from '@/components/drilldown-tiles';
import { Sparkline } from '@/components/sparkline';
import { PrintButton } from '@/components/print-button';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';
import {
  BarChart3, BrainCircuit, ShieldCheck, Users,
  FileText, Database, Clock, Terminal,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

function getReportsData() {
  const db = getDb();

  const totalSessions = (db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as any).cnt;
  const totalMessages = (db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as any).cnt;
  const totalToolCalls = (db.prepare('SELECT COUNT(*) as cnt FROM tool_calls').get() as any).cnt;

  // Token total uses the canonical app-wide basis (sessions: input+output+
  // cache_read) so the headline reconciles with Overview/Models AND with the
  // session-based daily sparkline below.
  const tokenTotals = db.prepare(`
    SELECT SUM(total_input_tokens) as input_tokens, SUM(total_output_tokens) as output_tokens, SUM(total_cache_read) as cache_read
    FROM sessions
  `).get() as any;

  const totalTokens = (tokenTotals.input_tokens || 0) + (tokenTotals.output_tokens || 0) + (tokenTotals.cache_read || 0);
  const cacheHitRate = ((tokenTotals.input_tokens || 0) + (tokenTotals.cache_read || 0)) > 0
    // Cap at 99.9% when any fresh input exists, so it never rounds to a flat 100%.
    ? Math.min(((tokenTotals.cache_read || 0) / ((tokenTotals.input_tokens || 0) + (tokenTotals.cache_read || 0))) * 100, (tokenTotals.input_tokens || 0) > 0 ? 99.9 : 100).toFixed(1) : '0.0';

  const distinctModels = (db.prepare("SELECT COUNT(DISTINCT model) as c FROM model_usage WHERE model != '<synthetic>'").get() as any).c;
  const distinctRepos = (db.prepare('SELECT COUNT(DISTINCT project_path) as c FROM sessions WHERE project_path IS NOT NULL').get() as any).c;
  // Median, not mean: duration_ms is wall-span (first→last message), so sessions
  // left open for days create huge outliers that destroy the average.
  const durCount = (db.prepare('SELECT COUNT(*) as c FROM sessions WHERE duration_ms IS NOT NULL').get() as any).c;
  const medDuration = durCount > 0
    ? ((db.prepare('SELECT duration_ms as v FROM sessions WHERE duration_ms IS NOT NULL ORDER BY duration_ms LIMIT 1 OFFSET ?').get(Math.floor(durCount / 2)) as any)?.v ?? null)
    : null;

  const toolErrors = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors FROM tool_calls`).get() as any;
  const errorRate = (toolErrors.total || 0) > 0 ? (((toolErrors.errors || 0) / toolErrors.total) * 100).toFixed(1) : '0.0';
  const distinctTools = (db.prepare('SELECT COUNT(DISTINCT tool_name) as c FROM tool_calls').get() as any).c;
  const topTool = db.prepare('SELECT tool_name, COUNT(*) as cnt FROM tool_calls GROUP BY tool_name ORDER BY cnt DESC LIMIT 1').get() as any;
  const agentStats = db.prepare(`SELECT agent, COUNT(*) as cnt FROM sessions GROUP BY agent ORDER BY cnt DESC`).all() as any[];

  const collectionRuns = db.prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 10').all() as any[];
  const collectionRunCount = (db.prepare('SELECT COUNT(*) as cnt FROM collection_runs').get() as any).cnt;

  // Sparkline: sessions per day (30d)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const dailySessions = db.prepare(`
    SELECT date(started_at/1000, 'unixepoch') as day, COUNT(*) as cnt
    FROM sessions WHERE started_at >= ${thirtyDaysAgo} GROUP BY day ORDER BY day ASC
  `).all() as any[];

  const dailyTokens = db.prepare(`
    SELECT date(s.started_at/1000, 'unixepoch') as day,
      SUM(s.total_input_tokens + s.total_output_tokens + s.total_cache_read) as tokens
    FROM sessions s WHERE s.started_at >= ${thirtyDaysAgo} GROUP BY day ORDER BY day ASC
  `).all() as any[];

  return {
    totalSessions, totalMessages, totalToolCalls, totalTokens, cacheHitRate,
    distinctModels, distinctRepos, medDuration, errorRate, distinctTools,
    topTool, agentStats, collectionRuns, collectionRunCount,
    sessionSpark: dailySessions.map((d: any) => d.cnt),
    tokenSpark: dailyTokens.map((d: any) => d.tokens),
  };
}

function fmtDur(ms: number | null): string {
  if (!ms) return '--';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function ReportsPage() {
  const {
    totalSessions, totalMessages, totalToolCalls, totalTokens, cacheHitRate,
    distinctModels, distinctRepos, medDuration, errorRate, distinctTools,
    topTool, agentStats, collectionRuns, collectionRunCount,
    sessionSpark, tokenSpark,
  } = getReportsData();

  if (totalSessions === 0) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Reports</h1>
            <p className="page-sub">No data available</p>
          </div>
        </div>
        <EmptyState
          icon="activity"
          title="No report data yet"
          description="Reports are generated from collected session data. Run `agentdx collect` to ingest agent history first."
          action={{ label: 'View sessions', href: '/sessions' }}
        />
      </div>
    );
  }

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">Evidence-backed summaries of coding-agent activity</p>
        </div>
      </div>

      {/* Report template cards with sparklines */}
      <ErrorBoundary fallbackTitle="Report cards failed to render">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start', marginBottom: 20 }}>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Link href="/sessions" className="card card-pad" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="row between mb-8">
              <span className="row gap-8"><BarChart3 size={16} style={{ color: 'var(--accent)' }} /> <span className="f13 fw6">Productivity</span></span>
              <span className="badge badge-neutral" style={{ fontSize: 10 }}>CTO</span>
            </div>
            <div className="row between">
              <div>
                <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(totalSessions)}</div>
                <div className="f12 muted" style={{ marginTop: 4 }}>{fmtNum(totalToolCalls)} tool calls &middot; median {fmtDur(medDuration)}</div>
              </div>
              <Sparkline data={sessionSpark.length >= 2 ? sessionSpark : [0, 0]} width={70} height={28} />
            </div>
          </Link>

          <Link href="/models" className="card card-pad" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="row between mb-8">
              <span className="row gap-8"><BrainCircuit size={16} style={{ color: 'var(--info)' }} /> <span className="f13 fw6">Token Usage</span></span>
              <span className="badge badge-neutral" style={{ fontSize: 10 }}>CFO</span>
            </div>
            <div className="row between">
              <div>
                <div className="stat-value" style={{ fontSize: 22 }}>{fmtTok(totalTokens)}</div>
                <div className="f12 muted" style={{ marginTop: 4 }}>{cacheHitRate}% cache hit &middot; {distinctModels} models</div>
              </div>
              <Sparkline data={tokenSpark.length >= 2 ? tokenSpark : [0, 0]} width={70} height={28} color="var(--info)" />
            </div>
          </Link>

          <Link href="/risk" className="card card-pad" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="row between mb-8">
              <span className="row gap-8"><ShieldCheck size={16} style={{ color: 'var(--warn)' }} /> <span className="f13 fw6">Tool Analysis</span></span>
              <span className="badge badge-neutral" style={{ fontSize: 10 }}>Security</span>
            </div>
            <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(distinctTools)}</div>
            <div className="f12 muted" style={{ marginTop: 4 }}>{errorRate}% errors &middot; top: {topTool?.tool_name || '--'}</div>
          </Link>

          <Link href="/agents" className="card card-pad" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="row between mb-8">
              <span className="row gap-8"><Users size={16} style={{ color: 'var(--pos)' }} /> <span className="f13 fw6">Agent Comparison</span></span>
              <span className="badge badge-neutral" style={{ fontSize: 10 }}>Engineering</span>
            </div>
            <div className="stat-value" style={{ fontSize: 22 }}>{agentStats.length}</div>
            <div className="f12 muted" style={{ marginTop: 4 }}>{agentStats.slice(0, 3).map(a => `${a.agent}: ${a.cnt}`).join(', ')}</div>
          </Link>
        </div>

        {/* Report builder preview */}
        <div className="card" style={{ position: 'sticky', top: 80 }}>
          <div className="card-head">
            <div>
              <h3 className="card-title">Report builder</h3>
              <p className="card-sub"><span className="badge badge-neutral">Draft</span></p>
            </div>
          </div>
          <div className="card-pad">
            <div className="sec-label mb-8">Methodology</div>
            <div className="card" style={{ padding: '12px 14px', background: 'var(--surface-3)', marginBottom: 16 }}>
              <div className="mono f12" style={{ lineHeight: 1.8 }}>
                <span style={{ color: 'var(--accent)' }}>tool_calls</span> / <span style={{ color: 'var(--accent)' }}>sessions</span> = <span className="fw6">tools_per_session</span>
                <br />
                <span style={{ color: 'var(--accent)' }}>cache_read</span> / <span style={{ color: 'var(--accent)' }}>input</span> = <span className="fw6">cache_hit_rate</span>
              </div>
            </div>

            <div className="sec-label mb-8">Evidence links</div>
            <div className="col-flex gap-6 mb-16">
              {[
                { label: `${fmtNum(totalSessions)} sessions captured`, href: '/sessions' },
                { label: `${fmtNum(totalToolCalls)} tool calls recorded`, href: '/agents' },
                { label: `${fmtTok(totalTokens)} tokens consumed`, href: '/models' },
                { label: `${errorRate}% tool error rate`, href: '/risk' },
              ].map(ev => (
                <div key={ev.label} className="row between f12">
                  <span className="muted">{ev.label}</span>
                  <Link href={ev.href} className="lnk" style={{ fontSize: 11 }}>View ›</Link>
                </div>
              ))}
            </div>

            <div className="row gap-8">
              <PrintButton label="Print / Save as PDF" />
            </div>
          </div>
        </div>
      </div>
      </ErrorBoundary>

      {/* Summary as drilldown tiles */}
      <div className="mb-20" id="summary">
        <DrilldownTiles tiles={[
          { label: 'Sessions', value: fmtNum(totalSessions), detail: `median ${fmtDur(medDuration)}`, href: '/sessions', icon: <Terminal size={18} />, tone: 'accent' },
          { label: 'Messages', value: fmtNum(totalMessages), href: '/sessions', icon: <FileText size={18} />, tone: 'info' },
          { label: 'Tool calls', value: fmtNum(totalToolCalls), detail: `${errorRate}% errors`, href: '/agents', icon: <ShieldCheck size={18} />, tone: totalToolCalls > 0 ? 'pos' : 'neutral' },
          { label: 'Tokens', value: fmtTok(totalTokens), detail: `${cacheHitRate}% cached`, href: '/models', icon: <BrainCircuit size={18} />, tone: 'info' },
          { label: 'Models', value: String(distinctModels), href: '/models', icon: <BarChart3 size={18} />, tone: 'pos' },
          { label: 'Repositories', value: String(distinctRepos), href: '/repositories', icon: <Database size={18} />, tone: 'warn' },
          { label: 'Collections', value: fmtNum(collectionRunCount), href: '/collector', icon: <Clock size={18} />, tone: 'neutral' },
          { label: 'Agents', value: String(agentStats.length), detail: agentStats.map(a => a.agent).join(', '), href: '/agents', icon: <Users size={18} />, tone: 'accent' },
        ]} />
      </div>

      {/* Collection runs (collapsible) */}
      <ErrorBoundary fallbackTitle="Collection runs table failed to render">
      <div className="card mb-20">
        <Collapsible title="Recent collection runs" count={collectionRuns.length}>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th className="num">Sessions</th>
                  <th className="num">Messages</th>
                  <th className="num">Tool calls</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {collectionRuns.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32 }}><span className="f13 muted">No collection runs yet.</span></td></tr>
                ) : collectionRuns.map((r: any) => (
                  <tr key={r.id}>
                    <td><span className="f12 muted">{timeAgo(r.started_at)}</span></td>
                    <td><span className="tag-mono">{r.source}</span></td>
                    <td className="num">{fmtNum(r.sessions_added)}</td>
                    <td className="num">{fmtNum(r.messages_added)}</td>
                    <td className="num">{fmtNum(r.tool_calls_added)}</td>
                    <td><span className={`badge ${r.status === 'completed' ? 'badge-pos' : 'badge-warn'}`}>{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Collapsible>
      </div>
      </ErrorBoundary>

      {/* Quick links */}
      <div className="row gap-12">
        <Link href="/sessions" className="btn">Sessions</Link>
        <Link href="/models" className="btn">Models</Link>
        <Link href="/risk" className="btn">Risk</Link>
      </div>
    </div>
  );
}
