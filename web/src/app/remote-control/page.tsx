import { fmtNum, fmtDuration, timeAgo } from '@/lib/db';
import { getRemoteControlData } from '@/lib/remote-control';
import Link from 'next/link';
import { Collapsible } from '@/components/collapsible';
import { DrilldownTiles } from '@/components/drilldown-tiles';
import { ErrorBoundary } from '@/components/error-boundary';
import { EmptyState } from '@/components/empty-state';
import { Monitor, Camera, Globe, Terminal } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default function RemoteControlPage() {
  const { remoteSessions, remoteSessionCount, matchedCalls, artifactCount } = getRemoteControlData();

  if (remoteSessions.length === 0 && matchedCalls === 0) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Remote Control</h1>
            <p className="page-sub">No remote activity detected</p>
          </div>
        </div>
        <EmptyState
          icon="shield-check"
          title="No remote control activity"
          description="Sessions with browser automation, screenshots, or remote access will appear here once detected."
          action={{ label: 'View sessions', href: '/sessions' }}
        />
      </div>
    );
  }

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Remote Control</h1>
          <p className="page-sub">Browser automation, screenshot capture, and remote access audit</p>
        </div>
      </div>

      {/* Drilldown tiles */}
      <div className="mb-20">
        <DrilldownTiles tiles={[
          { label: 'Remote sessions', value: fmtNum(remoteSessionCount), detail: 'with detected activity', href: '/sessions', icon: <Monitor size={18} />, tone: remoteSessionCount > 0 ? 'info' : 'neutral' },
          { label: 'Matched tool calls', value: fmtNum(matchedCalls), detail: 'browser / screenshot / file-transfer', href: '/sessions', icon: <Terminal size={18} />, tone: 'accent' },
          { label: 'Artifacts', value: fmtNum(artifactCount), detail: 'screenshots & files', href: '/sessions', icon: <Camera size={18} />, tone: artifactCount > 0 ? 'warn' : 'neutral' },
        ]} />
      </div>

      {/* Evidence schema as visual cards */}
      <ErrorBoundary fallbackTitle="Evidence categories failed to render">
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">What we scan for</h3>
            <p className="card-sub">tool calls whose input/output mention these are flagged as remote-control evidence</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {[
              { icon: <Globe size={16} />, label: 'Browser automation', desc: 'Playwright, Puppeteer, Selenium', tone: 'info' },
              { icon: <Camera size={16} />, label: 'Screenshots', desc: 'screen capture', tone: 'accent' },
              { icon: <Terminal size={16} />, label: 'Clipboard', desc: 'clipboard read/write', tone: 'warn' },
            ].map(cat => (
              <div key={cat.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 'var(--r)', border: '1px solid var(--border-faint)' }}>
                <span style={{ color: `var(--${cat.tone})`, marginTop: 2 }}>{cat.icon}</span>
                <div>
                  <div className="f13 fw6">{cat.label}</div>
                  <div className="f12 muted">{cat.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      </ErrorBoundary>

      {/* Remote sessions (collapsible) */}
      <ErrorBoundary fallbackTitle="Remote sessions table failed to render">
      <div className="card">
        {remoteSessions.length > 0 ? (
          <Collapsible title="Remote-control sessions" count={remoteSessions.length} defaultOpen>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Agent</th>
                    <th className="num">Duration</th>
                    <th className="num">Commands</th>
                    <th>Evidence</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {remoteSessions.map((s: any) => (
                    <tr key={s.id} className="clickable">
                      <td>
                        <Link href={`/sessions/${s.id}`}>
                          <span className="hash fw6" style={{ color: 'var(--text)' }}>{String(s.id).slice(0, 8)}</span>
                          <br /><span className="f12 subtle">{s.title || s.first_user_message?.slice(0, 40) || '—'}</span>
                        </Link>
                      </td>
                      <td><span className="tag-mono">{s.agent || '—'}</span></td>
                      <td className="num">{fmtDuration(s.duration_ms)}</td>
                      <td className="num">{fmtNum(s.commandCount)}</td>
                      <td>
                        {s.evidenceTypes.map((t: string) => (
                          <span key={t} className="badge badge-info" style={{ marginRight: 4 }}>{t}</span>
                        ))}
                      </td>
                      <td><span className="f12 muted">{s.started_at ? timeAgo(s.started_at) : '—'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Collapsible>
        ) : (
          <div className="card-pad" style={{ textAlign: 'center', padding: 40 }}>
            <Monitor size={32} style={{ color: 'var(--text-subtle)', marginBottom: 12 }} />
            <h3 className="fw6" style={{ marginBottom: 8 }}>No remote activity detected</h3>
            <p className="muted f13">Sessions with browser automation, screenshots, or clipboard activity will appear here.</p>
          </div>
        )}
      </div>
      </ErrorBoundary>
    </div>
  );
}
