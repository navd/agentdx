import { getDb, fmtTok, fmtNum, fmtDuration, timeAgo, getErrorSignalAgents } from '@/lib/db';
import Link from 'next/link';
import { KindFilter } from '@/components/kind-filter';
import { Collapsible } from '@/components/collapsible';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';

export const dynamic = 'force-dynamic';

function getAgentsData() {
  const db = getDb();

  const summary = db.prepare(`
    SELECT COUNT(DISTINCT agent) as active_agents, COUNT(*) as total_sessions
    FROM sessions
  `).get() as any;
  const toolCallTotal = (db.prepare('SELECT COUNT(*) as cnt FROM tool_calls').get() as any).cnt;
  summary.total_tool_calls = toolCallTotal;

  const modelCount = db.prepare(
    "SELECT COUNT(DISTINCT model) as c FROM model_usage WHERE model != '<synthetic>'"
  ).get() as any;

  const agents = db.prepare(`
    SELECT
      s.agent,
      COUNT(*) as session_count,
      SUM(s.total_input_tokens + s.total_output_tokens + s.total_cache_read) as total_tokens,
      SUM(s.total_cache_read) as cache_read,
      SUM(s.tool_call_count) as tool_calls,
      AVG(s.duration_ms) as avg_duration,
      MAX(s.started_at) as last_session
    FROM sessions s
    GROUP BY s.agent
    ORDER BY session_count DESC
  `).all() as any[];

  // Error count per agent
  const agentErrors = db.prepare(`
    SELECT s.agent, COUNT(tc.id) as errors
    FROM sessions s
    LEFT JOIN tool_calls tc ON tc.session_id = s.id AND tc.is_error = 1
    GROUP BY s.agent
  `).all() as any[];
  const errorMap = new Map(agentErrors.map((r: any) => [r.agent, r.errors]));

  const agentModels = db.prepare(`
    SELECT DISTINCT s.agent, mu.model
    FROM sessions s
    JOIN model_usage mu ON mu.session_id = s.id
    WHERE mu.model != '<synthetic>'
    ORDER BY s.agent, mu.model
  `).all() as any[];

  const modelsByAgent: Record<string, string[]> = {};
  for (const row of agentModels) {
    if (!modelsByAgent[row.agent]) modelsByAgent[row.agent] = [];
    if (!modelsByAgent[row.agent].includes(row.model)) modelsByAgent[row.agent].push(row.model);
  }

  const tools = db.prepare(`
    SELECT tool_name, COUNT(*) as cnt,
      SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as error_count
    FROM tool_calls GROUP BY tool_name ORDER BY cnt DESC LIMIT 15
  `).all() as any[];

  const toolsDetailed = db.prepare(`
    SELECT tc.tool_name, COUNT(*) as cnt,
      SUM(CASE WHEN tc.is_error = 1 THEN 1 ELSE 0 END) as errors,
      COUNT(DISTINCT s.agent) as agent_count,
      COUNT(DISTINCT s.id) as session_count
    FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    GROUP BY tc.tool_name ORDER BY cnt DESC LIMIT 20
  `).all() as any[];

  const toolSummary = db.prepare(`
    SELECT tool_name, COUNT(*) as cnt,
      SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors,
      AVG(duration_ms) as avg_dur
    FROM tool_calls GROUP BY tool_name ORDER BY cnt DESC
  `).all() as any[];

  const matrixData = db.prepare(`
    SELECT s.agent, tc.tool_name, COUNT(*) as cnt
    FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    GROUP BY s.agent, tc.tool_name ORDER BY cnt DESC
  `).all() as any[];

  // Skills / slash-commands (distinct from tools).
  const skillsTop = db.prepare(`
    SELECT skill, COUNT(*) as cnt, COUNT(DISTINCT session_id) as sessions
    FROM skill_invocations GROUP BY skill ORDER BY cnt DESC LIMIT 12
  `).all() as any[];
  const skillMatrixData = db.prepare(`
    SELECT s.agent, si.skill, COUNT(*) as cnt
    FROM skill_invocations si
    JOIN sessions s ON s.id = si.session_id
    GROUP BY s.agent, si.skill ORDER BY cnt DESC
  `).all() as any[];

  const errorSignal = getErrorSignalAgents(db);

  // Sub-agent activity (Task tools + Workflow agents). Guarded — table is
  // absent on databases collected before the feature.
  let subagents: any = { count: 0, tokens: 0, tools: 0, task: 0, workflow: 0, workflows: 0, sessions: 0, topWorkflows: [] as any[] };
  try {
    const t = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(input_tokens+output_tokens+cache_read),0) AS tokens,
        COALESCE(SUM(tool_call_count),0) AS tools,
        SUM(CASE WHEN kind='task' THEN 1 ELSE 0 END) AS task,
        SUM(CASE WHEN kind='workflow' THEN 1 ELSE 0 END) AS workflow,
        COUNT(DISTINCT workflow_id) AS workflows,
        COUNT(DISTINCT parent_session_id) AS sessions
      FROM subagents
    `).get() as any;
    const topWorkflows = db.prepare(`
      SELECT workflow_id, COUNT(*) AS agents, SUM(input_tokens+output_tokens+cache_read) AS tokens
      FROM subagents WHERE kind='workflow' AND workflow_id IS NOT NULL
      GROUP BY workflow_id ORDER BY tokens DESC LIMIT 5
    `).all() as any[];
    subagents = { ...t, topWorkflows };
  } catch { /* pre-feature DB */ }

  return { summary, modelCount, agents, errorMap, errorSignal, modelsByAgent, tools, toolsDetailed, toolSummary, matrixData, skillsTop, skillMatrixData, subagents };
}

const AGENT_COLORS: Record<string, string> = {
  'claude-code': 'var(--chart-1)',
  'cowork': '#C15F3C',
  'codex': 'var(--chart-3)',
  'cursor': 'var(--chart-2)',
  'antigravity': 'var(--chart-4)',
  vscode: 'var(--chart-5)',
  continue: '#8B5CF6',
  opencode: '#EC4899',
};

export default function AgentsPage() {
  const { summary, modelCount, agents, errorMap, errorSignal, modelsByAgent, tools, toolsDetailed, toolSummary, matrixData, skillsTop, skillMatrixData, subagents } = getAgentsData();

  if (agents.length === 0) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Agents &amp; Skills</h1>
            <p className="page-sub">No agents detected</p>
          </div>
        </div>
        <EmptyState
          icon="square-terminal"
          title="No agents found"
          description="No coding-agent sessions have been collected yet. Run `agentdx collect` to ingest agent history."
          action={{ label: 'Collector status', href: '/collector' }}
        />
      </div>
    );
  }

  const maxToolCount = tools[0]?.cnt || 1;
  const maxSessions = agents[0]?.session_count || 1;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Agents &amp; Skills</h1>
          <p className="page-sub">{summary.active_agents} agents · {fmtNum(summary.total_tool_calls)} tool calls</p>
        </div>
      </div>

      {/* Bubble visualization - agents as proportional circles */}
      <ErrorBoundary fallbackTitle="Agent overview failed to render">
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Agent overview</h3>
            <p className="card-sub">sized by sessions · colored by agent · click to drill down</p>
          </div>
        </div>
        <div className="card-pad" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 32, padding: '32px 20px', flexWrap: 'wrap' }}>
          {agents.map((a: any) => {
            const errors = errorMap.get(a.agent) || 0;
            const hasSignal = errorSignal.has(a.agent);
            const errorRate = a.tool_calls > 0 ? errors / a.tool_calls : 0;
            const size = 60 + Math.round((a.session_count / maxSessions) * 100);
            const color = AGENT_COLORS[a.agent] || 'var(--warn)';
            return (
              <Link key={a.agent} href={`/sessions?agent=${encodeURIComponent(a.agent)}`} style={{ textDecoration: 'none' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: size, height: size, borderRadius: '50%',
                    background: color, opacity: 0.85,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', transition: 'transform 0.15s', cursor: 'pointer',
                  }}>
                    <span style={{ fontSize: Math.max(14, size / 5), fontWeight: 700, fontFamily: 'var(--mono)' }}>{a.session_count}</span>
                    <span style={{ fontSize: 10, opacity: 0.8 }}>sessions</span>
                  </div>
                  <span className="tag-mono" style={{ fontSize: 12 }}>{a.agent}</span>
                  <span className="f12 muted">
                    {fmtTok(a.total_tokens || 0)}
                    {(a.total_tokens || 0) === 0
                      ? <span title="This source doesn't record token counts, so 0 means 'not recorded', not 'no usage'." style={{ color: 'var(--warn)', cursor: 'help' }}> ⚠ not recorded</span>
                      : (a.cache_read || 0) === 0
                        ? <span title="Logs no cache-read tokens, so its token total is undercounted vs cache-heavy agents — don't compare directly." style={{ color: 'var(--warn)', cursor: 'help' }}>⚠</span>
                        : null}
                    {' · '}{!hasSignal ? 'no error signal' : errorRate > 0 ? `${(errorRate * 100).toFixed(1)}% errors` : 'no errors'}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
      </ErrorBoundary>

      {/* Sub-agent activity */}
      {subagents.count > 0 && (
        <ErrorBoundary fallbackTitle="Sub-agent metrics failed to render">
        <div className="card mb-20">
          <div className="card-head">
            <div>
              <h3 className="card-title">Sub-agent activity</h3>
              <p className="card-sub">Task tools &amp; Workflow agents spawned by sessions · tokens already counted in the parent</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="grid g-4" style={{ marginBottom: subagents.topWorkflows.length ? 18 : 0 }}>
              <div className="stat"><div className="stat-label">Sub-agents</div><div className="stat-value" style={{ fontSize: 24 }}>{fmtNum(subagents.count)}</div><div className="stat-foot">{subagents.task} task · {subagents.workflow} workflow</div></div>
              <div className="stat"><div className="stat-label">Tokens</div><div className="stat-value" style={{ fontSize: 24 }}>{fmtTok(subagents.tokens)}</div><div className="stat-foot">rolled into parent sessions</div></div>
              <div className="stat"><div className="stat-label">Tool calls</div><div className="stat-value" style={{ fontSize: 24 }}>{fmtNum(subagents.tools)}</div><div className="stat-foot">by sub-agents</div></div>
              <div className="stat"><div className="stat-label">Reach</div><div className="stat-value" style={{ fontSize: 24 }}>{fmtNum(subagents.workflows)}</div><div className="stat-foot">workflows · {subagents.sessions} sessions</div></div>
            </div>
            {subagents.topWorkflows.length > 0 && (
              <div>
                <p className="f12 muted" style={{ marginBottom: 8 }}>Top workflows by token spend</p>
                <div className="col-flex gap-6">
                  {subagents.topWorkflows.map((w: any) => (
                    <div key={w.workflow_id} className="row between" style={{ fontSize: 12 }}>
                      <span className="mono muted"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6, background: '#8B5CF6', verticalAlign: 'middle' }} />{w.workflow_id}</span>
                      <span className="mono">{w.agents} agents · {fmtTok(w.tokens)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        </ErrorBoundary>
      )}

      {/* Agent × Skill matrix */}
      <ErrorBoundary fallbackTitle="Agent x Skill matrix failed to render">
      {(() => {
        const agentNames = agents.map((a: any) => a.agent);
        const topSkillNames = skillsTop.map((sk: any) => sk.skill);
        const matrix: Record<string, Record<string, number>> = {};
        let maxCnt = 1;
        for (const row of skillMatrixData) {
          if (!topSkillNames.includes(row.skill)) continue;
          if (!matrix[row.skill]) matrix[row.skill] = {};
          matrix[row.skill][row.agent] = row.cnt;
          if (row.cnt > maxCnt) maxCnt = row.cnt;
        }
        if (topSkillNames.length === 0) return null;
        return (
          <div className="card mb-20">
            <div className="card-head">
              <div>
                <h3 className="card-title">Agent × Skill matrix</h3>
                <p className="card-sub">skill / slash-command invocations per agent</p>
              </div>
              <div className="right row gap-12 f12">
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent-soft)', display: 'inline-block' }} /> Low</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)', opacity: 0.5, display: 'inline-block' }} /> Med</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)', display: 'inline-block' }} /> High</span>
              </div>
            </div>
            <div className="table-wrap">
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>Skill</th>
                    {agentNames.map(a => <th key={a} style={{ textAlign: 'center', minWidth: 80 }}>{a}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {topSkillNames.map(skill => (
                    <tr key={skill}>
                      <td style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}><span className="tag-mono">{skill}</span></td>
                      {agentNames.map(agent => {
                        const cnt = matrix[skill]?.[agent] || 0;
                        const intensity = cnt / maxCnt;
                        return (
                          <td key={agent} style={{ textAlign: 'center' }}>
                            {cnt > 0 ? (
                              <span style={{
                                display: 'inline-block', width: 22, height: 22, borderRadius: 4, lineHeight: '22px',
                                fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)',
                                // Below the white-text break, keep the tint LIGHT (≤20% accent on
                                // --surface) so the dark count stays readable; only the saturated
                                // fill (>0.5) flips to white text. Mid-range dark-on-medium was 1.2:1.
                                background: intensity > 0.5 ? 'var(--accent)' : `color-mix(in srgb, var(--accent) ${Math.round(Math.min(intensity, 0.5) * 40)}%, var(--surface))`,
                                color: intensity > 0.5 ? '#fff' : 'var(--text)',
                              }}>
                                {cnt > 999 ? Math.round(cnt / 1000) + 'K' : cnt}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--text-subtle)', fontSize: 11 }}>—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
      </ErrorBoundary>

      {/* Top tools with visual bars */}
      <ErrorBoundary fallbackTitle="Tools chart failed to render">
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Most used tools</h3>
            <p className="card-sub">frequency and error rates</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="col-flex gap-12">
            {tools.slice(0, 10).map((t: any) => {
              const errorRate = t.cnt > 0 ? ((t.error_count / t.cnt) * 100).toFixed(1) : '0';
              return (
                <div key={t.tool_name}>
                  <div className="row between mb-4">
                    <span className="tag-mono">{t.tool_name}</span>
                    <span className="row gap-12">
                      <span className="mono f12 fw6">{fmtNum(t.cnt)}</span>
                      {t.error_count > 0 && <span className="mono f12" style={{ color: 'var(--neg)' }}>{errorRate}% err</span>}
                    </span>
                  </div>
                  <div className="meter">
                    <div className="fill" style={{ width: `${(t.cnt / maxToolCount) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      </ErrorBoundary>

      {/* Collapsible agents table */}
      <div className="card mb-20">
        <Collapsible title="Agent details" count={agents.length}>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="num">Sessions</th>
                  <th className="num">Tokens</th>
                  <th className="num">Tool calls</th>
                  <th>Models used</th>
                  <th className="num">Avg duration</th>
                  <th>Last session</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a: any) => {
                  const models = modelsByAgent[a.agent] || [];
                  return (
                    <tr key={a.agent}>
                      <td>
                        <Link href={`/sessions?agent=${encodeURIComponent(a.agent)}`}>
                          <span className="tag-mono">{a.agent}</span>
                        </Link>
                      </td>
                      <td className="num">{fmtNum(a.session_count)}</td>
                      <td className="num">{fmtTok(a.total_tokens || 0)}</td>
                      <td className="num">{fmtNum(a.tool_calls || 0)}</td>
                      <td>{models.length > 0 ? models.map(m => <span key={m} className="tag-model" style={{ marginRight: 4 }}>{m}</span>) : <span className="subtle">—</span>}</td>
                      <td className="num">{fmtDuration(a.avg_duration)}</td>
                      <td><span className="f12 muted">{timeAgo(a.last_session)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Collapsible>
      </div>

      {/* Skills / Tools detailed table */}
      <div className="card">
        <KindFilter tools={toolSummary} />
      </div>
    </div>
  );
}
