'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Triggers a local collection run via /api/collect, then refreshes the route
 * so the freshly-collected data renders without a full reload. Local-only —
 * same `agentdx collect` the CLI runs; nothing leaves the machine.
 */
export function RefreshButton() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');

  async function run() {
    if (state === 'running') return;
    setState('running');
    try {
      const r = await fetch('/api/collect', { method: 'POST' });
      if (!r.ok) { setState('error'); return; }
      setState('idle');
      router.refresh();
    } catch {
      setState('error');
    }
  }

  return (
    <button
      onClick={run}
      disabled={state === 'running'}
      className="btn btn-sm"
      title="Collect new session data from all agents on this machine"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <span
        style={{
          display: 'inline-block',
          animation: state === 'running' ? 'adx-spin 0.7s linear infinite' : 'none',
        }}
      >
        ↻
      </span>
      {state === 'running' ? 'Collecting…' : state === 'error' ? 'Retry' : 'Refresh data'}
    </button>
  );
}
