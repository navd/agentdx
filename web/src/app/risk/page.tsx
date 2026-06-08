import { getDb, fmtNum, fmtTok, fmtDuration, timeAgo, getErrorSignalAgents } from '@/lib/db';
import Link from 'next/link';
import { SeverityFilter } from '@/components/severity-filter';
import { GaugeChart } from '@/components/gauge-chart';
import { Collapsible } from '@/components/collapsible';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';
import { EventLogFilter } from '@/components/event-log-filter';

export const dynamic = 'force-dynamic';

function getRiskData() {
  const db = getDb();

  // Errors per month — honest count of error tool-calls (no fabricated
  // "resolved" series; a successful call is not a fixed bug).
  const errorsByMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', timestamp/1000, 'unixepoch') as month,
      COUNT(CASE WHEN is_error = 1 THEN 1 END) as errors,
      COUNT(*) as total
    FROM tool_calls
    WHERE timestamp IS NOT NULL
    GROUP BY month
    ORDER BY month DESC
    LIMIT 6
  `).all() as any[];

  // Total errors across all sessions
  const totalErrors = db.prepare(`
    SELECT COUNT(*) as cnt FROM tool_calls WHERE is_error = 1
  `).get() as any;

  // Sessions with errors
  const sessionsWithErrors = db.prepare(`
    SELECT COUNT(DISTINCT s.id) as cnt
    FROM sessions s
    JOIN tool_calls tc ON tc.session_id = s.id
    WHERE s.tool_call_count > 0 AND tc.is_error = 1
  `).get() as any;

  // Long sessions (> 2 hours)
  const longSessions = db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions WHERE duration_ms > 7200000
  `).get() as any;

  // High tool usage (> 100 calls)
  const highToolUsage = db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions WHERE tool_call_count > 100
  `).get() as any;

  // Risk sessions with error counts
  const riskSessions = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM tool_calls WHERE session_id = s.id AND is_error = 1) as error_count
    FROM sessions s
    WHERE tool_call_count > 0
    ORDER BY error_count DESC, duration_ms DESC
    LIMIT 30
  `).all() as any[];

  const findings = db.prepare(`
    SELECT tc.tool_name, tc.tool_output, tc.timestamp, tc.session_id, s.agent, s.project_path,
      CASE
        WHEN tc.tool_name IN ('Bash', 'exec_command') THEN 'Shell error'
        WHEN tc.tool_name IN ('Write', 'Edit', 'write_file', 'apply_patch') THEN 'File error'
        WHEN tc.tool_name IN ('Agent', 'TaskCreate') THEN 'Agent error'
        WHEN tc.tool_name IN ('WebFetch', 'WebSearch') THEN 'Web error'
        WHEN tc.tool_name IN ('Read', 'Grep', 'Glob') THEN 'Read error'
        ELSE 'Other error'
      END as category
    FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    WHERE tc.is_error = 1
    ORDER BY tc.timestamp DESC
    LIMIT 400
  `).all() as any[];

  const findingsByCategory = db.prepare(`
    SELECT
      CASE
        WHEN tool_name IN ('Bash', 'exec_command') THEN 'Shell errors'
        WHEN tool_name IN ('Write', 'Edit', 'write_file', 'apply_patch') THEN 'File write errors'
        WHEN tool_name IN ('Agent', 'TaskCreate') THEN 'Agent errors'
        WHEN tool_name IN ('WebFetch', 'WebSearch') THEN 'Web errors'
        WHEN tool_name IN ('Read', 'Grep', 'Glob') THEN 'Read errors'
        ELSE 'Other errors'
      END as category,
      COUNT(*) as cnt
    FROM tool_calls
    WHERE is_error = 1
    GROUP BY category
    ORDER BY cnt DESC
  `).all() as any[];

  const signal = getErrorSignalAgents(db);
  const allAgents = (db.prepare('SELECT DISTINCT agent FROM sessions').all() as any[]).map((r) => r.agent);
  const blindAgents = allAgents.filter((a) => !signal.has(a));

  // Real global denominator for the gauge (was dividing by the LIMIT-30 sample).
  const sessionsWithTools = (db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE tool_call_count > 0').get() as any).cnt || 0;

  // --- Policy/Rules data (folded in from the former Rules & Policy page) ---

  // KPI totals across all tool calls
  const kpi = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as error_count,
      COUNT(DISTINCT tool_name) as distinct_tools
    FROM tool_calls
  `).get() as any;

  // Error-prone tools, ranked by error count
  const errorTools = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) as cnt,
      SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors
    FROM tool_calls
    GROUP BY tool_name
    HAVING errors > 0
    ORDER BY errors DESC
    LIMIT 15
  `).all() as any[];

  const blockedCommands = db.prepare(`
    SELECT COUNT(*) as c FROM tool_calls WHERE is_error = 1 AND tool_name IN ('Bash', 'exec_command')
  `).get() as any;

  const blockedWrites = db.prepare(`
    SELECT COUNT(*) as c FROM tool_calls WHERE is_error = 1 AND tool_name IN ('Write', 'Edit', 'write_file', 'apply_patch')
  `).get() as any;

  // Policy event log — recent tool-call outcomes (observed, not enforced)
  const policyLog = db.prepare(`
    SELECT tc.tool_name, tc.is_error, tc.timestamp, tc.session_id,
      s.agent, s.project_path
    FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    ORDER BY tc.timestamp DESC
    LIMIT 30
  `).all() as any[];

  return {
    totalErrors: totalErrors.cnt || 0,
    sessionsWithErrors: sessionsWithErrors.cnt || 0,
    sessionsWithTools,
    longSessions: longSessions.cnt || 0,
    highToolUsage: highToolUsage.cnt || 0,
    riskSessions,
    findings,
    findingsByCategory,
    errorsByMonth: errorsByMonth.reverse(),
    blindAgents,
    kpi,
    errorTools,
    blockedCommands: blockedCommands.c,
    blockedWrites: blockedWrites.c,
    policyLog,
  };
}

