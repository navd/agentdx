'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { fmtTok, fmtDuration } from '@/lib/format';

interface SessionRow {
  id: string;
  title: string | null;
  agent: string;
  model_primary: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  duration_ms: number | null;
  tool_call_count: number;
  turn_count: number;
  started_at: number;
  project_path: string | null;
  git_branch: string | null;
  first_user_message: string | null;
  error_count?: number;
}

function deriveRouting(model: string | null): { label: string; cls: string } {
  if (!model) return { label: '—', cls: '' };
  const m = model.toLowerCase();
  if (m.includes('ollama') || m.includes('qwen') || m.includes('llama') || m.includes('mistral') || m.includes('deepseek'))
    return { label: 'Local', cls: 'st-local' };
  return { label: 'Cloud', cls: 'badge-info' };
}


function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const DEFAULT_PAGE_SIZE = 25;

export function SessionsTable({
  sessions,
  agents,
  models,
  projects,
  initialAgent,
  initialModel,
  initialProject,
  initialDate,
  pageSize,
}: {
  sessions: SessionRow[];
  agents: string[];
  models: string[];
  projects: string[];
  initialAgent?: string;
  initialModel?: string;
  initialProject?: string;
  initialDate?: string;
  pageSize?: number;
}) {
  const PAGE_SIZE = pageSize && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState(initialAgent || 'all');
  const [modelFilter, setModelFilter] = useState(initialModel || 'all');
  const [projectFilter, setProjectFilter] = useState(initialProject || 'all');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let list = sessions;

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(s =>
        s.id.toLowerCase().includes(q) ||
        s.title?.toLowerCase().includes(q) ||
        s.first_user_message?.toLowerCase().includes(q)
      );
    }

    if (agentFilter !== 'all') {
      list = list.filter(s => s.agent === agentFilter);
    }
    if (modelFilter !== 'all') {
      list = list.filter(s => s.model_primary === modelFilter);
    }
    if (projectFilter !== 'all') {
      const proj = projectFilter;
      list = list.filter(s => s.project_path === proj || s.project_path?.split('/').pop() === proj);
    }
    // Heatmap drill-down: restrict to one UTC day (matches the heatmap's
    // date(started_at/1000,'unixepoch') buckets).
    if (initialDate) {
      list = list.filter(s => new Date(s.started_at).toISOString().slice(0, 10) === initialDate);
    }

    return list;
  }, [sessions, search, agentFilter, modelFilter, projectFilter, initialDate]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleFilterChange = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setter(e.target.value);
    setPage(0);
  };

  return (
    <>
      {/* toolbar */}
      <div className="toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '0 0 260px' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, color: 'var(--text-subtle)' }}>
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
          </svg>
          <input
            type="text"
            placeholder="Search sessions…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            style={{
              width: '100%', padding: '8px 10px 8px 34px', border: '1px solid var(--border)',
              borderRadius: 'var(--r)', background: 'var(--surface)', color: 'var(--text)',
              fontFamily: 'var(--font)', fontSize: 13, outline: 'none',
            }}
          />
        </div>

        <select
          value={agentFilter}
          onChange={handleFilterChange(setAgentFilter)}
          className="filter-select"
          style={selectStyle}
        >
          <option value="all">All agents</option>
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>

        <select
          value={modelFilter}
          onChange={handleFilterChange(setModelFilter)}
          className="filter-select"
          style={selectStyle}
        >
          <option value="all">All models</option>
          {models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <select
          value={projectFilter}
          onChange={handleFilterChange(setProjectFilter)}
          className="filter-select"
          style={selectStyle}
        >
          <option value="all">All projects</option>
          {projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>

        {(search || agentFilter !== 'all' || modelFilter !== 'all' || projectFilter !== 'all') && (
          <button
            onClick={() => { setSearch(''); setAgentFilter('all'); setModelFilter('all'); setProjectFilter('all'); setPage(0); }}
            style={{ background: 'none', border: 'none', color: 'var(--neg)', cursor: 'pointer', fontSize: 13, fontFamily: 'var(--font)' }}
          >
            Clear filters
          </button>
        )}

        <span className="f13 muted" style={{ marginLeft: 'auto' }}>
          {filtered.length} of {sessions.length} sessions
        </span>
      </div>

      {/* table */}
      <div className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Session</th>
                <th>Agent</th>
                <th>Model</th>
                <th className="num">Turns</th>
                <th className="num">Tokens</th>
                <th className="num">Tools</th>
                <th className="num" title="Wall-clock span from first to last event — includes idle time, so treat as approximate">Span</th>
                <th>Routing</th>
                <th>Project</th>
                <th>Risk</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {paged.map(s => {
                const totalTok = (s.total_input_tokens || 0) + (s.total_output_tokens || 0) + (s.total_cache_read || 0);
                const projectName = s.project_path?.split('/').pop() || '—';
                const label = s.title || s.first_user_message?.slice(0, 80) || s.id.slice(0, 8);
                return (
                  <tr key={s.id} className="clickable">
                    <td>
                      <Link href={`/sessions/${s.id}`} style={{ display: 'block' }}>
                        <span className="hash fw6" style={{ color: 'var(--text)' }}>{s.id.slice(0, 8)}</span>
                        <br />
                        <span className="f12 subtle" style={{ maxWidth: 300, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {label}
                        </span>
                      </Link>
                    </td>
                    <td><span className="tag-mono">{s.agent}</span></td>
                    <td><span className="tag-model">{s.model_primary || '—'}</span></td>
                    <td className="num">{s.turn_count}</td>
                    <td className="num">{fmtTok(totalTok)}</td>
                    <td className="num">{s.tool_call_count}</td>
                    <td className="num">{fmtDuration(s.duration_ms)}</td>
                    <td>{(() => { const r = deriveRouting(s.model_primary); return <span className={r.cls} style={{ fontSize: 11 }}>{r.label}</span>; })()}</td>
                    <td><span className="f12 muted">{projectName}</span></td>
                    <td>
                      {(s.error_count || 0) > 0 ? (
                        <span className={`rk-${(s.error_count || 0) > 10 ? 'high' : (s.error_count || 0) > 3 ? 'med' : 'low'}`}>
                          {(s.error_count || 0) > 10 ? 'High' : (s.error_count || 0) > 3 ? 'Med' : 'Low'}
                        </span>
                      ) : <span className="rk-none">None</span>}
                    </td>
                    <td><span className="f12 muted">{timeAgo(s.started_at)}</span></td>
                  </tr>
                );
              })}
              {paged.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign: 'center', padding: 32 }}>
                  <span className="muted">No sessions match your filters</span>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* pagination */}
        <div className="pagination" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--border-faint)' }}>
          <span className="info f13 muted">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              style={paginationBtnStyle}
            >
              ← Prev
            </button>
            <span className="f13 mono muted" style={{ padding: '6px 8px' }}>
              {page + 1} / {totalPages || 1}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={paginationBtnStyle}
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '7px 28px 7px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--font)',
  fontSize: 13,
  cursor: 'pointer',
  outline: 'none',
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239995' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 6px center',
  backgroundSize: '16px',
};

const paginationBtnStyle: React.CSSProperties = {
  padding: '6px 12px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--font)',
  fontSize: 13,
  cursor: 'pointer',
};
