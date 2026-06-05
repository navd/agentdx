import { getDb, fmtNum, timeAgo } from '@/lib/db';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SettingsNav } from '@/components/settings-nav';
import { ThemeControl, SelectRow, ToggleRow } from '@/components/settings-controls';
import { readUserConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface CollectionRun {
  id: number;
  started_at: number;
  completed_at: number | null;
  source: string;
  sessions_added: number;
  messages_added: number;
  tool_calls_added: number;
  errors: string | null;
  status: string;
}

function getSettingsData() {
  const db = getDb();

  // Table row counts
  const tables = ['sessions', 'messages', 'tool_calls', 'model_usage', 'repositories'] as const;
  const tableCounts: Record<string, number> = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get() as any;
    tableCounts[t] = row?.cnt ?? 0;
  }

  // Session counts per agent
  const agentCounts = db.prepare(`
    SELECT agent, COUNT(*) as cnt
    FROM sessions
    GROUP BY agent
    ORDER BY cnt DESC
  `).all() as { agent: string; cnt: number }[];

  // Collection runs (last 10)
  const collectionRuns = db.prepare(`
    SELECT id, started_at, completed_at, source, sessions_added,
           messages_added, tool_calls_added, errors, status
    FROM collection_runs
    ORDER BY started_at DESC
    LIMIT 10
  `).all() as CollectionRun[];

  return { tableCounts, agentCounts, collectionRuns };
}

function getDbPath(): string {
  // Same canonical path db.ts opens, so the shown path/size/existence matches
  // the database the dashboard actually reads.
  return process.env.AGENTDX_DB || join(homedir(), '.agentdx', 'agentdx.db');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
  return bytes + ' B';
}

