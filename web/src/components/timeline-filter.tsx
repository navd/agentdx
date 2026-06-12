'use client';

import { useState } from 'react';

interface TimelineItem {
  type: string;
  ts: number;
  role?: string;
  content?: string | null;
  model?: string | null;
  tokens?: number;
  /** True when `tokens` is a text-length estimate (agent logs no per-message usage). */
  tokensEstimated?: boolean;
  toolName?: string;
  isError?: boolean;
  icon?: string;
  filePath?: string | null;
}

const FILTERS = [
  { key: 'all', label: 'All events' },
  { key: 'user', label: 'User prompts' },
  { key: 'assistant', label: 'Responses' },
  { key: 'tool', label: 'Tool calls' },
];

function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

function isEditTool(toolName?: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return lower.includes('edit') || lower.includes('write') || lower.includes('file edit');
}

function isGitAction(toolName?: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return lower.includes('commit') || lower.includes('push');
}

interface DiffParts {
  oldLines: string[];
  newLines: string[];
}

function tryParseDiff(content: string): DiffParts | null {
  try {
    // Try parsing as JSON directly
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Content might be wrapped in extra text; try to extract JSON object
      const braceStart = content.indexOf('{');
      const braceEnd = content.lastIndexOf('}');
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(content.slice(braceStart, braceEnd + 1));
        } catch {
          return null;
        }
      }
    }
    if (!parsed) return null;

    const oldStr = (parsed.old_string ?? parsed.oldString ?? '') as string;
    const newStr = (parsed.new_string ?? parsed.newString ?? '') as string;

    if (!oldStr && !newStr) return null;

    return {
      oldLines: oldStr ? oldStr.split('\n') : [],
      newLines: newStr ? newStr.split('\n') : [],
    };
  } catch {
    return null;
  }
}

