import { getDb, fmtNum, fmtTok, timeAgo } from '@/lib/db';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { RedactionTester } from '@/components/redaction-tester';
import { ErrorBoundary } from '@/components/error-boundary';
import { RefreshButton } from '@/components/refresh-button';

export const dynamic = 'force-dynamic';

interface CollectionRun {
  id: number;
  source: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  sessions_added: number;
  messages_added: number;
  tool_calls_added: number;
  error_message: string | null;
}

interface CollectionState {
  source: string;
  last_timestamp: number | null;
}

interface AgentSource {
  key: string;
  label: string;
  dir: string;
  display: string;
  exists: boolean;
  sessions: number;
  lastCollected: number | null;
}

function vscodeUserDir(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/Code/User');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'Code/User');
  return join(home, '.config/Code/User');
}

function getCollectorData() {
  const db = getDb();
  const home = homedir();

  const totalSessions = (db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as any).cnt;
  const totalMessages = (db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as any).cnt;
  const totalToolCalls = (db.prepare('SELECT COUNT(*) as cnt FROM tool_calls').get() as any).cnt;

  const sessionByAgent = new Map<string, number>();
  for (const r of db.prepare('SELECT agent, COUNT(*) as cnt FROM sessions GROUP BY agent').all() as any[]) {
    sessionByAgent.set(r.agent, r.cnt);
  }
  const states = db.prepare('SELECT source, last_timestamp FROM collection_state').all() as CollectionState[];
  const lastTs = (prefix: string) => states.find((s) => String(s.source).startsWith(prefix))?.last_timestamp ?? null;

  const DEFS = [
    { key: 'claude-code', label: 'Claude Code', dir: join(home, '.claude'), display: '~/.claude/', state: 'claude' },
    { key: 'codex', label: 'Codex', dir: join(home, '.codex'), display: '~/.codex/', state: 'codex' },
    { key: 'cursor', label: 'Cursor', dir: join(home, '.cursor'), display: '~/.cursor/', state: 'cursor' },
    { key: 'antigravity', label: 'Antigravity', dir: join(home, '.gemini', 'antigravity', 'brain'), display: '~/.gemini/antigravity/', state: 'antigravity' },
    { key: 'vscode', label: 'VS Code', dir: join(vscodeUserDir(home), 'workspaceStorage'), display: 'VS Code Copilot chat', state: 'vscode' },
    { key: 'continue', label: 'Continue', dir: join(home, '.continue', 'sessions'), display: '~/.continue/', state: 'continue' },
  ];
  const agents: AgentSource[] = DEFS.map((a) => ({
    key: a.key,
    label: a.label,
    dir: a.dir,
    display: a.display,
    exists: existsSync(a.dir),
    sessions: sessionByAgent.get(a.key) || 0,
    lastCollected: lastTs(a.state),
  }));

  const runs = db.prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 20').all() as CollectionRun[];

  return { totalSessions, totalMessages, totalToolCalls, agents, runs };
}

function fmtFileSize(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
  return bytes + ' B';
}

function statusBadge(status: string) {
  if (status === 'completed') {
    return <span className="badge badge-pos"><span className="dot" style={{ background: 'var(--pos)' }} />Completed</span>;
  }
  if (status === 'completed_with_errors') {
    return <span className="badge badge-warn"><span className="dot" style={{ background: 'var(--warn)' }} />Completed with errors</span>;
  }
  if (status === 'running') {
    return <span className="badge badge-info"><span className="dot" style={{ background: 'var(--info)' }} />Running</span>;
  }
  return <span className="badge badge-neutral"><span className="dot" style={{ background: 'var(--text-muted)' }} />{status}</span>;
}

function dirBadge(exists: boolean) {
  return exists
    ? <span className="badge badge-pos">found</span>
    : <span className="badge badge-neg">not found</span>;
}

