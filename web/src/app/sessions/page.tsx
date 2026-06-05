import { getDb, fmtTok, fmtNum } from '@/lib/db';
import { readUserConfig } from '@/lib/config';
import { getRemoteControlData } from '@/lib/remote-control';
import { SessionsTable } from '@/components/sessions-table';
import { TokenHistogram } from '@/components/token-histogram';
import { DrilldownTiles } from '@/components/drilldown-tiles';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';
import Link from 'next/link';
import { Monitor, Camera, Terminal } from 'lucide-react';

export const dynamic = 'force-dynamic';

function getSessionsData() {
  const db = getDb();

  const sessions = db.prepare(`
    SELECT s.id, s.title, s.agent, s.agent_version, s.model_primary, s.status,
      s.total_input_tokens, s.total_output_tokens, s.total_cache_read,
      s.duration_ms, s.tool_call_count, s.turn_count, s.started_at,
      s.project_path, s.git_branch, s.first_user_message,
      COALESCE(err.error_count, 0) as error_count
    FROM sessions s
    LEFT JOIN (SELECT session_id, COUNT(*) as error_count FROM tool_calls WHERE is_error = 1 GROUP BY session_id) err ON err.session_id = s.id
    ORDER BY s.started_at DESC
  `).all() as any[];

  const totals = db.prepare(`
    SELECT
      COUNT(*) as cnt,
      SUM(total_input_tokens + total_output_tokens + total_cache_read) as tokens,
      SUM(tool_call_count) as tools,
      COUNT(DISTINCT model_primary) as models
    FROM sessions
  `).get() as any;

  const modelCount = db.prepare(
    "SELECT COUNT(DISTINCT model) as c FROM model_usage WHERE model != '<synthetic>'"
  ).get() as any;

  const agents = db.prepare(`SELECT DISTINCT agent FROM sessions ORDER BY agent`).all() as any[];
  const models = db.prepare(`SELECT DISTINCT model FROM model_usage WHERE model != '<synthetic>' ORDER BY model`).all() as any[];
  const projects = db.prepare(`
    SELECT DISTINCT project_path FROM sessions WHERE project_path IS NOT NULL ORDER BY project_path
  `).all() as any[];

  return {
    sessions,
    totals,
    modelCount,
    agents: agents.map(a => a.agent),
    models: models.map(m => m.model),
    projects: [...new Set(projects.map(p => p.project_path.split('/').pop()).filter(Boolean))] as string[],
  };
}

