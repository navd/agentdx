import { getDb, fmtTok, fmtNum, timeAgo } from '@/lib/db';
import { RingChart } from '@/components/ring-chart';
import { Collapsible } from '@/components/collapsible';
import { DrilldownTiles } from '@/components/drilldown-tiles';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';
import { GitPullRequest, GitBranch, FolderGit2, Upload } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

function getRepositoriesData() {
  const db = getDb();

  // Compute token + session counts live from sessions (the repositories table's
  // precomputed columns lag the canonical io+cache token metric used elsewhere).
  const repos = db.prepare(`
    SELECT r.path, r.origin_url, r.name, r.last_session_at,
      COALESCE(agg.session_count, 0) as session_count,
      COALESCE(agg.total_tokens, 0) as total_tokens
    FROM repositories r
    LEFT JOIN (
      SELECT project_path,
        COUNT(*) as session_count,
        SUM(total_input_tokens + total_output_tokens + total_cache_read) as total_tokens
      FROM sessions WHERE project_path IS NOT NULL
      GROUP BY project_path
    ) agg ON agg.project_path = r.path
    ORDER BY total_tokens DESC
  `).all() as any[];

  const totals = {
    repo_count: repos.length,
    total_sessions: repos.reduce((s, r) => s + (r.session_count || 0), 0),
    total_tokens: repos.reduce((s, r) => s + (r.total_tokens || 0), 0),
  };

  const allSessions = db.prepare(`SELECT COUNT(*) as cnt FROM sessions`).get() as any;
  const activeAgents = db.prepare(`SELECT COUNT(DISTINCT agent) as cnt FROM sessions`).get() as any;

  const agentRows = db.prepare(`
    SELECT DISTINCT project_path, agent FROM sessions WHERE project_path IS NOT NULL
  `).all() as { project_path: string; agent: string }[];

  const agentsByRepo = new Map<string, string[]>();
  for (const row of agentRows) {
    const list = agentsByRepo.get(row.project_path) || [];
    list.push(row.agent);
    agentsByRepo.set(row.project_path, list);
  }

  const langRows = db.prepare(`
    SELECT DISTINCT s.project_path,
      CASE
        WHEN tc.tool_input LIKE '%.tsx%' OR tc.tool_input LIKE '%.ts%' THEN 'TypeScript'
        WHEN tc.tool_input LIKE '%.jsx%' OR tc.tool_input LIKE '%.js%' THEN 'JavaScript'
        WHEN tc.tool_input LIKE '%.py%' THEN 'Python'
        WHEN tc.tool_input LIKE '%.rs%' THEN 'Rust'
        WHEN tc.tool_input LIKE '%.go%' THEN 'Go'
        WHEN tc.tool_input LIKE '%.java%' THEN 'Java'
        WHEN tc.tool_input LIKE '%.rb%' THEN 'Ruby'
        WHEN tc.tool_input LIKE '%.css%' OR tc.tool_input LIKE '%.html%' THEN 'Web'
        ELSE NULL
      END as lang
    FROM sessions s
    JOIN tool_calls tc ON tc.session_id = s.id
    WHERE s.project_path IS NOT NULL AND tc.tool_input IS NOT NULL
  `).all() as { project_path: string; lang: string | null }[];

  const langsByRepo = new Map<string, string[]>();
  for (const row of langRows) {
    if (!row.lang) continue;
    const list = langsByRepo.get(row.project_path) || [];
    if (!list.includes(row.lang)) list.push(row.lang);
    langsByRepo.set(row.project_path, list);
  }

  const langCounts = new Map<string, number>();
  for (const [, langs] of langsByRepo) {
    for (const lang of langs) {
      langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    }
  }

  // ── Git activity (commits / pushes / PRs) derived from coding-agent sessions ──

  // One row per session, with aggregated evidence flags. (The old query kept a
  // row per matching tool call via a per-row CASE, so a session that both
  // committed and pushed was counted twice.)
  const prSessions = db.prepare(`
    SELECT
      s.id, s.title, s.agent, s.git_branch, s.project_path, s.started_at,
      s.first_user_message,
      MAX(CASE WHEN tc.tool_input LIKE '%gh pr create%' THEN 1 ELSE 0 END) as has_pr,
      MAX(CASE WHEN tc.tool_input LIKE '%git push%' THEN 1 ELSE 0 END) as has_push,
      MAX(CASE WHEN tc.tool_input LIKE '%git commit%' THEN 1 ELSE 0 END) as has_commit
    FROM sessions s
    INNER JOIN tool_calls tc ON tc.session_id = s.id
    WHERE tc.tool_name = 'Bash'
      AND (tc.tool_input LIKE '%git push%' OR tc.tool_input LIKE '%git commit%' OR tc.tool_input LIKE '%gh pr create%')
      AND s.model_primary != '<synthetic>'
    GROUP BY s.id
    ORDER BY s.started_at DESC
  `).all().map((s: any) => ({
    ...s,
    evidence: s.has_pr ? 'gh pr create' : s.has_push ? 'git push' : s.has_commit ? 'git commit' : 'git activity',
  })) as any[];

  const prCreated = (db.prepare(`
    SELECT COUNT(DISTINCT s.id) as cnt FROM sessions s
    INNER JOIN tool_calls tc ON tc.session_id = s.id
    WHERE tc.tool_name = 'Bash' AND tc.tool_input LIKE '%gh pr create%' AND s.model_primary != '<synthetic>'
  `).get() as any).cnt;

  const pushSessions = (db.prepare(`
    SELECT COUNT(DISTINCT s.id) as cnt FROM sessions s
    INNER JOIN tool_calls tc ON tc.session_id = s.id
    WHERE tc.tool_name = 'Bash' AND tc.tool_input LIKE '%git push%' AND s.model_primary != '<synthetic>'
  `).get() as any).cnt;

  const commitSessions = (db.prepare(`
    SELECT COUNT(DISTINCT s.id) as cnt FROM sessions s
    INNER JOIN tool_calls tc ON tc.session_id = s.id
    WHERE tc.tool_name = 'Bash' AND tc.tool_input LIKE '%git commit%' AND s.model_primary != '<synthetic>'
  `).get() as any).cnt;

  const uniqueBranches = (db.prepare(`
    SELECT COUNT(DISTINCT s.git_branch) as cnt FROM sessions s
    INNER JOIN tool_calls tc ON tc.session_id = s.id
    WHERE tc.tool_name = 'Bash' AND (tc.tool_input LIKE '%git push%' OR tc.tool_input LIKE '%gh pr%')
      AND s.git_branch IS NOT NULL AND s.model_primary != '<synthetic>'
  `).get() as any).cnt;

  const uniqueRepos = (db.prepare(`
    SELECT COUNT(DISTINCT s.project_path) as cnt FROM sessions s
    INNER JOIN tool_calls tc ON tc.session_id = s.id
    WHERE tc.tool_name = 'Bash' AND (tc.tool_input LIKE '%git push%' OR tc.tool_input LIKE '%gh pr%')
      AND s.project_path IS NOT NULL AND s.model_primary != '<synthetic>'
  `).get() as any).cnt;

  // Evidence breakdown for visual
  const evidenceCounts = { 'gh pr create': 0, 'gh pr': 0, 'git push': 0, 'git commit': 0 };
  for (const s of prSessions) {
    if (s.evidence in evidenceCounts) evidenceCounts[s.evidence as keyof typeof evidenceCounts]++;
  }

  // Per-agent shipping: how many of each agent's sessions reached commit / push
  // / PR-create. "Ship rate" = share of an agent's sessions that produced a
  // commit — the honest "which tool actually lands code" signal. These are
  // detected from shell commands (intent), not guaranteed merge outcomes.
  const totalsByAgent = new Map<string, number>();
  for (const r of db.prepare('SELECT agent, COUNT(*) as cnt FROM sessions GROUP BY agent').all() as any[]) {
    totalsByAgent.set(r.agent, r.cnt);
  }
  const shipRows = db.prepare(`
    SELECT s.agent AS agent,
      COUNT(DISTINCT CASE WHEN tc.tool_input LIKE '%git commit%' THEN s.id END) AS commits,
      COUNT(DISTINCT CASE WHEN tc.tool_input LIKE '%git push%' THEN s.id END) AS pushes,
      COUNT(DISTINCT CASE WHEN tc.tool_input LIKE '%gh pr create%' THEN s.id END) AS prs
    FROM sessions s
    INNER JOIN tool_calls tc ON tc.session_id = s.id
    WHERE tc.tool_name IN ('Bash', 'Shell', 'exec_command') AND s.model_primary != '<synthetic>'
      AND (tc.tool_input LIKE '%git commit%' OR tc.tool_input LIKE '%git push%' OR tc.tool_input LIKE '%gh pr create%')
    GROUP BY s.agent
  `).all() as any[];
  const shipByAgent = shipRows.map((r) => {
    const total = totalsByAgent.get(r.agent) || 0;
    return {
      agent: r.agent,
      sessions: total,
      commits: r.commits || 0,
      pushes: r.pushes || 0,
      prs: r.prs || 0,
      shipRate: total > 0 ? (r.commits / total) * 100 : 0,
    };
  }).sort((a, z) => z.commits - a.commits);

  return {
    repos, totals, allSessions, activeAgents, agentsByRepo, langsByRepo, langCounts,
    prSessions, totalPRs: prCreated || 0, pushSessionCount: pushSessions || 0,
    commitSessionCount: commitSessions || 0, branchCount: uniqueBranches || 0,
    gitRepoCount: uniqueRepos || 0, evidenceCounts, shipByAgent,
  };
}

