import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const dynamic = 'force-dynamic';

/**
 * Run a one-shot collection on user request — the dashboard "Refresh" button.
 *
 * This is a LOCAL action only: it shells out to the same `agentdx collect`
 * the CLI runs, writing to the canonical SQLite DB. Nothing is sent anywhere.
 *
 * Binary resolution:
 *  - Dev repo: the web app runs from <root>/web, so the CLI entry sits at
 *    ../bin/agentdx.mjs relative to cwd — invoke it with the current node.
 *  - Installed: the web app is copied to ~/.agentdx/web (that relative path
 *    doesn't exist), so fall back to the `agentdx` binary on PATH.
 *
 * `collect` resolves its own DB path (defaults to ~/.agentdx/agentdx.db) and
 * does NOT read AGENTDX_DB, so pass the dashboard's DB through with --db.
 */
export async function POST() {
  const dbPath = process.env.AGENTDX_DB || join(homedir(), '.agentdx', 'agentdx.db');
  const devBin = join(process.cwd(), '..', 'bin', 'agentdx.mjs');
  const useDevBin = existsSync(devBin);

  const cmd = useDevBin ? process.execPath : 'agentdx';
  const args = useDevBin ? [devBin, 'collect', '--db', dbPath] : ['collect', '--db', dbPath];

  return new Promise<NextResponse>((resolve) => {
    let settled = false;
    const done = (res: NextResponse) => { if (!settled) { settled = true; resolve(res); } };

    const child = spawn(cmd, args, {
      env: { ...process.env, AGENTDX_DB: dbPath },
      shell: process.platform === 'win32',
    });

    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) =>
      done(NextResponse.json({ error: err.message }, { status: 500 })),
    );
    child.on('close', (code) => {
      if (code === 0) done(NextResponse.json({ ok: true }));
      else done(NextResponse.json({ error: stderr.trim() || `collect exited with code ${code}` }, { status: 500 }));
    });
  });
}
