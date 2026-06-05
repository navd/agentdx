'use client';
import { useState } from 'react';

interface ToolRow {
  tool_name: string;
  cnt: number;
  errors: number;
  avg_dur: number | null;
}

const CATEGORIES: Record<string, string[]> = {
  File: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'cat', 'read_file', 'write_file', 'apply_patch', 'NotebookEdit'],
  Shell: ['Bash', 'exec_command', 'write_stdin'],
  Agent: ['Agent', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'Workflow'],
  Web: ['WebFetch', 'WebSearch'],
  Other: [],
};

function getKind(toolName: string): string {
  for (const [kind, tools] of Object.entries(CATEGORIES)) {
    if (kind === 'Other') continue;
    if (tools.some(t => toolName.toLowerCase().includes(t.toLowerCase()))) return kind;
  }
  return 'Other';
}

export function KindFilter({ tools }: { tools: ToolRow[] }) {
  const [kind, setKind] = useState('All');
  const kinds = ['All', ...Object.keys(CATEGORIES)];
  const filtered = kind === 'All' ? tools : tools.filter(t => getKind(t.tool_name) === kind);

  return (
    <>
      <div className="card-head">
        <div>
          <h3 className="card-title">Skills by kind</h3>
          <p className="card-sub">{filtered.length} tools</p>
        </div>
        <div className="right">
          <select
            value={kind}
            onChange={e => setKind(e.target.value)}
            style={{
              padding: '4px 8px', fontSize: 12, borderRadius: 4,
              border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text)', fontFamily: 'var(--font)',
            }}
          >
            {kinds.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Kind</th>
              <th className="num">Calls</th>
              <th className="num">Errors</th>
              <th className="num">Avg duration</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <tr key={t.tool_name}>
                <td><span className="tag-mono">{t.tool_name}</span></td>
                <td><span className="f12 muted">{getKind(t.tool_name)}</span></td>
                <td className="num">{t.cnt}</td>
                <td className="num" style={{ color: t.errors > 0 ? 'var(--neg)' : undefined }}>{t.errors}</td>
                <td className="num">{t.avg_dur ? `${Math.round(t.avg_dur)}ms` : '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24 }} className="muted">No tools in this category</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