export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ agent?: string; model?: string; project?: string; date?: string }> }) {
  const params = await searchParams;
  const { sessions, totals, modelCount, agents, models, projects } = getSessionsData();
  const remote = getRemoteControlData();

  // Session-size histogram: sessions bucketed by token magnitude, stacked
  // clean vs has-errors. Shows the true shape (most sessions tiny; errors
  // concentrate in the few huge ones) — a linear-Y scatter just smeared the
  // bulk along y=0.
  const TOK_BUCKETS = [
    { label: '<1K', max: 1e3 },
    { label: '1–10K', max: 1e4 },
    { label: '10–100K', max: 1e5 },
    { label: '100K–1M', max: 1e6 },
    { label: '1–10M', max: 1e7 },
    { label: '10–100M', max: 1e8 },
    { label: '100M+', max: Infinity },
  ];
  const histogram = TOK_BUCKETS.map((b) => ({ label: b.label, clean: 0, errors: 0 }));
  for (const s of sessions as any[]) {
    const tokens = (s.total_input_tokens || 0) + (s.total_output_tokens || 0) + (s.total_cache_read || 0);
    if (tokens <= 0) continue;
    let i = TOK_BUCKETS.findIndex((b) => tokens < b.max);
    if (i < 0) i = TOK_BUCKETS.length - 1;
    if ((s.error_count || 0) > 0) histogram[i].errors++;
    else histogram[i].clean++;
  }
  const histHasData = histogram.some((b) => b.clean + b.errors > 0);
  const errorSessionCount = histogram.reduce((a, b) => a + b.errors, 0);

  if (sessions.length === 0) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Sessions</h1>
            <p className="page-sub">No sessions captured</p>
          </div>
        </div>
        <EmptyState
          icon="square-terminal"
          title="No sessions yet"
          description="No coding-agent sessions have been collected. Run `agentdx collect` to ingest your history."
          action={{ label: 'Collector status', href: '/collector' }}
        />
      </div>
    );
  }

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Sessions</h1>
          <p className="page-sub">{fmtNum(totals.cnt)} coding-agent sessions captured</p>
        </div>
      </div>

      {/* summary strip */}
      <div className="grid g-4 mb-20">
        <div className="card stat" style={{ padding: '15px 16px' }}>
          <div className="stat-label">Sessions</div>
          <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(totals.cnt)}</div>
          <div className="stat-foot">across {agents.length} agents</div>
        </div>
        <div className="card stat" style={{ padding: '15px 16px' }}>
          <div className="stat-label">Total tokens</div>
          <div className="stat-value" style={{ fontSize: 22 }}>{fmtTok(totals.tokens || 0)}</div>
        </div>
        <div className="card stat" style={{ padding: '15px 16px' }}>
          <div className="stat-label">Tool calls</div>
          <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(totals.tools || 0)}</div>
        </div>
        <div className="card stat" style={{ padding: '15px 16px' }}>
          <div className="stat-label">Models used</div>
          <div className="stat-value" style={{ fontSize: 22 }}>{modelCount.c}</div>
        </div>
      </div>

      {/* Session-size distribution */}
      {histHasData && (
        <ErrorBoundary fallbackTitle="Session histogram failed to render">
        <div className="card mb-20">
          <div className="card-head">
            <div>
              <h3 className="card-title">Session sizes</h3>
              <p className="card-sub">how many sessions land in each token range · {errorSessionCount} had tool errors</p>
            </div>
            <div className="right row gap-12 f12">
              <span className="row gap-6"><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent)', display: 'inline-block' }} /> Clean</span>
              <span className="row gap-6"><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--warn)', display: 'inline-block' }} /> Has errors</span>
            </div>
          </div>
          <div className="card-pad">
            <TokenHistogram buckets={histogram} />
          </div>
        </div>
        </ErrorBoundary>
      )}

      {/* Remote-control insights — audit of browser automation / screenshots / clipboard */}
      {remote.matchedCalls > 0 && (
        <ErrorBoundary fallbackTitle="Remote-control insights failed to render">
        <div className="card mb-20">
          <div className="card-head">
            <div>
              <h3 className="card-title">Remote-control insights</h3>
              <p className="card-sub">browser automation, screenshots & clipboard detected across sessions</p>
            </div>
            <Link href="/remote-control" className="btn btn-sm">Full audit →</Link>
          </div>
          <div className="card-pad">
            <DrilldownTiles tiles={[
              { label: 'Remote sessions', value: fmtNum(remote.remoteSessionCount), detail: 'with detected activity', href: '/remote-control', icon: <Monitor size={18} />, tone: remote.remoteSessionCount > 0 ? 'info' : 'neutral' },
              { label: 'Matched tool calls', value: fmtNum(remote.matchedCalls), detail: 'browser / screenshot / clipboard', href: '/remote-control', icon: <Terminal size={18} />, tone: 'accent' },
              { label: 'Artifacts', value: fmtNum(remote.artifactCount), detail: 'screenshots & files', href: '/remote-control', icon: <Camera size={18} />, tone: remote.artifactCount > 0 ? 'warn' : 'neutral' },
            ]} />
          </div>
        </div>
        </ErrorBoundary>
      )}

      <SessionsTable
        sessions={sessions}
        agents={agents}
        models={models}
        projects={projects}
        initialAgent={params.agent}
        initialModel={params.model}
        initialProject={params.project}
        initialDate={params.date}
        pageSize={readUserConfig().page_size}
      />
    </div>
  );
}