function repoName(path: string | null): string {
  if (!path) return '—';
  return path.split('/').pop() || path;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178C6', JavaScript: '#F7DF1E', Python: '#3776AB',
  Rust: '#DEA584', Go: '#00ADD8', Java: '#E76F00', Ruby: '#CC342D', Web: '#E34F26',
};

export default function RepositoriesPage() {
  const {
    repos, totals, allSessions, activeAgents, agentsByRepo, langsByRepo, langCounts,
    prSessions, totalPRs, pushSessionCount, commitSessionCount, branchCount,
    gitRepoCount, evidenceCounts, shipByAgent,
  } = getRepositoriesData();

  if (repos.length === 0) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Repositories</h1>
            <p className="page-sub">No repositories tracked</p>
          </div>
        </div>
        <EmptyState
          icon="folder-open"
          title="No repositories found"
          description="No repository data has been collected yet. Run `agentdx collect` to discover repositories from your coding-agent sessions."
          action={{ label: 'Collector status', href: '/collector' }}
        />
      </div>
    );
  }

  const maxTokens = repos[0]?.total_tokens || 1;
  const maxEvidence = Math.max(...Object.values(evidenceCounts), 1);
  const langEntries = [...langCounts.entries()].sort((a, b) => b[1] - a[1]);
  const langSegments = langEntries.map(([lang, count]) => ({
    key: lang, value: count, color: LANG_COLORS[lang] || 'var(--text-muted)', label: lang,
  }));

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Repositories &amp; Pull Requests</h1>
          <p className="page-sub">{fmtNum(totals.repo_count || 0)} repositories tracked &middot; {activeAgents.cnt} agents &middot; commits, pushes &amp; PR activity</p>
        </div>
      </div>

      {/* Unified KPI strip — repos + git activity, deduped */}
      <div className="mb-20">
        <DrilldownTiles tiles={[
          { label: 'Repositories', value: fmtNum(totals.repo_count || 0), detail: 'tracked repos', href: '/repositories', icon: <FolderGit2 size={18} />, tone: 'accent' },
          { label: 'Sessions', value: fmtNum(totals.total_sessions || 0), detail: `of ${fmtNum(allSessions.cnt || 0)} mapped to a repo`, href: '/sessions', icon: <GitBranch size={18} />, tone: 'info' },
          { label: 'Total tokens', value: fmtTok(totals.total_tokens || 0), detail: 'across all repos', href: '/sessions', icon: <Upload size={18} />, tone: 'neutral' },
          { label: 'Active agents', value: fmtNum(activeAgents.cnt || 0), detail: 'distinct agents', href: '/agents', icon: <GitBranch size={18} />, tone: 'pos' },
          { label: 'Commits', value: fmtNum(commitSessionCount), detail: 'git commit sessions', href: '/sessions', icon: <GitBranch size={18} />, tone: 'accent' },
          { label: 'Pushes', value: fmtNum(pushSessionCount), detail: 'git push sessions', href: '/sessions', icon: <Upload size={18} />, tone: 'info' },
          { label: 'PRs', value: fmtNum(totalPRs), detail: 'via gh pr create', href: '/sessions', icon: <GitPullRequest size={18} />, tone: totalPRs > 0 ? 'pos' : 'neutral' },
        ]} />
      </div>

      {/* Visual row: Ranked bars + Language ring */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '1fr 260px' }}>
        <ErrorBoundary fallbackTitle="Token usage chart failed to render">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Token usage by repository</h3>
              <p className="card-sub">ranked by total tokens &middot; click to view sessions</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-14">
              {repos.filter(r => r.total_tokens > 0).map((r: any) => {
                const pct = (r.total_tokens / maxTokens) * 100;
                const langs = langsByRepo.get(r.path) || [];
                return (
                  <Link key={r.path} href={`/sessions?project=${encodeURIComponent(r.path)}`}>
                    <div className="row between mb-4">
                      <span className="row gap-8">
                        <span className="mono fw6" style={{ fontSize: 13 }}>{r.name}</span>
                        {langs.slice(0, 3).map(lang => (
                          <span key={lang} style={{ display: 'inline-block', padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 600, background: LANG_COLORS[lang] || 'var(--text-muted)', color: '#fff' }}>{lang}</span>
                        ))}
                      </span>
                      <span className="mono f12 fw6">{fmtTok(r.total_tokens)}</span>
                    </div>
                    <div className="meter">
                      <div className="fill" style={{ width: `${Math.max(pct, 2)}%` }} />
                    </div>
                    <div className="f12 muted" style={{ marginTop: 2 }}>
                      {fmtNum(r.session_count)} session{r.session_count === 1 ? '' : 's'}
                      {r.last_session_at ? ` · ${timeAgo(r.last_session_at)}` : ''}
                    </div>
                  </Link>
                );
              })}
              {repos.filter(r => r.total_tokens > 0).length === 0 && (
                <span className="f13 muted">No token data available</span>
              )}
            </div>
          </div>
        </div>
        </ErrorBoundary>

        <ErrorBoundary fallbackTitle="Languages chart failed to render">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <h3 className="card-title" style={{ marginBottom: 12 }}>Languages</h3>
          {langSegments.length > 0 ? (
            <>
              <RingChart segments={langSegments} size={160} strokeWidth={24} centerValue={String(langEntries.length)} centerLabel="languages" />
              <div className="col-flex gap-6 mt-12" style={{ width: '100%' }}>
                {langEntries.slice(0, 6).map(([lang, count]) => (
                  <div key={lang} className="row between f12">
                    <span className="row gap-6">
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: LANG_COLORS[lang] || 'var(--text-muted)', display: 'inline-block' }} />
                      {lang}
                    </span>
                    <span className="mono muted">{count}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <span className="f13 muted">No language data</span>
          )}
        </div>
        </ErrorBoundary>
      </div>

      {/* Which agent ships — per-agent commit/push/PR activity + ship rate */}
      {shipByAgent.length > 0 && (
        <ErrorBoundary fallbackTitle="Per-agent shipping failed to render">
        <div className="card mb-20">
          <div className="card-head">
            <div>
              <h3 className="card-title">Which agent ships</h3>
              <p className="card-sub">how often each agent&apos;s sessions reach a commit, push, or PR</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-16">
              {shipByAgent.map((a) => {
                const maxCommits = Math.max(...shipByAgent.map((x) => x.commits), 1);
                return (
                  <div key={a.agent}>
                    <div className="row between mb-4">
                      <span className="row gap-8">
                        <Link href={`/sessions?agent=${encodeURIComponent(a.agent)}`} className="mono fw6" style={{ fontSize: 13, color: 'var(--text)' }}>{a.agent}</Link>
                        <span className="f12 muted">{a.commits} commit{a.commits === 1 ? '' : 's'} · {a.pushes} push{a.pushes === 1 ? '' : 'es'}{a.prs > 0 ? ` · ${a.prs} PR` : ''}</span>
                      </span>
                      <span className="mono f12 fw6">{a.shipRate.toFixed(0)}% ship rate</span>
                    </div>
                    <div className="meter">
                      <div className="fill" style={{ width: `${Math.max(2, (a.commits / maxCommits) * 100)}%` }} />
                    </div>
                    <div className="f12 muted" style={{ marginTop: 2 }}>
                      {a.commits} of {a.sessions} session{a.sessions === 1 ? '' : 's'} produced a commit
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="f12" style={{ color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 14 }}>
              Detected from shell commands the agent ran — intent, not a guaranteed merge. &ldquo;Ship rate&rdquo; is the share of that agent&apos;s sessions that produced a <span className="mono">git commit</span>.
            </div>
          </div>
        </div>
        </ErrorBoundary>
      )}

      {/* Evidence breakdown */}
      <ErrorBoundary fallbackTitle="Evidence breakdown failed to render">
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Evidence breakdown</h3>
            <p className="card-sub">git activity types detected across sessions</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="col-flex gap-14">
            {Object.entries(evidenceCounts).filter(([, v]) => v > 0).map(([key, count]) => (
              <div key={key}>
                <div className="row between mb-4">
                  <span className="tag-mono">{key}</span>
                  <span className="mono f12 fw6">{count}</span>
                </div>
                <div className="meter">
                  <div className="fill" style={{ width: `${(count / maxEvidence) * 100}%`, background: key.includes('pr') ? 'var(--accent)' : 'var(--info)' }} />
                </div>
              </div>
            ))}
            {Object.values(evidenceCounts).every(v => v === 0) && (
              <span className="f13 muted">No git activity detected yet</span>
            )}
          </div>
        </div>
      </div>
      </ErrorBoundary>

      {/* Repositories table (collapsible) */}
      <div className="card">
        <Collapsible title="Repository details" count={repos.length}>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Provider</th>
                  <th>Languages</th>
                  <th className="num">Sessions</th>
                  <th className="num">Tokens</th>
                  <th>Agents</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {repos.map((r: any) => {
                  const agents = agentsByRepo.get(r.path) || [];
                  const langs = langsByRepo.get(r.path) || [];
                  return (
                    <tr key={r.path} className="clickable">
                      <td>
                        <Link href={`/sessions?project=${encodeURIComponent(r.path)}`}>
                          <span className="mono fw6" style={{ color: 'var(--text)' }}>{r.name}</span>
                          <br /><span className="f12 muted">{r.path}</span>
                        </Link>
                      </td>
                      <td><span className="badge badge-info"><span className="dot" style={{ background: 'var(--info)' }} />Local</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {langs.length > 0 ? langs.map(lang => (
                            <span key={lang} style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 3, fontSize: 10, fontWeight: 600, background: LANG_COLORS[lang] || 'var(--text-muted)', color: '#fff' }}>{lang}</span>
                          )) : <span className="subtle">--</span>}
                        </div>
                      </td>
                      <td className="num">{fmtNum(r.session_count)}</td>
                      <td className="num">{fmtTok(r.total_tokens || 0)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {agents.length > 0 ? agents.map(a => <span key={a} className="tag-mono">{a}</span>) : <span className="subtle">--</span>}
                        </div>
                      </td>
                      <td><span className="f12 muted">{r.last_session_at ? timeAgo(r.last_session_at) : '--'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Collapsible>
      </div>

      {/* PR sessions table (collapsible) */}
      <ErrorBoundary fallbackTitle="PR sessions table failed to render">
      <div className="card mb-20">
        {prSessions.length > 0 ? (
          <Collapsible title="Sessions with git activity" count={prSessions.length} defaultOpen>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Agent</th>
                    <th>Branch</th>
                    <th>Repository</th>
                    <th>Evidence</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {prSessions.map((s: any, i: number) => (
                    <tr key={`${s.id}-${s.evidence}-${i}`} className="clickable">
                      <td>
                        <Link href={`/sessions/${s.id}`}>
                          <span className="hash fw6" style={{ color: 'var(--text)' }}>{s.id.slice(0, 8)}</span>
                          <br /><span className="f12 subtle">{s.title || s.first_user_message?.slice(0, 40) || '—'}</span>
                        </Link>
                      </td>
                      <td><span className="tag-mono">{s.agent}</span></td>
                      <td><span className="mono f12">{s.git_branch || '—'}</span></td>
                      <td><span className="mono f12">{repoName(s.project_path)}</span></td>
                      <td>
                        <span className={`badge ${s.evidence === 'gh pr create' ? 'badge-pos' : 'badge-info'}`}>
                          {s.evidence}
                        </span>
                      </td>
                      <td className="muted f12">{timeAgo(s.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Collapsible>
        ) : (
          <div className="card-pad" style={{ textAlign: 'center', padding: 40 }}>
            <GitPullRequest size={32} style={{ color: 'var(--text-subtle)', marginBottom: 12 }} />
            <h3 className="fw6" style={{ marginBottom: 8 }}>No PR activity detected yet</h3>
            <p className="muted f13">Sessions with <code className="mono">git push</code>, <code className="mono">git commit</code>, or <code className="mono">gh pr create</code> will appear here.</p>
          </div>
        )}
      </div>
      </ErrorBoundary>
    </div>
  );
}
