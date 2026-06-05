'use client';

import { useEffect, useState } from 'react';

const PKG = '@agentdx/agentdx';

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

/**
 * Pull-only update check next to the version label. Fetches the latest version
 * number from the public npm registry (no data sent, no identifiers). If a
 * newer version exists, offers a one-click upgrade via a local API route.
 */
export function UpdateCheck({ current }: { current: string }) {
  const [latest, setLatest] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'updating' | 'done' | 'error'>('idle');

  useEffect(() => {
    if (!current || current === 'dev') return;
    let alive = true;
    fetch(`https://registry.npmjs.org/${PKG}/latest`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.version) setLatest(j.version); })
      .catch(() => {});
    return () => { alive = false; };
  }, [current]);

  if (!latest || !semverGt(latest, current)) return null;

  if (state === 'done') {
    return (
      <div className="f12" style={{ color: 'var(--pos)', padding: '4px 8px', lineHeight: 1.5 }}>
        ✓ Updated to v{latest} — restart agentdx to use it.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', flexWrap: 'wrap' }}>
      <span className="f12" style={{ color: 'var(--warn)' }}>▲ v{latest} available</span>
      <button
        onClick={async () => {
          setState('updating');
          try {
            const r = await fetch('/api/update', { method: 'POST' });
            setState(r.ok ? 'done' : 'error');
          } catch { setState('error'); }
        }}
        disabled={state === 'updating'}
        className="btn btn-sm btn-primary"
        style={{ height: 24, padding: '0 8px', fontSize: 11 }}
      >
        {state === 'updating' ? 'Updating…' : state === 'error' ? 'Retry' : 'Update'}
      </button>
      {state === 'error' && <span className="f12" style={{ color: 'var(--neg)' }}>failed — try the CLI</span>}
    </div>
  );
}
