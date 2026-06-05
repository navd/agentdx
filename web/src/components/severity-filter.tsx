'use client';
import { useState } from 'react';
import Link from 'next/link';

interface FindingRow {
  tool_name: string;
  tool_output?: string;
  session_id: string;
  agent?: string;
  project_path?: string;
  category: string;
  severity: string;
  preview: string;
  when: string;
  count?: number;
}

const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--font)',
};

type SeverityFilter = 'All' | 'High' | 'Medium' | 'Low';

export function SeverityFilter({ findings }: { findings: FindingRow[] }) {
  const [severity, setSeverity] = useState<SeverityFilter>('All');

  const filtered = findings.filter(f =>
    severity === 'All' ? true : f.severity === severity
  );

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">Open findings</h3>
          <p className="card-sub">Recent error events as findings</p>
        </div>
        <div className="right" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={severity}
            onChange={e => setSeverity(e.target.value as SeverityFilter)}
            style={selectStyle}
          >
            <option value="All">All</option>
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
          <span className="badge-neg">{filtered.length} open</span>
        </div>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Finding</th>
              <th>Category</th>
              <th>Repo &middot; session</th>
              <th>Severity</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f, i) => (
              <tr key={`${f.session_id}-${i}`}>
                <td>
                  <div className="fw6 f13 row gap-6">
                    {f.tool_name} failure
                    {f.count && f.count > 1 && <span className="badge badge-neutral" style={{ fontSize: 10 }}>×{f.count}</span>}
                  </div>
                  <div className="f12 muted" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.preview}</div>
                </td>
                <td><span className="badge-outline">{f.category}</span></td>
                <td>
                  <span className="f12 muted">{f.project_path?.split('/').pop() || '—'}</span>
                  {' · '}
                  <Link href={`/sessions/${f.session_id}`}>
                    <span className="mono f12" style={{ color: 'var(--accent)' }}>{String(f.session_id).slice(0, 8)}</span>
                  </Link>
                </td>
                <td>
                  <span className={`rk-${f.severity === 'High' ? 'high' : f.severity === 'Medium' ? 'med' : 'low'}`}>{f.severity}</span>
                </td>
                <td><span className="f12 muted">{f.when}</span></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No findings match this filter
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