function TimelineNode({ item }: { item: TimelineItem }) {
  const isTool = item.type === 'tool';
  const isEdit = isTool && isEditTool(item.toolName);
  const isGit = isTool && isGitAction(item.toolName);
  // Tool output collapsed by default — expanding everything turns the page into
  // a wall of black terminal blocks. Prompts/responses/diffs stay visible.
  const [open, setOpen] = useState(false);

  const icons: Record<string, string> = {
    user: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    assistant: 'M12 3v18M3 8l9 4 9-4',
    tool: 'm4 7 4 4-4 4M12 15h6',
  };

  const kindLabels: Record<string, string> = {
    user: 'User prompt',
    assistant: 'Assistant response',
    tool: 'Tool call',
  };

  const content = item.content;
  const displayContent = content
    ? content.length > 800 ? content.slice(0, 800) + '…' : content
    : null;

  // Try to parse diff for edit tool calls
  const diffParts = isEdit && content ? tryParseDiff(content) : null;

  // Build CSS classes for the node
  const nodeClasses = [
    'chain-node',
    isTool ? 'accent' : '',
    isGit ? 'git-action' : '',
  ].filter(Boolean).join(' ');

  // One-line preview shown when a tool's output is collapsed.
  const previewLine = (displayContent || '').split('\n').find((l) => l.trim()) || '';
  const preview = previewLine.length > 96 ? previewLine.slice(0, 96) + '…' : previewLine;

  const nodeStyle: React.CSSProperties = isGit
    ? { borderLeft: '3px solid var(--pos)', paddingLeft: 14 }
    : item.type === 'user'
    ? { borderLeft: '3px solid var(--accent)', paddingLeft: 14, background: 'var(--surface-2)', borderRadius: 'var(--r-sm, 6px)' }
    : {};

  return (
    <div
      className={nodeClasses}
      style={nodeStyle}
    >
      <span className="dot">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d={item.icon || icons[item.type] || icons.tool} />
        </svg>
      </span>
      <div className="row between" style={{ marginBottom: 3 }}>
        <span className="chain-k">
          {isGit && <span style={{ marginRight: 5 }}>{'🔀 '}</span>}
          {item.toolName || kindLabels[item.type] || item.type}
        </span>
        <span className="f12 subtle mono">{new Date(item.ts).toLocaleTimeString()}</span>
      </div>
      {item.filePath && (
        <div className="f12 mono" style={{ color: 'var(--accent-text)', marginBottom: 4 }}>{item.filePath}</div>
      )}
      {diffParts ? (
        <div className="chain-v" style={{ lineHeight: 1.5 }}>
          <div className="diff" style={{ marginTop: 8 }}>
            {diffParts.oldLines.map((line, i) => (
              <div key={`d${i}`} className="dl del">
                <span className="gut">-</span>{line}
              </div>
            ))}
            {diffParts.newLines.map((line, i) => (
              <div key={`a${i}`} className="dl add">
                <span className="gut">+</span>{line}
              </div>
            ))}
          </div>
          {diffParts.oldLines.length + diffParts.newLines.length > 0 && (
            <div className="diff-stat" style={{ marginTop: 6 }}>
              {diffParts.oldLines.length > 0 && (
                <span className="d">-{diffParts.oldLines.length}</span>
              )}
              {diffParts.newLines.length > 0 && (
                <span className="a">+{diffParts.newLines.length}</span>
              )}
            </div>
          )}
        </div>
      ) : displayContent ? (
        <div className="chain-v" style={{ lineHeight: 1.5 }}>
          {isTool ? (
            <div style={{ marginTop: 4 }}>
              <button
                onClick={() => setOpen((o) => !o)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  color: item.isError ? 'var(--neg)' : 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: 12,
                }}
              >
                <span style={{ flexShrink: 0, transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.isError ? 'Error: ' : ''}{open ? 'hide output' : preview || 'show output'}
                </span>
              </button>
              {open && (
                <div className="term" style={{ marginTop: 6 }}>
                  <div className="term-body" style={{ padding: '10px 13px', fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
                    {item.isError && <span style={{ color: 'var(--neg)' }}>Error: </span>}
                    {displayContent}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: item.type === 'user' ? 'var(--text)' : 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
              {displayContent}
            </div>
          )}
        </div>
      ) : null}
      <div className="chain-meta mono">
        {item.model && <span className="tag-model" style={{ marginRight: 8 }}>{item.model}</span>}
        {item.tokens ? (
          item.tokensEstimated
            ? <span title="Estimated from text length (~4 chars/token) — this agent logs no per-message usage" style={{ opacity: 0.7 }}>~{fmtTok(item.tokens)} tokens est.</span>
            : `${fmtTok(item.tokens)} tokens`
        ) : ''}
      </div>
    </div>
  );
}

export type { TimelineItem };

export function TimelineFilter({
  items,
  maxItems = 100,
}: {
  items: TimelineItem[];
  maxItems?: number;
}) {
  const [filter, setFilter] = useState('all');

  const filtered = filter === 'all'
    ? items
    : items.filter(i => i.type === filter);

  const display = filtered.slice(0, maxItems);

  return (
    <>
      <div className="card-head">
        <div>
          <h3 className="card-title">Forensic timeline</h3>
          <p className="card-sub">Every captured event in order · prompts, responses, tool calls</p>
        </div>
        <div className="right" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="f13 muted">{filtered.length} events</span>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              padding: '5px 24px 5px 8px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r)',
              background: 'var(--surface)',
              color: 'var(--text)',
              fontFamily: 'var(--font)',
              fontSize: 12.5,
              cursor: 'pointer',
              outline: 'none',
              appearance: 'none' as const,
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239995' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 4px center',
              backgroundSize: '14px',
            }}
          >
            {FILTERS.map(f => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="card-pad">
        <div className="chain">
          {display.map((item, i) => (
            <TimelineNode key={i} item={item} />
          ))}
          {filtered.length > maxItems && (
            <div className="chain-node">
              <span className="dot" />
              <div className="f13 muted">… and {filtered.length - maxItems} more events</div>
            </div>
          )}
          {display.length === 0 && (
            <div className="f13 muted" style={{ padding: 20, textAlign: 'center' }}>
              No events match this filter
            </div>
          )}
        </div>
      </div>
    </>
  );
}
