import { getDb, fmtTok, fmtNum, fmtDuration, timeAgo } from '@/lib/db';
import { estimateCostUsd, fmtUsd } from '@/lib/pricing';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TimelineFilter, type TimelineItem } from '@/components/timeline-filter';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';

export const dynamic = 'force-dynamic';

function getSessionData(id: string) {
  const db = getDb();

  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
  if (!session) return null;

  const messages = db.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC
  `).all(id) as any[];

  const toolCalls = db.prepare(`
    SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC
  `).all(id) as any[];

  const modelUsage = db.prepare(`
    SELECT * FROM model_usage WHERE session_id = ? AND model != '<synthetic>' ORDER BY output_tokens DESC
  `).all(id) as any[];

  const toolSummary = db.prepare(`
    SELECT tool_name, COUNT(*) as cnt, SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors,
      AVG(duration_ms) as avg_dur
    FROM tool_calls WHERE session_id = ?
    GROUP BY tool_name ORDER BY cnt DESC
  `).all(id) as any[];

  const skillSummary = db.prepare(`
    SELECT skill, source, COUNT(*) as cnt
    FROM skill_invocations WHERE session_id = ?
    GROUP BY skill, source ORDER BY cnt DESC
  `).all(id) as any[];

  // Sub-agents this session spawned (Task tools + Workflow agents). Their
  // tokens are already rolled into the session totals; this lists them.
  // Guarded: the table is absent on databases collected before this feature.
  let subagents: any[] = [];
  let subagentTotals = { count: 0, tokens: 0, tools: 0, task: 0, workflow: 0 };
  try {
    subagents = db.prepare(`
      SELECT kind, workflow_id, model, tool_call_count,
        (input_tokens + output_tokens + cache_read) AS tokens, message_count, started_at
      FROM subagents WHERE parent_session_id = ?
      ORDER BY tokens DESC
    `).all(id) as any[];
    for (const s of subagents) {
      subagentTotals.count++;
      subagentTotals.tokens += s.tokens || 0;
      subagentTotals.tools += s.tool_call_count || 0;
      if (s.kind === 'workflow') subagentTotals.workflow++; else subagentTotals.task++;
    }
  } catch { /* pre-feature DB: no subagents table */ }

  return { session, messages, toolCalls, modelUsage, toolSummary, skillSummary, subagents, subagentTotals };
}

function categorizeTools(toolSummary: any[]): Record<string, any[]> {
  const categories: Record<string, string[]> = {
    'Read': ['Read', 'cat', 'read_file', 'Grep', 'Glob'],
    'Write': ['Write', 'Edit', 'write_file', 'apply_patch', 'NotebookEdit'],
    'Shell': ['Bash', 'exec_command', 'write_stdin'],
    'Agent': ['Agent', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'Workflow'],
    'Web': ['WebFetch', 'WebSearch'],
    'Git': ['git'],
  };

  const result: Record<string, any[]> = {};
  for (const tool of toolSummary) {
    let cat = 'Other';
    for (const [name, tools] of Object.entries(categories)) {
      if (tools.some(t => tool.tool_name.toLowerCase().includes(t.toLowerCase()))) {
        cat = name;
        break;
      }
    }
    if (!result[cat]) result[cat] = [];
    result[cat].push(tool);
  }
  return result;
}

function detectEventType(tc: any): { icon: string; label: string; accent: boolean } {
  const name = tc.tool_name?.toLowerCase() || '';
  const input = tc.tool_input?.toLowerCase() || '';

  if (name === 'bash' && input.includes('git commit')) return { icon: 'M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0M3 12h6M15 12h6', label: 'Git commit', accent: true };
  if (name === 'bash' && input.includes('git push')) return { icon: 'M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0M3 12h6M15 12h6', label: 'Git push', accent: true };
  if (name === 'write' || name === 'write_file') return { icon: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5', label: 'File write', accent: false };
  if (name === 'edit' || name === 'apply_patch') return { icon: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z', label: 'File edit', accent: false };
  if (name === 'read' || name === 'read_file') return { icon: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z', label: 'File read', accent: false };
  if (name === 'bash' || name === 'exec_command') return { icon: 'm4 7 4 4-4 4M12 15h6', label: 'Command', accent: false };
  if (name === 'agent') return { icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M12 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', label: 'Subagent', accent: true };
  return { icon: 'm4 7 4 4-4 4M12 15h6', label: tc.tool_name, accent: false };
}

function extractFilePath(toolInput: string | null): string | null {
  if (!toolInput) return null;
  try {
    const parsed = JSON.parse(toolInput);
    return parsed.file_path || parsed.path || parsed.command?.match(/["']([^"']+\.[a-z]+)["']/)?.[1] || null;
  } catch {
    return null;
  }
}

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = getSessionData(id);
  if (!data) {
    return (
      <div className="page page-wide">
        <Link href="/sessions" className="lnk f13 mb-16" style={{ display: 'inline-flex' }}>
          &larr; All sessions
        </Link>
        <EmptyState
          icon="search"
          title="Session not found"
          description={`No session with ID "${id.slice(0, 12)}" exists. It may have been deleted or not yet collected.`}
          action={{ label: 'Browse sessions', href: '/sessions' }}
        />
      </div>
    );
  }

  const { session: s, messages, toolCalls, modelUsage, toolSummary, skillSummary, subagents, subagentTotals } = data;
  // Canonical app-wide token total = input + output + cache_read (matches the
  // sessions list, Models, Insights). cache_write is shown only in the
  // breakdown below, against its own denominator, so percentages still sum to 100.
  const totalTok = (s.total_input_tokens || 0) + (s.total_output_tokens || 0) + (s.total_cache_read || 0);
  const cacheWrite = s.total_cache_write || 0;
  const barTotal = totalTok + cacheWrite;

  // Estimated API cost — summed per model from model_usage so multi-model
  // sessions price each slice at its own rate. Models without a known list
  // price are excluded and flagged, never counted as $0.
  let sessionCost = 0;
  let hasPricedUsage = false;
  let hasUnpricedUsage = false;
  for (const mu of modelUsage as any[]) {
    const c = estimateCostUsd(mu.model, {
      input: mu.input_tokens || 0,
      output: mu.output_tokens || 0,
      cacheRead: mu.cache_read || 0,
      cacheWrite: mu.cache_write || 0,
    });
    if (c === null) {
      if ((mu.input_tokens || 0) + (mu.output_tokens || 0) + (mu.cache_read || 0) > 0) hasUnpricedUsage = true;
    } else {
      sessionCost += c;
      hasPricedUsage = true;
    }
  }
  const projectName = s.project_path?.split('/').pop() || '—';

  const timelineItems: TimelineItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'user' && msg.content_type === 'tool_result') continue;
    if (!msg.content_text && msg.content_type === 'text') continue;
    const content = msg.content_text ? (msg.content_text.length > 800 ? msg.content_text.slice(0, 800) + '…' : msg.content_text) : null;
    // Per-message consumption: real usage where the agent logs it (Claude
    // Code, Cowork, Codex), incl. cache reads — that's what the call actually
    // billed. Agents with no per-message signal (Cursor, VS Code, Antigravity,
    // Continue) get a text-length estimate, clearly flagged as such.
    const realTok = (msg.input_tokens || 0) + (msg.output_tokens || 0) + (msg.cache_read || 0);
    const estTok = msg.role === 'assistant' && realTok === 0 && msg.content_text
      ? Math.ceil(msg.content_text.length / 4) : 0;
    timelineItems.push({
      type: msg.role,
      ts: msg.timestamp,
      content,
      model: msg.role === 'assistant' ? msg.model : null,
      tokens: msg.role === 'assistant' ? (realTok || estTok) : undefined,
      tokensEstimated: msg.role === 'assistant' && realTok === 0 && estTok > 0,
    });
  }
  for (const tc of toolCalls) {
    const ev = detectEventType(tc);
    const inputStr = tc.tool_input ? (tc.tool_input.length > 200 ? tc.tool_input.slice(0, 200) + '…' : tc.tool_input) : '';
    const outputStr = tc.tool_output ? (tc.tool_output.length > 300 ? tc.tool_output.slice(0, 300) + '…' : tc.tool_output) : '';
    timelineItems.push({
      type: 'tool',
      ts: tc.timestamp,
      content: `${inputStr}${outputStr ? '\n→ ' + outputStr : ''}`,
      toolName: ev.label,
      isError: tc.is_error === 1,
      icon: ev.icon,
      filePath: extractFilePath(tc.tool_input),
    });
  }
  timelineItems.sort((a, b) => a.ts - b.ts);

  const inPct = barTotal > 0 ? ((s.total_input_tokens || 0) / barTotal) * 100 : 0;
  const outPct = barTotal > 0 ? ((s.total_output_tokens || 0) / barTotal) * 100 : 0;
  const crPct = barTotal > 0 ? ((s.total_cache_read || 0) / barTotal) * 100 : 0;
  const cwPct = barTotal > 0 ? (cacheWrite / barTotal) * 100 : 0;

  const toolCategories = categorizeTools(toolSummary);
  const filesRead = toolSummary.filter(t => ['Read', 'cat', 'read_file'].includes(t.tool_name)).reduce((s, t) => s + t.cnt, 0);
  const filesWritten = toolSummary.filter(t => ['Write', 'Edit', 'write_file', 'apply_patch'].includes(t.tool_name)).reduce((s, t) => s + t.cnt, 0);
  const shellCmds = toolSummary.filter(t => ['Bash', 'exec_command'].includes(t.tool_name)).reduce((s, t) => s + t.cnt, 0);
  const totalErrors = toolSummary.reduce((s, t) => s + (t.errors || 0), 0);

  return (
    <div className="page page-wide">
      <Link href="/sessions" className="lnk f13 mb-16" style={{ display: 'inline-flex' }}>
        ← All sessions
      </Link>

      <div className="page-head">
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div className="agent-icon-tile" style={{
            width: 48, height: 48, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: s.agent === 'claude-code' ? 'var(--accent-soft)' : s.agent === 'codex' ? 'var(--info-soft, rgba(59,130,246,.12))' : 'var(--surface-3)',
            color: s.agent === 'claude-code' ? 'var(--accent)' : s.agent === 'codex' ? 'var(--info, #3B82F6)' : 'var(--text-muted)',
            flexShrink: 0,
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="26" height="26">
              <rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V5"/><circle cx="12" cy="3.5" r="1.4"/><circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><path d="M9 17h6"/>
            </svg>
          </div>
          <div>
            <div className="row gap-8 wrap">
              <h1 className="page-title mono" style={{ fontSize: 22 }}>{s.id.slice(0, 8)}</h1>
              <span className={`st-${s.status === 'completed' ? 'merged' : s.status === 'failed' ? 'failed' : 'open'}`}>
                {s.status || 'completed'}
              </span>
              {totalErrors > 0 ? (
                <span className={`rk-${totalErrors > 10 ? 'high' : totalErrors > 3 ? 'med' : 'low'}`}>
                  {totalErrors > 10 ? 'High risk' : totalErrors > 3 ? 'Medium risk' : 'Low risk'}
                </span>
              ) : (
                <span className="rk-none">No risk</span>
              )}
              <span className="cap-local" style={{ fontSize: 11 }}>Local</span>
            </div>
            <p className="page-sub" style={{ marginTop: 2 }}>
              <span className="tag-mono">{s.agent}</span>
              {' · '}
              {projectName}
              {s.git_branch && <>{' · '}<span className="tag-mono">{s.git_branch}</span></>}
            </p>
            <div className="row gap-16 mt-8 f12 muted wrap">
              <span>{timeAgo(s.started_at)}</span>
              <span>·</span>
              <span>duration {fmtDuration(s.duration_ms)}</span>
              <span>·</span>
              <span>{s.turn_count} prompts / {messages.filter(m => m.role === 'assistant').length} responses</span>
            </div>
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid mb-20" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
        {[
          { label: 'Turns', value: s.turn_count },
          { label: 'Tokens', value: fmtTok(totalTok) },
          { label: 'Tool calls', value: s.tool_call_count },
          { label: 'Files read', value: filesRead },
          { label: 'Files written', value: filesWritten },
          { label: 'Duration', value: fmtDuration(s.duration_ms) },
        ].map(k => (
          <div key={k.label} className="card stat" style={{ padding: '13px 15px' }}>
            <div className="stat-label" style={{ fontSize: 11.5, marginBottom: 7 }}>{k.label}</div>
            <div className="stat-value mono" style={{ fontSize: 19 }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 340px', alignItems: 'start' }}>
        {/* main column */}
        <div className="col-flex gap-16">
          {/* forensic timeline with filter */}
          <ErrorBoundary fallbackTitle="Timeline failed to render">
          <div className="card">
            <TimelineFilter
              items={timelineItems}
              maxItems={100}
            />
          </div>
          </ErrorBoundary>

          {/* tool calls table */}
          <ErrorBoundary fallbackTitle="Tool calls table failed to render">
          {toolSummary.length > 0 && (
            <div className="card">
              <div className="card-head">
                <div>
                  <h3 className="card-title">Tool calls</h3>
                  <p className="card-sub">grouped by type</p>
                </div>
                <div className="right">
                  <span className="mono f13 fw6">{s.tool_call_count} calls</span>
                  {totalErrors > 0 && <span className="f13" style={{ color: 'var(--neg)', marginLeft: 8 }}>{totalErrors} errors</span>}
                </div>
              </div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th className="num">Calls</th>
                      <th className="num">Errors</th>
                      <th className="num">Avg duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {toolSummary.map((t: any) => (
                      <tr key={t.tool_name}>
                        <td><span className="tag-mono">{t.tool_name}</span></td>
                        <td className="num">{t.cnt}</td>
                        <td className="num" style={{ color: t.errors > 0 ? 'var(--neg)' : undefined }}>{t.errors}</td>
                        <td className="num">{t.avg_dur ? `${Math.round(t.avg_dur)}ms` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </ErrorBoundary>
        </div>

        {/* right rail */}
        <div className="col-flex gap-16">
          {/* token breakdown */}
          <ErrorBoundary fallbackTitle="Token breakdown failed to render">
          <div className="card card-pad">
            <h3 className="card-title mb-4">Token breakdown</h3>
            <p className="card-sub mb-16">{fmtTok(totalTok)} total</p>
            <div className="tokbar">
              <div className="seg tok-prompt" style={{ width: `${inPct}%` }} />
              <div className="seg tok-completion" style={{ width: `${outPct}%` }} />
              <div className="seg tok-cached" style={{ width: `${crPct}%` }} />
              <div className="seg tok-reasoning" style={{ width: `${cwPct}%` }} />
            </div>
            <div className="tok-legend">
              {[
                { cls: 'tok-prompt', label: 'Input', val: s.total_input_tokens || 0 },
                { cls: 'tok-completion', label: 'Output', val: s.total_output_tokens || 0 },
                { cls: 'tok-cached', label: 'Cache read', val: s.total_cache_read || 0 },
                { cls: 'tok-reasoning', label: 'Cache write', val: s.total_cache_write || 0 },
              ].map(t => (
                <div key={t.cls} className="item" style={{ width: '100%' }}>
                  <span className={`sw ${t.cls}`} />
                  <span className="muted">{t.label}</span>
                  <span className="mono fw6" style={{ marginLeft: 'auto' }}>{fmtTok(t.val)}</span>
                </div>
              ))}
            </div>
            {(hasPricedUsage || hasUnpricedUsage) && (
              <div className="row between" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-faint, var(--surface-3))' }}>
                <span className="f12 muted" title="What this session's tokens would cost at public pay-as-you-go API list prices. Local models cost $0.">Est. API cost</span>
                <span className="mono f13 fw6">
                  {hasPricedUsage ? `~${fmtUsd(sessionCost)}` : '—'}
                  {hasUnpricedUsage && <span className="f12 muted" style={{ fontWeight: 400 }}> (partial)</span>}
                </span>
              </div>
            )}
          </div>
          </ErrorBoundary>

          {/* models used */}
          <div className="card card-pad">
            <h3 className="card-title mb-12">Models used</h3>
            {modelUsage.map((mu: any) => (
              <div key={mu.model} className="row between mb-8">
                <span className="tag-model">{mu.model}</span>
                <span className="mono f12">{mu.message_count} msgs · {fmtTok((mu.input_tokens || 0) + (mu.output_tokens || 0) + (mu.cache_read || 0))}</span>
              </div>
            ))}
            {modelUsage.length === 0 && <span className="f13 muted">No model data</span>}
          </div>

          {/* sub-agents spawned by this session */}
          {subagentTotals.count > 0 && (
            <div className="card card-pad">
              <div className="row between mb-12">
                <h3 className="card-title">Sub-agents</h3>
                <span className="f12 muted">{subagentTotals.task} task · {subagentTotals.workflow} workflow</span>
              </div>
              <div className="row between mb-8">
                <span className="f13 muted">{subagentTotals.count} spawned · {fmtNum(subagentTotals.tools)} tool calls</span>
                <span className="mono f13 fw6">{fmtTok(subagentTotals.tokens)} tokens</span>
              </div>
              <p className="f12 muted" style={{ marginTop: 2, marginBottom: 10 }}>included in this session&apos;s totals above</p>
              <div className="col-flex gap-6">
                {subagents.slice(0, 12).map((sa: any, i: number) => (
                  <div key={i} className="row between" style={{ fontSize: 12 }}>
                    <span className="mono muted">
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6, background: sa.kind === 'workflow' ? '#8B5CF6' : '#14B8A6', verticalAlign: 'middle' }} />
                      {sa.kind === 'workflow' ? (sa.workflow_id || 'workflow') : 'task'}{sa.model ? ` · ${sa.model}` : ''}
                    </span>
                    <span className="mono">{sa.tool_call_count} tools · {fmtTok(sa.tokens)}</span>
                  </div>
                ))}
                {subagents.length > 12 && <span className="f12 muted">+{subagents.length - 12} more</span>}
              </div>
            </div>
          )}

          {/* tool categories */}
          <div className="card card-pad">
            <h3 className="card-title mb-12">Tool usage by category</h3>
            {Object.entries(toolCategories).map(([cat, tools]) => (
              <div key={cat} className="mb-12">
                <div className="f12 fw6 mb-4" style={{ color: 'var(--text-muted)' }}>{cat}</div>
                {tools.map((t: any) => (
                  <div key={t.tool_name} className="mb-4" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <span className="f12 mono" style={{ minWidth: 0, overflowWrap: 'anywhere' }} title={t.tool_name}>{t.tool_name}</span>
                    <span className="f12 mono muted" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{t.cnt}{t.errors > 0 ? ` (${t.errors} err)` : ''}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* risk findings */}
          {totalErrors > 0 && (
            <div className="card card-pad">
              <h3 className="card-title mb-12">Risk findings</h3>
              {toolSummary.filter(t => t.errors > 0).map((t: any) => (
                <div key={t.tool_name} className="mb-8" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span className={`rk-${t.errors > 5 ? 'high' : t.errors > 2 ? 'med' : 'low'}`} style={{ flexShrink: 0 }}>
                    {t.errors > 5 ? 'High' : t.errors > 2 ? 'Med' : 'Low'}
                  </span>
                  <div>
                    <div className="f13 fw6">{t.tool_name} failures</div>
                    <div className="f12 muted">{t.errors} errors out of {t.cnt} calls ({t.cnt > 0 ? Math.round(t.errors / t.cnt * 100) : 0}% failure rate)</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* skills used */}
          <div className="card card-pad">
            <h3 className="card-title mb-12">Skills used</h3>
            {skillSummary.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {skillSummary.map((sk: any) => {
                  const colors: Record<string, string> = {
                    slash: 'var(--accent)', command: 'var(--info, #3B82F6)', tool: '#8B5CF6',
                  };
                  const c = colors[sk.source] || 'var(--text-muted)';
                  return (
                    <span key={`${sk.skill}-${sk.source}`} title={`source: ${sk.source}`} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px',
                      borderRadius: 12, fontSize: 11.5, fontWeight: 500, fontFamily: 'var(--font-mono)',
                      background: `color-mix(in srgb, ${c} 12%, transparent)`, color: c,
                    }}>
                      /{sk.skill}
                      {sk.cnt > 1 && <span style={{ opacity: 0.6 }}>×{sk.cnt}</span>}
                    </span>
                  );
                })}
              </div>
            ) : (
              <div className="f12 muted">No skills or slash-commands in this session</div>
            )}
            <div className="mt-12" style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 12px', fontSize: 12 }}>
              <span className="muted">Skill invocations</span><span className="mono">{skillSummary.reduce((a: number, x: any) => a + x.cnt, 0)}</span>
              <span className="muted">Builtin tools</span><span className="mono">{toolSummary.length}</span>
              <span className="muted">Tool calls</span><span className="mono">{s.tool_call_count}</span>
            </div>
          </div>

          {/* context sources */}
          <div className="card card-pad">
            <h3 className="card-title mb-12">Context sources</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px' }}>
              <span className="f12 muted">Files read</span><span className="f13 mono" style={{ textAlign: 'right' }}>{filesRead}</span>
              <span className="f12 muted">Files modified</span><span className="f13 mono" style={{ textAlign: 'right' }}>{filesWritten}</span>
              <span className="f12 muted">Shell commands</span><span className="f13 mono" style={{ textAlign: 'right' }}>{shellCmds}</span>
              <span className="f12 muted">Tool types</span><span className="f13 mono" style={{ textAlign: 'right' }}>{toolSummary.length}</span>
              <span className="f12 muted">Total events</span><span className="f13 mono" style={{ textAlign: 'right' }}>{timelineItems.length}</span>
              <span className="f12 muted">Errors</span><span className="f13 mono" style={{ textAlign: 'right', color: totalErrors > 0 ? 'var(--neg)' : undefined }}>{totalErrors}</span>
            </div>
          </div>

          {/* session info */}
          <div className="card card-pad">
            <h3 className="card-title mb-12">Session info</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px' }}>
              <span className="f12 muted">Agent</span><span className="f13 mono" style={{ textAlign: 'right' }}>{s.agent}</span>
              <span className="f12 muted">Version</span><span className="f13 mono" style={{ textAlign: 'right' }}>{s.agent_version || '—'}</span>
              <span className="f12 muted">Project</span><span className="f13" style={{ textAlign: 'right' }}>{projectName}</span>
              <span className="f12 muted">Branch</span><span className="f13 mono" style={{ textAlign: 'right' }}>{s.git_branch || '—'}</span>
              <span className="f12 muted">Started</span><span className="f13 mono" style={{ textAlign: 'right' }}>{new Date(s.started_at).toLocaleString()}</span>
              {s.ended_at && (
                <><span className="f12 muted">Ended</span><span className="f13 mono" style={{ textAlign: 'right' }}>{new Date(s.ended_at).toLocaleString()}</span></>
              )}
              <span className="f12 muted">Source</span><span className="f12 mono subtle" style={{ textAlign: 'right', wordBreak: 'break-all' }}>{s.source_path?.split('/').slice(-2).join('/') || '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