// Classify an error by its actual output, not just the tool that raised it.
// Most "Shell errors" are benign retries (file-not-found, glob miss, user
// cancel) — flagging them all High is noise that buries the real failures.
const BENIGN = /(file does not exist|has not been read yet|has been modified since read|no matches found|no files matched|nothing to commit|already exists|cancelled|user doesn't want to proceed|tool use was rejected|not found: \*)/i;
const SEVERE = /(fatal:|permission denied|eacces|enospc|could not read username|unable to access|segfault|core dumped|killed|command not found|traceback|no solution found|paramvalidation|out of memory|cannot allocate)/i;

function classifySeverity(output: string | null): 'High' | 'Medium' | 'Low' {
  const t = output || '';
  if (BENIGN.test(t)) return 'Low';
  if (SEVERE.test(t)) return 'High';
  return 'Medium';
}

// Normalize an error message into a dedup key: drop ANSI, exit-code prefix,
// hex hashes and digits so "Exit code 1\nfoo 3a2f" and "Exit code 2\nfoo 9b1c"
// collapse to one finding.
function normalizeError(output: string | null): string {
  let t = (output || '')
    .replace(/\[[0-9;]*m/g, '')
    .replace(/^Exit code \d+\s*/i, '')
    .replace(/<\/?tool_use_error>/g, '')
    .trim();
  const firstLine = t.split('\n').find((l) => l.trim().length > 0) || t;
  return firstLine
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .slice(0, 80)
    .toLowerCase()
    .trim();
}

function computeRiskScore(session: any): number {
  const errorRatio = session.tool_call_count > 0
    ? (session.error_count / session.tool_call_count) * 50
    : 0;
  const durationHours = (session.duration_ms || 0) / 3600000;
  const durationScore = durationHours * 5;
  const heavyToolScore = session.tool_call_count > 100 ? 20 : 0;
  return errorRatio + durationScore + heavyToolScore;
}

export default function RiskPage() {
  const { totalErrors, sessionsWithErrors, sessionsWithTools, longSessions, highToolUsage, riskSessions, findings, findingsByCategory, errorsByMonth, blindAgents, kpi, errorTools, blockedCommands, blockedWrites, policyLog } = getRiskData();

  if (totalErrors === 0 && riskSessions.length === 0) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Risk, Quality &amp; Policy</h1>
            <p className="page-sub">Session risk indicators, quality metrics, and tool-call policy</p>
          </div>
        </div>
        <EmptyState
          icon="shield-check"
          title="No risk data"
          description="No error signals or risk indicators have been detected. Collect more sessions with `agentdx collect` to populate this view."
          action={{ label: 'View sessions', href: '/sessions' }}
        />
      </div>
    );
  }

  // Compute risk scores and category maximums for meter bars
  const sessionsWithScores = riskSessions.map((s: any) => ({
    ...s,
    riskScore: computeRiskScore(s),
  }));

  const maxRisk = Math.max(...sessionsWithScores.map((s: any) => s.riskScore), 1);

  // Category breakdown
  const categories = [
    { label: 'Sessions with errors', count: sessionsWithErrors },
    { label: 'Long sessions (>2h)', count: longSessions },
    { label: 'Heavy tool use (>100)', count: highToolUsage },
  ];
  const maxCategory = Math.max(...categories.map(c => c.count), 1);

  // Policy KPIs (carried over from the former Rules & Policy page).
  // "Sessions affected" reuses risk's sessionsWithErrors so the two views
  // don't show contradictory session-with-error counts.
  const totalCalls = kpi.total_calls || 0;
  const errorCount = kpi.error_count || 0;
  const errorRate = totalCalls > 0 ? ((errorCount / totalCalls) * 100).toFixed(1) : '0.0';
  const distinctTools = kpi.distinct_tools || 0;
  const maxErrors = errorTools[0]?.errors || 1;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Risk, Quality &amp; Policy</h1>
          <p className="page-sub">Session risk indicators, quality metrics, and tool-call policy</p>
        </div>
      </div>

      {blindAgents.length > 0 && (
        <div className="card card-pad mb-20" style={{ background: 'var(--surface-2)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 15 }}>ⓘ</span>
          <div className="f12" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
            Error metrics reflect only agents that record per-tool errors. <strong>{blindAgents.join(', ')}</strong> {blindAgents.length === 1 ? "doesn't" : "don't"} emit a tool-error signal, so {blindAgents.length === 1 ? 'it counts' : 'they count'} as zero-error here — not necessarily error-free.
          </div>
        </div>
      )}

      {/* HERO — Risk gauge + ONE unified KPI tile group (deduped across the
          former Risk strip, Policy DrilldownTiles, and Error breakdown card). */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '180px 1fr' }}>
        <ErrorBoundary fallbackTitle="Risk gauge failed to render">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 16px', textAlign: 'center' }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Sessions with errors</div>
          <GaugeChart
            value={sessionsWithTools > 0 ? Math.round((sessionsWithErrors / sessionsWithTools) * 100) : 0}
            label=""
            size={150}
          />
          <div className="f12 muted" style={{ marginTop: 6 }}>of {fmtNum(sessionsWithTools)} tool-active sessions</div>
        </div>
        </ErrorBoundary>
        <div className="grid g-4" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="card stat" style={{ padding: '15px 16px' }}>
            <div className="stat-label">Total calls</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(totalCalls)}</div>
            <div className="stat-foot">{distinctTools} distinct tools</div>
          </div>
          <div className="card stat" style={{ padding: '15px 16px' }}>
            <div className="stat-label">Errors</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(totalErrors)}</div>
            <div className="stat-foot">tool-call errors</div>
          </div>
          <div className="card stat" style={{ padding: '15px 16px' }}>
            <div className="stat-label">Error rate</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{errorRate}%</div>
            <div className="stat-foot">of all tool calls</div>
          </div>
          <div className="card stat" style={{ padding: '15px 16px' }}>
            <div className="stat-label">Sessions affected</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(sessionsWithErrors)}</div>
            <div className="stat-foot">with tool errors</div>
          </div>
          <div className="card stat" style={{ padding: '15px 16px' }}>
            <div className="stat-label">Shell errors</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(blockedCommands)}</div>
            <div className="stat-foot">failed commands</div>
          </div>
          <div className="card stat" style={{ padding: '15px 16px' }}>
            <div className="stat-label">Write errors</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(blockedWrites)}</div>
            <div className="stat-foot">file write failures</div>
          </div>
          <div className="card stat" style={{ padding: '15px 16px' }}>
            <div className="stat-label">Long sessions</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(longSessions)}</div>
            <div className="stat-foot">&gt; 2 hours</div>
          </div>
          <div className="card stat" style={{ padding: '15px 16px' }}>
            <div className="stat-label">High tool usage</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{fmtNum(highToolUsage)}</div>
            <div className="stat-foot">&gt; 100 tool calls</div>
          </div>
        </div>
      </div>

      {/* Findings by category + Category breakdown */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <ErrorBoundary fallbackTitle="Findings chart failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Findings by category</h3>
              <p className="card-sub">Error distribution by tool type</p>
            </div>
          </div>
          <div className="card-pad">
            {(() => {
              const maxFinding = findingsByCategory[0]?.cnt || 1;
              const severityColors: Record<string, string> = {
                'Shell errors': 'var(--neg)', 'File write errors': 'var(--warn)',
                'Agent errors': 'var(--neg)', 'Web errors': 'var(--info, #3B82F6)',
                'Read errors': 'var(--text-muted)', 'Other errors': 'var(--text-muted)',
              };
              return (
                <div className="col-flex gap-14">
                  {findingsByCategory.map((f: any) => (
                    <div key={f.category}>
                      <div className="row between mb-4">
                        <span className="f13 fw6">{f.category}</span>
                        <span className="mono f12 fw6">{f.cnt}</span>
                      </div>
                      <div className="meter">
                        <div className="fill" style={{ width: `${(f.cnt / maxFinding) * 100}%`, background: severityColors[f.category] || 'var(--accent)' }} />
                      </div>
                    </div>
                  ))}
                  {findingsByCategory.length === 0 && <span className="f13 muted">No errors found</span>}
                </div>
              );
            })()}
          </div>
        </div>
        </ErrorBoundary>

        <ErrorBoundary fallbackTitle="Category breakdown failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Category breakdown</h3>
              <p className="card-sub">Risk indicator distribution</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Risk category</th>
                  <th className="num">Count</th>
                  <th style={{ width: '50%' }}>Distribution</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.label}>
                    <td><span className="fw6">{c.label}</span></td>
                    <td className="num">{fmtNum(c.count)}</td>
                    <td>
                      <div className="meter">
                        <div className="fill" style={{ width: `${(c.count / maxCategory) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </ErrorBoundary>
      </div>

      {/* Errors per month — error tool-calls, with the in-month error rate */}
      <ErrorBoundary fallbackTitle="Errors-per-month chart failed to render">
      {errorsByMonth.length > 0 && (() => {
        const maxVal = Math.max(...errorsByMonth.map((r: any) => r.errors), 1);
        const slotW = 90;
        const chartWidth = errorsByMonth.length * slotW;
        const chartHeight = 160;
        const padTop = 24;
        const padBottom = 24;
        const barWidth = 34;

        return (
          <div className="card mb-20">
            <div className="card-head">
              <div>
                <h3 className="card-title">Errors per month</h3>
                <p className="card-sub">error tool calls, with the in-month error rate</p>
              </div>
            </div>
            <div className="card-pad">
              <svg
                width="100%"
                height={200}
                viewBox={`0 0 ${chartWidth} ${chartHeight + padTop + padBottom}`}
                preserveAspectRatio="xMidYMid meet"
                style={{ display: 'block' }}
              >
                {errorsByMonth.map((row: any, i: number) => {
                  const cx = i * slotW + slotW / 2;
                  const x = cx - barWidth / 2;
                  const h = (row.errors / maxVal) * chartHeight;
                  const rate = row.total > 0 ? ((row.errors / row.total) * 100).toFixed(1) : '0';
                  return (
                    <g key={row.month}>
                      <rect x={x} y={padTop + chartHeight - h} width={barWidth} height={h} rx={3} fill="var(--neg)" />
                      <text x={cx} y={padTop + chartHeight - h - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--text-muted)" fontFamily="var(--mono)">{row.errors}</text>
                      <text x={cx} y={padTop + chartHeight - h - 20} textAnchor="middle" fontSize={9} fill="var(--text-subtle)" fontFamily="var(--mono)">{rate}%</text>
                      <text x={cx} y={padTop + chartHeight + 16} textAnchor="middle" fontSize={11} fill="var(--text-muted)">{row.month}</text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        );
      })()}
      </ErrorBoundary>

      {/* Error-prone tools as visual bars */}
      <ErrorBoundary fallbackTitle="Error-prone tools chart failed to render">
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Error-prone tools</h3>
            <p className="card-sub">ranked by error count</p>
          </div>
        </div>
        <div className="card-pad">
          {errorTools.length > 0 ? (
            <div className="col-flex gap-14">
              {errorTools.map((t: any) => {
                const rate = t.cnt > 0 ? ((t.errors / t.cnt) * 100).toFixed(1) : '0.0';
                return (
                  <div key={t.tool_name}>
                    <div className="row between mb-4">
                      <span className="row gap-8">
                        <span className="tag-mono">{t.tool_name}</span>
                        <span className="mono f12" style={{ color: 'var(--neg)' }}>{rate}%</span>
                      </span>
                      <span className="mono f12 fw6">{fmtNum(t.errors)} / {fmtNum(t.cnt)}</span>
                    </div>
                    <div className="meter">
                      <div className="fill" style={{ width: `${(t.errors / maxErrors) * 100}%`, background: 'var(--neg)' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="f13 muted">No tool errors recorded</span>
          )}
        </div>
      </div>
      </ErrorBoundary>

      {/* Risk sessions table (collapsible) */}
      <div className="card mb-20">
        <Collapsible title="Risk sessions" count={sessionsWithScores.length}>
          <div className="table-wrap">
            <table className="tbl">
            <thead>
              <tr>
                <th>Session</th>
                <th>Agent</th>
                <th className="num">Errors</th>
                <th className="num">Tool calls</th>
                <th className="num">Duration</th>
                <th className="num">Tokens</th>
                <th>Project</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {sessionsWithScores.map((s: any) => {
                const totalTokens = (s.total_input_tokens || 0) + (s.total_output_tokens || 0) + (s.total_cache_read || 0);
                const projectName = s.project_path
                  ? s.project_path.split('/').pop()
                  : '';
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/sessions/${s.id}`}>
                        <span className="mono f12" style={{ color: 'var(--accent)' }}>
                          {String(s.id).slice(0, 8)}
                        </span>
                      </Link>
                    </td>
                    <td><span className="tag-mono">{s.agent}</span></td>
                    <td className="num">{fmtNum(s.error_count)}</td>
                    <td className="num">{fmtNum(s.tool_call_count || 0)}</td>
                    <td className="num">{fmtDuration(s.duration_ms)}</td>
                    <td className="num">{fmtTok(totalTokens)}</td>
                    <td><span className="f12 muted">{projectName}</span></td>
                    <td><span className="f12 muted">{s.started_at ? timeAgo(s.started_at) : '--'}</span></td>
                  </tr>
                );
              })}
              {sessionsWithScores.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    No sessions with tool calls
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </Collapsible>
      </div>

      {/* Open findings table — deduped by error signature, severity by content */}
      {findings.length > 0 && (() => {
        const SEV_RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
        const grouped = new Map<string, any>();
        for (const f of findings) {
          const key = `${f.tool_name}::${normalizeError(f.tool_output)}`;
          const existing = grouped.get(key);
          if (existing) {
            existing.count++;
            continue;
          }
          const cleanPreview = String(f.tool_output || `${f.tool_name} error`)
            .replace(/\[[0-9;]*m/g, '')
            .replace(/<\/?tool_use_error>/g, '')
            .trim()
            .slice(0, 90);
          grouped.set(key, {
            tool_name: f.tool_name,
            session_id: f.session_id,
            agent: f.agent,
            project_path: f.project_path,
            category: f.category,
            severity: classifySeverity(f.tool_output),
            preview: cleanPreview,
            when: timeAgo(f.timestamp),
            count: 1,
          });
        }
        const deduped = [...grouped.values()]
          .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count)
          .slice(0, 40);
        return <SeverityFilter findings={deduped} />;
      })()}

      {/* Policy event log */}
      <ErrorBoundary fallbackTitle="Policy event log failed to render">
      <EventLogFilter events={policyLog.map((e: any) => ({
        tool_name: e.tool_name,
        is_error: e.is_error,
        session_id: e.session_id,
        agent: e.agent,
        project_path: e.project_path,
        when: timeAgo(e.timestamp),
      }))} />
      </ErrorBoundary>
    </div>
  );
}
