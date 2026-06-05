'use client';
import { useState } from 'react';
import Link from 'next/link';

interface EventRow {
  tool_name: string;
  is_error: number;
  session_id: string;
  agent?: string;
  project_path?: string;
  when: string;
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

type FilterType = 'All' | 'Success' | 'Error' | 'Bash' | 'Read' | 'Write' | 'Other';

const BASH_TOOLS = ['Bash', 'exec_command'];
const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['Write', 'Edit', 'write_file', 'apply_patch'];

function matchesFilter(e: EventRow, type: FilterType): boolean {
  switch (type) {
    case 'All': return true;
    case 'Success': return e.is_error === 0;
    case 'Error': return e.is_error === 1;
    case 'Bash': return BASH_TOOLS.includes(e.tool_name);
    case 'Read': return READ_TOOLS.includes(e.tool_name);
    case 'Write': return WRITE_TOOLS.includes(e.tool_name);
    case 'Other':
      return ![...BASH_TOOLS, ...READ_TOOLS, ...WRITE_TOOLS].includes(e.tool_name);
  }
}

export function EventLogFilter({ events }: { events: EventRow[] }) {
  const [type, setType] = useState<FilterType>('All');

  const filtered = events.filter(e => matchesFilter(e, type));

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div className="card-head">
        <div>
          <h3 className="card-title">Policy event log</h3>
          <p className="card-sub">Recent tool call activity with status</p>
        </div>
        <div className="right">
          <select
            value={type}
            onChange={e => setType(e.target.value as FilterType)}
            style={selectStyle}
          >
            <option value="All">All</option>
            <option value="Success">Success</option>
            <option value="Error">Error</option>
            <option value="Bash">Bash</option>
            <option value="Read">Read</option>
            <option value="Write">Write</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Result</th>
              <th>Agent</th>
              <th>Repo</th>
              <th>Session</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
              <tr key={`${e.session_id}-${i}`}>
                <td><span className="tag-mono">{e.tool_name}</span></td>
                <td>
                  <span className={e.is_error ? 'st-failed' : 'st-merged'}>
                    {e.is_error ? 'Error' : 'OK'}
                  </span>
                </td>
                <td><span className="tag-mono">{e.agent}</span></td>
                <td><span className="f12 muted">{e.project_path?.split('/').pop() || '—'}</span></td>
                <td>
                  <Link href={`/sessions/${e.session_id}`}>
                    <span className="f12 mono" style={{ color: 'var(--accent)' }}>{String(e.session_id).slice(0, 8)}</span>
                  </Link>
                </td>
                <td><span className="f12 muted">{e.when}</span></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No events match this filter
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
