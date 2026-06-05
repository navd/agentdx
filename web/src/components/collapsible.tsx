'use client';

import { useState } from 'react';

export function Collapsible({ title, count, children, defaultOpen = false }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button className={`drill-toggle${open ? ' open' : ''}`} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        {title}
        {count !== undefined && <span className="f12 muted" style={{ fontWeight: 400 }}>({count})</span>}
      </button>
      {open && children}
    </div>
  );
}