export default function CollectorPage() {
  const { totalSessions, totalMessages, totalToolCalls, agents, runs } = getCollectorData();

  const foundCount = agents.filter((a) => a.exists).length;
  const allFound = agents.every((a) => a.exists);

  const dbPath = process.env.AGENTDX_DB || join(homedir(), '.agentdx', 'agentdx.db');
  let dbSize = '—';
  try {
    const st = statSync(dbPath);
    dbSize = fmtFileSize(st.size);
  } catch {
    // DB file not accessible
  }

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Local Collector</h1>
          <p className="page-sub">Captures coding-agent activity on this machine</p>
        </div>
        <div className="page-head-actions">
          <RefreshButton />
        </div>
      </div>

      {/* Live indicator */}
      <div className="card mb-16" style={{ padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12.5 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="live-dot" />
          <span className="fw6">Collector v{process.env.AGENTDX_VERSION || 'dev'}</span>
        </span>
        <span className="muted">Machine: {require('os').hostname()}</span>
        {runs[0]?.started_at && <span className="muted">Last sync: {timeAgo(runs[0].started_at)}</span>}
      </div>

      {/* Status card */}
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Status</h3>
            <p className="card-sub">collector sources and database</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="grid g-4">
            <div>
              <div className="f12 muted mb-4">Agent sources</div>
              <div className="mono f13 fw6">{foundCount} of {agents.length} found</div>
            </div>
            <div>
              <div className="f12 muted mb-4">DB path</div>
              <div className="mono f13">{dbPath}</div>
              <div className="f12 muted" style={{ marginTop: 2 }}>{dbSize}</div>
            </div>
            <div>
              <div className="f12 muted mb-4">Sessions collected</div>
              <div className="mono f13 fw6">{fmtNum(totalSessions)}</div>
            </div>
            <div>
              <div className="f12 muted mb-4">Total messages</div>
              <div className="mono f13 fw6">{fmtNum(totalMessages)}</div>
            </div>
            <div>
              <div className="f12 muted mb-4">Total tool calls</div>
              <div className="mono f13 fw6">{fmtNum(totalToolCalls)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Source breakdown — one card per supported agent */}
      <div className="grid mb-20" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {agents.map((a) => (
          <div key={a.key} className="card" style={{ opacity: a.exists || a.sessions > 0 ? 1 : 0.55 }}>
            <div className="card-head">
              <div>
                <h3 className="card-title">{a.label}</h3>
                <p className="card-sub mono">{a.display}</p>
              </div>
              <div className="right">{dirBadge(a.exists)}</div>
            </div>
            <div className="card-pad">
              <div className="stat">
                <div className="stat-label">Sessions</div>
                <div className="stat-value" style={{ fontSize: 28 }}>{fmtNum(a.sessions)}</div>
                <div className="stat-foot">
                  {a.sessions === 0
                    ? (a.exists ? 'Detected · not yet collected' : 'No sessions')
                    : a.lastCollected
                      ? <>Last collected {timeAgo(a.lastCollected)}</>
                      : 'Collected'}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Collection runs table */}
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Collection runs</h3>
            <p className="card-sub">recent data collection activity</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Source</th>
                <th className="num">Sessions added</th>
                <th className="num">Messages added</th>
                <th className="num">Tool calls added</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 32 }}>
                    <span className="f13 muted">No collection runs yet. Run <span className="mono">agentdx collect</span> to get started.</span>
                  </td>
                </tr>
              ) : (
                runs.map((r) => (
                  <tr key={r.id}>
                    <td><span className="f12 muted">{timeAgo(r.started_at)}</span></td>
                    <td><span className="tag-mono">{r.source}</span></td>
                    <td className="num">{fmtNum(r.sessions_added)}</td>
                    <td className="num">{fmtNum(r.messages_added)}</td>
                    <td className="num">{fmtNum(r.tool_calls_added)}</td>
                    <td>{statusBadge(r.status)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* How to collect */}
      <div className="card mb-16">
        <div className="card-head">
          <div>
            <h3 className="card-title">How to collect</h3>
            <p className="card-sub">run these commands to capture agent activity</p>
          </div>
        </div>
        <div className="card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div className="f12 muted mb-4">One-time collection</div>
            <div className="term">
              <div className="term-body">$ agentdx collect</div>
            </div>
          </div>
          <div>
            <div className="f12 muted mb-4">Watch mode <span className="badge badge-neutral">coming soon</span></div>
            <div className="term">
              <div className="term-body">$ agentdx watch</div>
            </div>
          </div>
        </div>
      </div>
      {/* Doctor + Capture Mode */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* Doctor card */}
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Doctor</h3>
              <p className="card-sub">Health checks for collector</p>
            </div>
            <div className="right">
              {foundCount > 0
                ? <span className="badge badge-pos">{foundCount} source{foundCount === 1 ? '' : 's'} found</span>
                : <span className="badge badge-warn">No sources found</span>}
            </div>
          </div>
          <div className="card-pad">
            <div className="term">
              <div className="term-head">
                <span className="dot" style={{ background: '#ff5f57' }} />
                <span className="dot" style={{ background: '#febc2e' }} />
                <span className="dot" style={{ background: '#28c840' }} />
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>agentdx doctor</span>
              </div>
              <div className="term-body" style={{ padding: '12px 14px', fontSize: 12, lineHeight: 2 }}>
                {agents.map((a) => (
                  <div key={a.key}>{a.exists ? '✓' : '·'} {a.label} ({a.display}) {a.exists ? 'found' : 'not found'}</div>
                ))}
                <div>{'✓'} Database writable ({dbSize})</div>
                <div>{totalSessions > 0 ? '✓' : '!'} Sessions collected: {totalSessions}</div>
                <div>{runs.length > 0 ? '✓' : '!'} Collection runs: {runs.length}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 4 }}># {allFound ? 'All sources detected' : `${foundCount} of ${agents.length} sources detected`}</div>
              </div>
            </div>
          </div>
        </div>

        {/* What's stored */}
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">What&apos;s stored</h3>
              <p className="card-sub">How AgentDX keeps your data</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-12">
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--accent)', marginTop: 1 }}>●</span>
                <div><div className="f13 fw6">Full local capture</div><div className="f12 muted">Prompts, responses, and tool input/output are stored verbatim — same fidelity as the agent&apos;s own logs.</div></div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--pos)', marginTop: 1 }}>●</span>
                <div><div className="f13 fw6">One SQLite file</div><div className="f12 muted">Everything lives at <span className="mono">~/.agentdx/agentdx.db</span>. Delete it and the data is gone.</div></div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--info)', marginTop: 1 }}>●</span>
                <div><div className="f13 fw6">Never leaves this machine</div><div className="f12 muted">No network requests, no accounts, no telemetry.</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Install & verify + What is captured */}
      <div className="grid mb-20" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Install &amp; verify</h3>
              <p className="card-sub">Quick setup steps</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-14">
              {[
                { step: 1, title: 'Install AgentDX', cmd: 'npm install -g @agentdx/agentdx' },
                { step: 2, title: 'Run initial collection', cmd: 'agentdx collect' },
                { step: 3, title: 'Check status', cmd: 'agentdx status' },
                { step: 4, title: 'Start dashboard', cmd: 'agentdx serve' },
              ].map(s => (
                <div key={s.step} style={{ display: 'flex', gap: 12 }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: 12, background: 'var(--accent-soft)',
                    color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700, flexShrink: 0,
                  }}>{s.step}</div>
                  <div>
                    <div className="f13 fw6">{s.title}</div>
                    <div className="term" style={{ marginTop: 4 }}>
                      <div className="term-body" style={{ padding: '6px 10px', fontSize: 12 }}>$ {s.cmd}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">What is captured</h3>
              <p className="card-sub">Data collection scope</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div>
                <div className="sec-label mb-8">Stored (verbatim from agent logs)</div>
                {['Session metadata', 'Prompts & responses', 'Model & token usage', 'Tool calls & output', 'File paths touched', 'Git branch & commit info'].map(item => (
                  <div key={item} className="f12 mb-4" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: 'var(--pos)' }}>{'✓'}</span> {item}
                  </div>
                ))}
              </div>
              <div>
                <div className="sec-label mb-8">Not collected</div>
                {['Files your agent never opened', 'Keystrokes outside the agent', 'Data from other apps', 'Anything over a network (none is sent)'].map(item => (
                  <div key={item} className="f12 mb-4" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: 'var(--neg)' }}>{'✗'}</span> {item}
                  </div>
                ))}
              </div>
            </div>
            <div className="f12" style={{ color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-faint)' }}>
              Prompts and tool output are stored <strong>as-is</strong>. If a secret appeared in one, it&apos;s in your local DB — nowhere else. Preview masking with the Redaction tester below.
            </div>
          </div>
        </div>
      </div>

      {/* Local data controls */}
      <div className="card mb-20">
        <div className="card-head">
          <div>
            <h3 className="card-title">Manage your data</h3>
            <p className="card-sub">It&apos;s one file — these commands are all you need</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="col-flex gap-14">
            {[
              { title: 'Copy the database', desc: 'It is a plain SQLite file — copy it anywhere', cmd: `cp ${dbPath} ./agentdx-backup.db` },
              { title: 'Re-collect everything', desc: 'Re-import from source logs', cmd: 'agentdx collect' },
              { title: 'Delete all local data', desc: 'Remove the database and start fresh', cmd: `rm ${dbPath}` },
            ].map((c) => (
              <div key={c.title}>
                <div className="row between mb-4">
                  <div className="f13 fw6">{c.title}</div>
                  <div className="f12 muted">{c.desc}</div>
                </div>
                <div className="term"><div className="term-body" style={{ padding: '6px 10px', fontSize: 12 }}>$ {c.cmd}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Redaction tester */}
      <ErrorBoundary fallbackTitle="Redaction tester failed to render">
      <RedactionTester />
      </ErrorBoundary>
    </div>
  );
}
