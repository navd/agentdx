import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir, platform } from 'os';
import type Database from 'better-sqlite3';
import { parseSessionJsonl, discoverSubagentFiles } from './claude.js';
import { createDbWriter, persistSession, emptyStats, isPermissionError, truncate } from './shared.js';
import type { CollectorStats } from './shared.js';

// Cowork — Claude desktop app's local agent mode. Every Cowork session runs
// Claude Code inside a sandboxed workspace; the workspace carries its own
// $HOME with standard Claude Code transcripts at .claude/projects/*/*.jsonl,
// so the claude.ts parser applies verbatim.
//
// Layout: <base>/<accountId>/<envId>/local_<sessionId>/   (workspace dir)
//         <base>/<accountId>/<envId>/local_<sessionId>.json (metadata: title, model, cwd)
//
// SECURITY: the workspace root also holds .claude/.credentials.json and the
// user's uploaded files. This collector must only ever read the metadata JSON
// and .claude/projects/**/*.jsonl — nothing else from the sandbox.

export function coworkBaseDir(): string | null {
  const home = homedir();
  const candidates =
    platform() === 'darwin' ? [join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')]
    : platform() === 'win32' ? [join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions')]
    : [join(home, '.config', 'Claude', 'local-agent-mode-sessions')];
  return candidates.find(existsSync) || null;
}

interface CoworkWorkspace {
  dir: string;       // .../local_<id>
  metaFile: string;  // .../local_<id>.json (may not exist)
}

export function discoverCoworkWorkspaces(base: string): CoworkWorkspace[] {
  const out: CoworkWorkspace[] = [];
  let accounts: string[];
  try {
    accounts = readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(base, d.name));
  } catch (err: any) {
    if (isPermissionError(err)) { console.warn(`[cowork] Permission denied reading ${base}, skipping`); return []; }
    throw err;
  }
  for (const acct of accounts) {
    let envs: string[];
    try {
      envs = readdirSync(acct, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(acct, d.name));
    } catch { continue; }
    for (const env of envs) {
      let entries: ReturnType<typeof readdirSync>;
      try { entries = readdirSync(env, { withFileTypes: true }) as any; } catch { continue; }
      for (const e of entries as any[]) {
        if (e.isDirectory() && e.name.startsWith('local_')) {
          out.push({ dir: join(env, e.name), metaFile: join(env, e.name + '.json') });
        }
      }
    }
  }
  return out;
}

interface CoworkMeta {
  title: string | null;
  model: string | null;
  createdAt: number | null;
}

function readMeta(metaFile: string): CoworkMeta {
  try {
    const d = JSON.parse(readFileSync(metaFile, 'utf-8'));
    return {
      title: typeof d.title === 'string' ? d.title : null,
      model: typeof d.model === 'string' ? d.model : null,
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : null,
    };
  } catch {
    return { title: null, model: null, createdAt: null };
  }
}

// Transcript project dirs inside one workspace's sandboxed .claude.
function workspaceProjectDirs(workspaceDir: string): string[] {
  const projects = join(workspaceDir, '.claude', 'projects');
  if (!existsSync(projects)) return [];
  try {
    return readdirSync(projects, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(projects, d.name));
  } catch {
    return [];
  }
}

export async function collectCowork(
  db: Database.Database,
  base: string,
  onProgress?: (done: number, total: number) => void,
): Promise<CollectorStats> {
  const stats = emptyStats();
  const w = createDbWriter(db);

  const insertSubagent = db.prepare(`
    INSERT OR REPLACE INTO subagents (id, parent_session_id, agent, kind, workflow_id, model,
      input_tokens, output_tokens, cache_read, cache_write, tool_call_count, message_count,
      started_at, ended_at, source_path)
    VALUES (@id, @parent_session_id, @agent, @kind, @workflow_id, @model,
      @input_tokens, @output_tokens, @cache_read, @cache_write, @tool_call_count, @message_count,
      @started_at, @ended_at, @source_path)
  `);

  const workspaces = discoverCoworkWorkspaces(base);
  let done = 0;
  onProgress?.(0, workspaces.length);

  for (const ws of workspaces) {
    const sourceKey = `cowork::${ws.dir}`;
    const watermark = w.getWatermark.get(sourceKey) as { last_timestamp: number | null } | undefined;
    const meta = readMeta(ws.metaFile);

    for (const projDir of workspaceProjectDirs(ws.dir)) {
      let files: string[];
      try {
        files = readdirSync(projDir).filter(f => f.endsWith('.jsonl')).map(f => join(projDir, f));
      } catch (err: any) {
        if (isPermissionError(err)) console.warn(`[cowork] Permission denied reading ${projDir}, skipping`);
        continue;
      }

      for (const file of files) {
        try {
          const fileStat = statSync(file);
          if (watermark && watermark.last_timestamp && fileStat.mtimeMs <= watermark.last_timestamp) {
            continue;
          }

          const parsed = await parseSessionJsonl(file);
          if (!parsed || parsed.messages.length === 0) continue;

          parsed.session.agent = 'cowork';
          // The workspace metadata's title beats the transcript-derived one,
          // and the sandbox cwd (/sessions/<codename>) is meaningless outside
          // the VM — drop it so it never pollutes the repositories rollup.
          if (meta.title) parsed.session.title = truncate(meta.title, 200);
          parsed.session.project_path = null;
          parsed.session.git_branch = null;
          if (!parsed.session.model_primary && meta.model) parsed.session.model_primary = meta.model;

          // Roll sub-agent transcripts into the parent, mirroring claude.ts.
          // Rows are buffered and inserted AFTER persistSession — subagents has
          // a FK on sessions(id), so the parent row must land first.
          const subRows: any[] = [];
          for (const sf of discoverSubagentFiles(projDir, parsed.session.id)) {
            let sp: Awaited<ReturnType<typeof parseSessionJsonl>> = null;
            try { sp = await parseSessionJsonl(sf); } catch { continue; }
            if (!sp || sp.messages.length === 0) continue;
            const wfMatch = sf.match(/\/subagents\/workflows\/(wf_[A-Za-z0-9-]+)\//);

            parsed.session.total_input_tokens += sp.session.total_input_tokens;
            parsed.session.total_output_tokens += sp.session.total_output_tokens;
            parsed.session.total_cache_read += sp.session.total_cache_read;
            parsed.session.total_cache_write += sp.session.total_cache_write;

            for (const [m, mu] of sp.modelUsage) {
              const ex = parsed.modelUsage.get(m) || {
                session_id: parsed.session.id, model: m,
                input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, message_count: 0,
              };
              ex.input_tokens += mu.input_tokens;
              ex.output_tokens += mu.output_tokens;
              ex.cache_read += mu.cache_read;
              ex.cache_write += mu.cache_write;
              ex.message_count += mu.message_count;
              parsed.modelUsage.set(m, ex);
            }

            subRows.push({
              id: `${parsed.session.id}:${basename(sf, '.jsonl')}`,
              parent_session_id: parsed.session.id,
              agent: 'cowork',
              kind: wfMatch ? 'workflow' : 'task',
              workflow_id: wfMatch ? wfMatch[1] : null,
              model: sp.session.model_primary || null,
              input_tokens: sp.session.total_input_tokens,
              output_tokens: sp.session.total_output_tokens,
              cache_read: sp.session.total_cache_read,
              cache_write: sp.session.total_cache_write,
              tool_call_count: sp.toolCalls.length,
              message_count: sp.messages.length,
              started_at: sp.session.started_at,
              ended_at: sp.session.ended_at,
              source_path: sf,
            });
          }

          const before = stats.sessions;
          persistSession(w, parsed, stats);
          // Only attach sub-agents when the parent actually persisted
          // (persistSession silently skips invalid-timestamp sessions).
          if (stats.sessions > before) {
            for (const sr of subRows) insertSubagent.run(sr);
          }
        } catch (err: any) {
          if (isPermissionError(err)) {
            console.warn(`[cowork] Permission denied reading ${file}, skipping`);
          } else {
            stats.errors.push(`${file}: ${err.message}`);
          }
        }
      }
    }

    w.setWatermark.run({
      source: sourceKey,
      last_file: null,
      last_offset: 0,
      last_session_id: null,
      last_timestamp: Date.now(),
      updated_at: Date.now(),
    });

    onProgress?.(++done, workspaces.length);
  }

  return stats;
}
