import { getDb, fmtTok, fmtNum, fmtDuration, timeAgo, getPeriodMs } from '@/lib/db';
import { estimateCostUsd, fmtUsd } from '@/lib/pricing';
import { readUserConfig } from '@/lib/config';
import Link from 'next/link';
import { BarChart } from '@/components/bar-chart';
import { buildBarData, agentColor } from '@/lib/chart-data';
import { PeriodSelector } from '@/components/period-selector';
import { RefreshButton } from '@/components/refresh-button';
import { Sparkline } from '@/components/sparkline';
import { RingChart } from '@/components/ring-chart';
import { HeatmapGrid } from '@/components/heatmap-grid';
import { Collapsible } from '@/components/collapsible';
import { SignalFlow } from '@/components/signal-flow';
import { DrilldownTiles } from '@/components/drilldown-tiles';
import { Suspense } from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';
import {
  SquareTerminal, BrainCircuit, FileDiff, ShieldCheck,
  Network, ListChecks, Database, Activity,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

function hashStr(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x;
}

// Each provider family gets a hue; individual models within a family get a
// distinct lightness (keyed by a stable hash of the model name) so e.g.
// opus-4-6 / 4-7 / 4-8 are visibly different shades of the same green instead
// of one indistinguishable block.
function getModelColor(model: string): string {
  const m = model.toLowerCase();
  let hue = 265, sat = 45; // default: indigo/purple for unknown providers
  if (/claude|opus|sonnet|haiku/.test(m)) { hue = 145; sat = 55; }            // Anthropic — greens
  else if (/gpt|codex|davinci|^o[0-9]|[ -]o[0-9]/.test(m)) { hue = 215; sat = 48; } // OpenAI — blues
  else if (/qwen|llama|mistral|gemma|phi|deepseek|ollama|local/.test(m)) { hue = 32; sat = 70; } // local — ambers
  else if (/gemini|bard|palm/.test(m)) { hue = 280; sat = 50; }              // Google — violets
  const lights = [34, 42, 50, 58, 66, 74];
  const light = lights[hashStr(model) % lights.length];
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function getOverviewData(period: string) {
  const db = getDb();
  const cutoff = getPeriodMs(period);
  const whereClause = cutoff ? `WHERE started_at >= ${cutoff}` : '';
  const andClause = cutoff ? `AND s.started_at >= ${cutoff}` : '';

  const totals = db.prepare(`
    SELECT
      COUNT(*) as sessions,
      SUM(total_input_tokens) as input_tokens,
      SUM(total_output_tokens) as output_tokens,
      SUM(total_cache_read) as cache_read,
      SUM(tool_call_count) as tool_calls,
      SUM(turn_count) as turns,
      COUNT(DISTINCT project_path) as projects
    FROM sessions ${whereClause}
  `).get() as any;

  const modelUsage = db.prepare(`
    SELECT mu.model, SUM(mu.input_tokens + mu.output_tokens + mu.cache_read) as total_tokens
    FROM model_usage mu
    JOIN sessions s ON s.id = mu.session_id
    WHERE mu.model != '<synthetic>' ${andClause}
    GROUP BY mu.model ORDER BY total_tokens DESC LIMIT 8
  `).all() as any[];

  // Estimated API cost for the selected period, priced per model from
  // model_usage (the only table that carries cache_write per model).
  const costRows = db.prepare(`
    SELECT mu.model, SUM(mu.input_tokens) AS input, SUM(mu.output_tokens) AS output,
      SUM(mu.cache_read) AS cache_read, SUM(mu.cache_write) AS cache_write,
      SUM(mu.input_tokens + mu.output_tokens + mu.cache_read) AS total
    FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
    WHERE mu.model != '<synthetic>' ${andClause}
    GROUP BY mu.model
  `).all() as any[];
  let estCost = 0;
  let unpricedTokens = 0;
  for (const r of costRows) {
    const c = estimateCostUsd(r.model, { input: r.input || 0, output: r.output || 0, cacheRead: r.cache_read || 0, cacheWrite: r.cache_write || 0 });
    if (c === null) unpricedTokens += r.total || 0;
    else estCost += c;
  }

  const modelCount = db.prepare(`
    SELECT COUNT(DISTINCT mu.model) as c
    FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
    WHERE mu.model != '<synthetic>' ${andClause}
  `).get() as any;

  const agentStats = db.prepare(`
    SELECT agent, COUNT(*) as cnt,
      SUM(total_input_tokens + total_output_tokens + total_cache_read) as tokens,
      SUM(tool_call_count) as tools, MAX(started_at) as last_at
    FROM sessions ${whereClause} GROUP BY agent ORDER BY cnt DESC
  `).all() as any[];

  const trendRows = db.prepare(`
    SELECT strftime('%Y-%m', started_at / 1000, 'unixepoch') as month, agent, COUNT(*) as cnt
    FROM sessions ${whereClause} GROUP BY month, agent ORDER BY month ASC
  `).all() as any[];

  const agents = db.prepare(`SELECT DISTINCT agent FROM sessions ${whereClause}`).all() as any[];

  const sixMonthsAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const dailySessions = db.prepare(`
    SELECT date(started_at/1000, 'unixepoch') as day, COUNT(*) as cnt
    FROM sessions WHERE started_at >= ${sixMonthsAgo} GROUP BY day ORDER BY day ASC
  `).all() as any[];

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const dailySessionsSpark = db.prepare(`
    SELECT date(started_at/1000, 'unixepoch') as day, COUNT(*) as cnt
    FROM sessions WHERE started_at >= ${thirtyDaysAgo} GROUP BY day ORDER BY day ASC
  `).all() as any[];

  const dailyTokensSpark = db.prepare(`
    SELECT date(started_at/1000, 'unixepoch') as day,
      SUM(total_input_tokens + total_output_tokens + total_cache_read) as tokens
    FROM sessions WHERE started_at >= ${thirtyDaysAgo} GROUP BY day ORDER BY day ASC
  `).all() as any[];

  const dailyErrorsSpark = db.prepare(`
    SELECT date(tc.timestamp/1000, 'unixepoch') as day, COUNT(*) as cnt
    FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
    WHERE tc.is_error = 1 AND tc.timestamp >= ${thirtyDaysAgo} GROUP BY day ORDER BY day ASC
  `).all() as any[];

  const repos = db.prepare(`
    SELECT name, path, total_tokens, session_count, last_session_at
    FROM repositories WHERE total_tokens > 0 ORDER BY total_tokens DESC LIMIT 15
  `).all() as any[];

  const recentSessions = db.prepare(`
    SELECT id, title, agent, model_primary, total_input_tokens, total_output_tokens,
      total_cache_read, duration_ms, tool_call_count, turn_count, started_at,
      project_path, first_user_message
    FROM sessions ${whereClause} ORDER BY started_at DESC LIMIT 10
  `).all() as any[];

  const errorTotals = db.prepare(`
    SELECT COUNT(*) as total_errors, COUNT(DISTINCT tc.session_id) as sessions_with_errors
    FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
    WHERE tc.is_error = 1 ${andClause}
  `).get() as any;

  const lastCollection = db.prepare(`
    SELECT completed_at, source, sessions_added FROM collection_runs
    ORDER BY started_at DESC LIMIT 1
  `).get() as any;

  const repoCount = db.prepare(`SELECT COUNT(*) as cnt FROM repositories`).get() as any;

  const ruleErrors = db.prepare(`
    SELECT COUNT(*) as cnt FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
    WHERE tc.is_error = 1 ${andClause}
  `).get() as any;

  // Active coding time: stitch every event (message + tool call) per session in
  // time order and sum the gaps between consecutive events, but DROP any gap
  // longer than the idle cap — those are breaks, not work. This measures real
  // hands-on runtime, not wall-clock (ended_at − started_at), which would count
  // a session left open overnight as a full day of "coding".
  const IDLE_CAP_MS = 5 * 60 * 1000;
  const activeTime = db.prepare(`
    WITH ev AS (
      SELECT m.session_id AS sid, m.timestamp AS ts
      FROM messages m JOIN sessions s ON s.id = m.session_id WHERE 1=1 ${andClause}
      UNION ALL
      SELECT tc.session_id AS sid, tc.timestamp AS ts
      FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id WHERE 1=1 ${andClause}
    ),
    gaps AS (
      SELECT sid, ts - LAG(ts) OVER (PARTITION BY sid ORDER BY ts) AS gap FROM ev
    )
    SELECT
      COALESCE(SUM(CASE WHEN gap > 0 AND gap <= ${IDLE_CAP_MS} THEN gap ELSE 0 END), 0) AS active_ms,
      COUNT(DISTINCT sid) AS sessions
    FROM gaps
  `).get() as any;

  // AI lines edited: file_events are agent-driven edits/writes/creates, so every
  // line here was touched by an AI. lines_added = written, lines_removed = deleted.
  const aiLines = db.prepare(`
    SELECT
      COALESCE(SUM(fe.lines_added), 0) AS added,
      COALESCE(SUM(fe.lines_removed), 0) AS removed,
      COUNT(DISTINCT fe.session_id) AS sessions
    FROM file_events fe JOIN sessions s ON s.id = fe.session_id
    WHERE fe.op IN ('edit', 'write', 'create') ${andClause}
  `).get() as any;

  return {
    totals, modelUsage, modelCount, agentStats, trendRows,
    agents: agents.map((a: any) => a.agent),
    dailySessions, dailySessionsSpark, dailyTokensSpark, dailyErrorsSpark,
    repos, recentSessions, errorTotals, lastCollection, repoCount,
    ruleErrors, activeTime, aiLines, estCost, unpricedTokens,
  };
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  // No explicit ?period= in the URL → fall back to the user's saved default.
  const { period: periodParam } = await searchParams;
  const period = periodParam || readUserConfig().default_period;
  const {
    totals, modelUsage, modelCount, agentStats, trendRows, agents,
    dailySessions, dailySessionsSpark, dailyTokensSpark, dailyErrorsSpark,
    repos, recentSessions, errorTotals, lastCollection, repoCount, ruleErrors,
    activeTime, aiLines, estCost, unpricedTokens,
  } = getOverviewData(period);

  const totalTokens = (totals.input_tokens || 0) + (totals.output_tokens || 0) + (totals.cache_read || 0);
  // The ring's slices come from model_usage; its center and the distribution
  // percentages must use the SAME basis so the center equals the sum of slices
  // and the shares total 100% (the sessions-based totalTokens differs slightly
  // because some sessions log no per-model breakdown).
  const ringTotal = modelUsage.reduce((a: number, m: any) => a + (m.total_tokens || 0), 0);
  const maxAgentSessions = agentStats[0]?.cnt || 1;
  const barData = buildBarData(trendRows, agents);

  const ringSegments = modelUsage.map((m: any) => ({
    key: m.model,
    value: m.total_tokens,
    color: getModelColor(m.model),
    label: m.model.replace('claude-', '').replace('-20250514', ''),
    href: `/sessions?model=${encodeURIComponent(m.model)}`,
  }));

  const heatmapData = dailySessions.map((d: any) => ({ date: d.day, value: d.cnt }));
  const sessionSparkData = dailySessionsSpark.map((d: any) => d.cnt);
  const tokenSparkData = dailyTokensSpark.map((d: any) => d.tokens);
  const errorSparkData = dailyErrorsSpark.map((d: any) => d.cnt);

  if (totals.sessions === 0) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Your agents, summarized</h1>
            <p className="page-sub">Tokens, tools, models, and errors from every coding agent — read locally, no telemetry</p>
          </div>
        </div>
        <EmptyState
          icon="database"
          title="No sessions yet"
          description="Run `agentdx collect` to ingest your coding-agent history and get started."
          action={{ label: 'Collector status', href: '/collector' }}
        />
      </div>
    );
  }

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Your agents, summarized</h1>
          <p className="page-sub">Tokens, tools, models, and errors from every coding agent — read locally, no telemetry</p>
        </div>
        <div className="page-head-actions">
          <RefreshButton />
          <Suspense><PeriodSelector defaultPeriod={period} /></Suspense>
        </div>
      </div>

      {/* First-run hint — only while history is still thin */}
      {totals.sessions > 0 && totals.sessions < 5 && (
        <div className="card mb-20" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 18 }}>👋</span>
          <div className="f13" style={{ flex: 1 }}>
            <strong>New here?</strong> You have {totals.sessions} session{totals.sessions === 1 ? '' : 's'} so far. Run <code className="mono">agentdx collect</code> regularly (or <code className="mono">agentdx watch</code>) to build up history — the charts get sharper with more data.
          </div>
          <Link href="/collector" className="btn btn-sm">Collector →</Link>
        </div>
      )}

      {/* Evidence pipeline */}
      <ErrorBoundary fallbackTitle="Evidence map failed to render">
      <div className="card mb-16">
        <div className="card-head">
          <div>
            <h3 className="card-title">Evidence map</h3>
            <p className="card-sub">click any node to drill into source evidence</p>
          </div>
        </div>
        <div className="card-pad">
          <SignalFlow nodes={[
            { label: 'Local sources', value: lastCollection ? '1' : '0', detail: lastCollection ? `last: ${timeAgo(lastCollection.completed_at)}` : 'not collected', href: '/collector', tone: 'info', icon: <Database size={16} /> },
            { label: 'Sessions', value: fmtNum(totals.sessions), detail: `${agents.length} agent${agents.length !== 1 ? 's' : ''}`, href: '/sessions', tone: 'accent', icon: <SquareTerminal size={16} /> },
            { label: 'Tool calls', value: fmtNum((totals.tool_calls || 0)), detail: `across ${fmtNum(repoCount.cnt)} repositories`, href: '/repositories', tone: 'pos', icon: <FileDiff size={16} /> },
            { label: 'Risk', value: fmtNum(errorTotals.total_errors), detail: `${errorTotals.sessions_with_errors} sessions affected`, href: '/risk', tone: errorTotals.total_errors > 0 ? 'warn' : 'pos', icon: <ShieldCheck size={16} /> },
            { label: 'Report', value: 'Export', detail: 'generate report', href: '/reports', tone: 'neutral', icon: <Activity size={16} /> },
          ]} />
        </div>
      </div>
      </ErrorBoundary>

      {/* Drilldown tiles */}
      <div className="mb-16">
        <DrilldownTiles tiles={[
          { label: 'Sessions', value: fmtNum(totals.sessions), detail: `across ${totals.projects} projects`, href: '/sessions', icon: <SquareTerminal size={18} />, tone: 'accent' },
          { label: 'Models', value: `${modelCount.c} models`, detail: fmtTok(totalTokens) + ' tokens', href: '/models', icon: <BrainCircuit size={18} />, tone: 'info' },
          { label: 'Repositories', value: fmtNum(repoCount.cnt), detail: `${fmtNum(totals.tool_calls || 0)} tool calls`, href: '/repositories', icon: <FileDiff size={18} />, tone: 'pos' },
          { label: 'Rules & policy', value: fmtNum(ruleErrors.cnt) + ' errors', detail: `${errorTotals.sessions_with_errors} sessions`, href: '/risk', icon: <ListChecks size={18} />, tone: ruleErrors.cnt > 0 ? 'warn' : 'pos' },
          { label: 'Risk signals', value: fmtNum(errorTotals.total_errors), detail: 'review needed', href: '/risk', icon: <ShieldCheck size={18} />, tone: errorTotals.total_errors > 0 ? 'neg' : 'pos' },
          { label: 'Remote control', value: '—', detail: 'browser/shell audit', href: '/remote-control', icon: <Network size={18} />, tone: 'neutral' },
        ]} />
      </div>

      {/* Effort: real hands-on time + code the AI actually wrote + what it would cost */}
      <ErrorBoundary fallbackTitle="Effort metrics failed to render">
      <div className="grid g-3 mb-20">
        <Link href="/sessions" className="card stat" style={{ textDecoration: 'none' }}>
          <div className="stat-label"><Activity size={13} /> Active coding time</div>
          <div className="stat-value" style={{ fontSize: 28 }}>{fmtDuration(activeTime.active_ms || 0)}</div>
          <div className="f12 muted" style={{ marginTop: 4 }}>
            hands-on runtime across {fmtNum(activeTime.sessions || 0)} session{activeTime.sessions === 1 ? '' : 's'} · idle gaps &gt; 5 min excluded
          </div>
          <div className="metric-source">source: message + tool-call timeline</div>
        </Link>
        <Link href="/oversight" className="card stat" style={{ textDecoration: 'none' }}>
          <div className="stat-label"><FileDiff size={13} /> Lines edited by AI</div>
          <div className="stat-value" style={{ fontSize: 28 }}>
            {fmtNum(aiLines.added || 0)}
            <span className="f13 muted" style={{ marginLeft: 8, fontWeight: 400 }}>+added</span>
            <span className="f13 muted" style={{ marginLeft: 10 }}>−{fmtNum(aiLines.removed || 0)}</span>
          </div>
          <div className="f12 muted" style={{ marginTop: 4 }}>
            net {fmtNum((aiLines.added || 0) - (aiLines.removed || 0))} lines · {fmtNum(aiLines.sessions || 0)} session{aiLines.sessions === 1 ? '' : 's'} with captured edits
          </div>
          <div className="metric-source">source: file_events (edit · write · create)</div>
        </Link>
        <Link href="/models" className="card stat" style={{ textDecoration: 'none' }}>
          <div className="stat-label"><BrainCircuit size={13} /> Est. API cost</div>
          <div className="stat-value" style={{ fontSize: 28 }}>~{fmtUsd(estCost)}</div>
          <div className="f12 muted" style={{ marginTop: 4 }}>
            what this usage would cost at API list prices · local models $0
            {unpricedTokens > 0 && <> · {fmtTok(unpricedTokens)} tokens unpriced</>}
          </div>
          <div className="metric-source">source: model_usage × public list prices</div>
        </Link>
      </div>
      </ErrorBoundary>

      {/* Row 1: Ring chart + Sparkline tiles */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '280px 1fr' }}>
        <ErrorBoundary fallbackTitle="Model ring chart failed to render">
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
          <RingChart
            segments={ringSegments}
            size={220}
            strokeWidth={30}
            centerValue={fmtTok(ringTotal)}
            centerLabel={`${modelCount.c} models`}
            showLegend={true}
          />
        </div>
        </ErrorBoundary>

        <div className="grid g-3" style={{ alignContent: 'stretch' }}>
          <ErrorBoundary fallbackTitle="Sessions sparkline failed">
          <div className="card stat" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <div className="stat-label"><SquareTerminal size={13} /> Sessions (30d)</div>
              <div className="stat-value" style={{ fontSize: 26 }}>{fmtNum(sessionSparkData.reduce((a, b) => a + b, 0))}</div>
              <div className="metric-source">source: local SQLite + history</div>
            </div>
            <div style={{ flex: 1, minHeight: 88, marginTop: 14, display: 'flex' }}>
              <Sparkline data={sessionSparkData.length >= 2 ? sessionSparkData : [0, 0]} width={220} height={80} responsive />
            </div>
          </div>
          </ErrorBoundary>
          <ErrorBoundary fallbackTitle="Tokens sparkline failed">
          <div className="card stat" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <div className="stat-label"><BrainCircuit size={13} /> Tokens (30d)</div>
              <div className="stat-value" style={{ fontSize: 26 }}>{fmtTok(tokenSparkData.reduce((a, b) => a + b, 0))}</div>
              <div className="metric-source">source: sessions table</div>
            </div>
            <div style={{ flex: 1, minHeight: 88, marginTop: 14, display: 'flex' }}>
              <Sparkline data={tokenSparkData.length >= 2 ? tokenSparkData : [0, 0]} width={220} height={80} responsive color="var(--info)" />
            </div>
          </div>
          </ErrorBoundary>
          <ErrorBoundary fallbackTitle="Errors sparkline failed">
          <div className="card stat" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <div className="stat-label"><ShieldCheck size={13} /> Errors (30d)</div>
              <div className="stat-value" style={{ fontSize: 26 }}>{fmtNum(errorSparkData.reduce((a, b) => a + b, 0))}</div>
              <div className="metric-source">source: tool_calls is_error</div>
            </div>
            <div style={{ flex: 1, minHeight: 88, marginTop: 14, display: 'flex' }}>
              <Sparkline data={errorSparkData.length >= 2 ? errorSparkData : [0, 0]} width={220} height={80} responsive color="var(--neg)" />
            </div>
          </div>
          </ErrorBoundary>
        </div>
      </div>

      {/* Row 2: Activity heatmap */}
      <ErrorBoundary fallbackTitle="Activity heatmap failed to render">
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Activity heatmap</h3>
            <p className="card-sub">sessions per day · last 6 months</p>
          </div>
          <div className="right">
            <Link href="/sessions" className="lnk f12">All sessions ›</Link>
          </div>
        </div>
        <div className="card-pad" style={{ overflowX: 'auto' }}>
          <HeatmapGrid data={heatmapData} weeks={26} cellSize={13} />
        </div>
      </div>
      </ErrorBoundary>

      {/* Row 3: Repos ranked + Trend chart */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <ErrorBoundary fallbackTitle="Repositories chart failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Repositories</h3>
              <p className="card-sub">ranked by token usage &middot; click to drill down</p>
            </div>
            <div className="right"><Link href="/repositories" className="lnk f12">All repos ›</Link></div>
          </div>
          <div className="card-pad">
            {repos.length > 0 ? (
              <div className="col-flex gap-14">
                {repos.filter((r: any) => r.total_tokens > 0).slice(0, 6).map((r: any) => {
                  const maxTok = repos[0]?.total_tokens || 1;
                  const pct = (r.total_tokens / maxTok) * 100;
                  return (
                    <Link key={r.path} href={`/sessions?project=${encodeURIComponent(r.path)}`}>
                      <div className="row between mb-4">
                        <span className="mono fw6 f13">{r.name}</span>
                        <span className="mono f12 fw6">{fmtTok(r.total_tokens)}</span>
                      </div>
                      <div className="meter">
                        <div className="fill" style={{ width: `${Math.max(pct, 2)}%` }} />
                      </div>
                      <div className="f12 muted" style={{ marginTop: 2 }}>{fmtNum(r.session_count)} sessions</div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <span className="f13 muted">No repository data</span>
            )}
          </div>
        </div>
        </ErrorBoundary>

        <ErrorBoundary fallbackTitle="Activity trend chart failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Activity trend</h3>
              <p className="card-sub">sessions per month · by agent</p>
            </div>
          </div>
          <div className="card-pad">
            {barData.length > 0 ? (
              <BarChart data={barData} height={220} />
            ) : (
              <span className="f13 muted">No data for this period</span>
            )}
          </div>
        </div>
        </ErrorBoundary>
      </div>

      {/* Row 4: Agents + Models breakdown */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <ErrorBoundary fallbackTitle="Agents chart failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Agents</h3>
              <p className="card-sub">sessions per agent</p>
            </div>
            <div className="right"><Link href="/agents" className="lnk f12">Details ›</Link></div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-16">
              {agentStats.map((a: any) => (
                <Link key={a.agent} href={`/sessions?agent=${encodeURIComponent(a.agent)}`}>
                  <div className="row between mb-4">
                    <span className="tag-mono">{a.agent}</span>
                    <span className="mono f13 fw6">{a.cnt}</span>
                  </div>
                  <div className="meter">
                    <div className="fill" style={{ width: `${(a.cnt / maxAgentSessions) * 100}%`, background: agentColor(a.agent) }} />
                  </div>
                  <div className="f12 muted" style={{ marginTop: 2 }}>{fmtTok(a.tokens)} tokens · {fmtNum(a.tools)} tools</div>
                </Link>
              ))}
            </div>
          </div>
        </div>
        </ErrorBoundary>

        <ErrorBoundary fallbackTitle="Model distribution chart failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Model distribution</h3>
              <p className="card-sub">token share per model</p>
            </div>
            <div className="right"><Link href="/models" className="lnk f12">Details ›</Link></div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-12">
              {modelUsage.map((m: any) => {
                const pct = ringTotal > 0 ? ((m.total_tokens / ringTotal) * 100).toFixed(1) : '0';
                return (
                  <Link key={m.model} href={`/sessions?model=${encodeURIComponent(m.model)}`}>
                    <div className="row between mb-4">
                      <span className="row gap-8">
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: getModelColor(m.model), display: 'inline-block' }} />
                        <span className="tag-model">{m.model.replace('claude-', '').replace('-20250514', '')}</span>
                      </span>
                      <span className="mono f12 fw6">{pct}%</span>
                    </div>
                    <div className="meter">
                      <div className="fill" style={{ width: `${pct}%`, background: getModelColor(m.model) }} />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
        </ErrorBoundary>
      </div>

      {/* Transparency strip */}
      <div className="card mb-16" style={{ padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', fontSize: 12.5 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="live-dot" />
          <span className="fw6">Collector idle</span>
        </span>
        <span className="muted">Capture: local-only</span>
        <span className="muted">Credentials never copied</span>
        {lastCollection && <span className="muted">Last sync: {timeAgo(lastCollection.completed_at)}</span>}
        <Link href="/collector" className="lnk" style={{ marginLeft: 'auto', fontSize: 12.5 }}>Collector status ›</Link>
      </div>

      {/* Collapsible recent sessions */}
      <div className="card">
        <Collapsible title="Recent sessions" count={recentSessions.length}>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Agent</th>
                  <th>Model</th>
                  <th className="num">Tokens</th>
                  <th className="num">Tools</th>
                  <th className="num">Duration</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recentSessions.map((s: any) => (
                  <tr key={s.id} className="clickable">
                    <td>
                      <Link href={`/sessions/${s.id}`} style={{ display: 'block' }}>
                        <span className="hash fw6" style={{ color: 'var(--text)' }}>{s.id.slice(0, 8)}</span>
                        <br />
                        <span className="f12 subtle">{s.title || s.first_user_message?.slice(0, 50) || '—'}</span>
                      </Link>
                    </td>
                    <td><span className="tag-mono">{s.agent}</span></td>
                    <td><span className="tag-model">{s.model_primary || '—'}</span></td>
                    <td className="num">{fmtTok((s.total_input_tokens || 0) + (s.total_output_tokens || 0) + (s.total_cache_read || 0))}</td>
                    <td className="num">{s.tool_call_count}</td>
                    <td className="num">{fmtDuration(s.duration_ms)}</td>
                    <td><span className="f12 muted">{timeAgo(s.started_at)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Collapsible>
      </div>

      {/* Quick links */}
      <div className="row gap-16 mt-20">
        <Link href="/sessions" className="btn">All sessions</Link>
        <Link href="/risk" className="btn">Risk overview</Link>
        <Link href="/reports" className="btn btn-primary">Generate report</Link>
      </div>
    </div>
  );
}