export default function SettingsPage() {
  const { tableCounts, agentCounts, collectionRuns } = getSettingsData();
  const cfg = readUserConfig();

  // Data source detection
  const home = homedir();
  const vscodeUser = process.platform === 'darwin'
    ? join(home, 'Library/Application Support/Code/User')
    : process.platform === 'win32'
      ? join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'Code/User')
      : join(home, '.config/Code/User');

  const dataSources = [
    { name: 'Claude Code', path: join(home, '.claude'), agent: 'claude-code' },
    { name: 'Codex', path: join(home, '.codex'), agent: 'codex' },
    { name: 'Cursor', path: join(home, '.cursor'), agent: 'cursor' },
    { name: 'Antigravity', path: join(home, '.gemini', 'antigravity', 'brain'), agent: 'antigravity', note: 'Google Antigravity trajectories' },
    { name: 'VS Code', path: join(vscodeUser, 'workspaceStorage'), agent: 'vscode', note: 'GitHub Copilot chat sessions' },
    { name: 'Continue', path: join(home, '.continue', 'sessions'), agent: 'continue', note: 'Continue.dev sessions' },
  ];

  const sourceInfo = dataSources.map((ds: any) => {
    const exists = existsSync(ds.path);
    const sessionCount = agentCounts.find((a: any) => a.agent === ds.agent)?.cnt ?? 0;
    return { ...ds, exists, sessionCount };
  });

  // Database info
  const dbPath = getDbPath();
  const dbExists = existsSync(dbPath);
  let dbSize = 0;
  if (dbExists) {
    try {
      dbSize = statSync(dbPath).size;
    } catch {
      // ignore
    }
  }

  const totalRows = Object.values(tableCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Configuration and data sources</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 24, alignItems: 'start' }}>
        <SettingsNav />

        {/* Settings panels */}
        <div className="col-flex gap-20" style={{ maxWidth: 760 }}>

      {/* Data Sources + Database */}
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }} id="sources">
        {/* Data Sources card */}
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Data Sources</h3>
              <p className="card-sub">Detected agent directories</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-16">
              {sourceInfo.map((src) => (
                <div key={src.name} className="row between" style={{ alignItems: 'flex-start' }}>
                  <div>
                    <div className="fw6 f13" style={{ marginBottom: 4 }}>{src.name}</div>
                    <div className="mono f12 muted">{src.path}</div>
                    {src.exists && (
                      <div className="f12 muted" style={{ marginTop: 2 }}>
                        {fmtNum(src.sessionCount)} sessions captured
                      </div>
                    )}
                  </div>
                  <div>
                    {src.exists ? (
                      <span className="badge badge-pos"><span className="dot" style={{ background: 'var(--pos)' }}></span>Connected</span>
                    ) : (
                      <span className="badge badge-neg"><span className="dot" style={{ background: 'var(--neg)' }}></span>Not found</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Database card */}
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Database</h3>
              <p className="card-sub">SQLite storage</p>
            </div>
          </div>
          <div className="card-pad">
            <div className="col-flex gap-12">
              <div>
                <div className="f12 muted" style={{ marginBottom: 2 }}>Path</div>
                <div className="mono f12" style={{ wordBreak: 'break-all' }}>{dbPath}</div>
              </div>
              <div>
                <div className="f12 muted" style={{ marginBottom: 2 }}>File size</div>
                <div className="mono f13 fw6">{dbExists ? formatBytes(dbSize) : 'Not found'}</div>
              </div>
              <div>
                <div className="f12 muted" style={{ marginBottom: 6 }}>Table row counts</div>
                <div className="col-flex gap-4">
                  {Object.entries(tableCounts).map(([table, count]) => (
                    <div key={table} className="row between">
                      <span className="tag-mono">{table}</span>
                      <span className="mono f13 fw6">{fmtNum(count)}</span>
                    </div>
                  ))}
                  <div className="row between" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 4 }}>
                    <span className="f12 muted">Total rows</span>
                    <span className="mono f13 fw6">{fmtNum(totalRows)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Display settings */}
      <div className="card" id="display">
        <div className="card-head">
          <div>
            <h3 className="card-title">Display</h3>
            <p className="card-sub">Dashboard appearance preferences</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="col-flex gap-16">
            <ThemeControl initial={cfg.theme} />
            <SelectRow
              id="display-period" title="Default period" sub="Default time range for overview"
              field="default_period" initial={cfg.default_period}
              options={[
                { value: '30d', label: 'Last 30 days' },
                { value: '90d', label: 'Last 90 days' },
                { value: 'qtd', label: 'Quarter to date' },
                { value: 'ytd', label: 'Year to date' },
                { value: 'all', label: 'All time' },
              ]}
            />
            <SelectRow
              id="display-pagination" title="Items per page" sub="Default pagination size"
              field="page_size" initial={cfg.page_size} numeric
              options={[
                { value: 10, label: '10' },
                { value: 25, label: '25' },
                { value: 50, label: '50' },
                { value: 100, label: '100' },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Collection settings */}
      <div className="card" id="collection">
        <div className="card-head">
          <div>
            <h3 className="card-title">Collection</h3>
            <p className="card-sub">Data collection preferences</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="col-flex gap-16">
            <ToggleRow
              id="collection-auto" title="Auto-collect on startup"
              sub="Run collection when the dashboard starts" field="auto_collect" initial={cfg.auto_collect}
            />
            <SelectRow
              id="collection-interval" title="Collection interval" sub="How often to auto-collect in watch mode"
              field="collection_interval" initial={cfg.collection_interval} numeric
              options={[
                { value: 1, label: '1 minute' },
                { value: 5, label: '5 minutes' },
                { value: 15, label: '15 minutes' },
                { value: 30, label: '30 minutes' },
                { value: 60, label: '60 minutes' },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Privacy */}
      <div className="card" id="privacy">
        <div className="card-head">
          <div>
            <h3 className="card-title">Privacy</h3>
            <p className="card-sub">Where your data lives</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>🔒</span>
            <div className="f13" style={{ lineHeight: 1.6 }}>
              <strong>Local-first.</strong> AgentDX reads your agents&apos; local logs and writes a single SQLite file on this machine. <strong>No telemetry, no accounts, no uploads</strong> — your sessions, prompts, code, and tokens never leave your computer. The only outbound request is a read-only version check against npm (no data sent) so it can tell you when an update is out.
            </div>
          </div>
        </div>
      </div>

      {/* Collection History */}
      <div className="card" id="history">
        <div className="card-head">
          <div>
            <h3 className="card-title">Collection History</h3>
            <p className="card-sub">Recent runs · counts are rows processed that run (re-collected sessions are re-counted), not net-new</p>
          </div>
        </div>
        {collectionRuns.length > 0 ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th className="num">Sessions seen</th>
                  <th className="num">Messages seen</th>
                  <th className="num">Tool calls seen</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {collectionRuns.map((run) => (
                  <tr key={run.id}>
                    <td><span className="f12 muted">{timeAgo(run.started_at)}</span></td>
                    <td><span className="tag-mono">{run.source}</span></td>
                    <td className="num">{fmtNum(run.sessions_added)}</td>
                    <td className="num">{fmtNum(run.messages_added)}</td>
                    <td className="num">{fmtNum(run.tool_calls_added)}</td>
                    <td>
                      {run.status === 'completed' ? (
                        <span className="badge badge-pos"><span className="dot" style={{ background: 'var(--pos)' }}></span>completed</span>
                      ) : run.status === 'failed' ? (
                        <span className="badge badge-neg"><span className="dot" style={{ background: 'var(--neg)' }}></span>failed</span>
                      ) : (
                        <span className="badge badge-info"><span className="dot" style={{ background: 'var(--info)' }}></span>{run.status}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card-pad">
            <span className="f13 muted">No collection runs recorded yet</span>
          </div>
        )}
      </div>

      {/* About */}
      <div className="card" id="about">
        <div className="card-head">
          <div>
            <h3 className="card-title">About</h3>
            <p className="card-sub">AgentDX</p>
          </div>
        </div>
        <div className="card-pad">
          <div className="col-flex gap-12">
            <div className="row between">
              <span className="f13 muted">Version</span>
              <span className="mono f13 fw6">{process.env.AGENTDX_VERSION || 'dev'}</span>
            </div>
            <div className="row between">
              <span className="f13 muted">License</span>
              <span className="mono f13">MIT</span>
            </div>
          </div>
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}
