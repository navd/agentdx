import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

// Performs `npm i -g @agentdx/agentdx@latest` locally on user request. This is
// the only write/network action the dashboard takes, and only when the user
// clicks "Update". Nothing is sent — npm pulls the package.
export async function POST() {
  try {
    await run('npm', ['install', '-g', '@agentdx/agentdx@latest'], {
      timeout: 180000,
      shell: process.platform === 'win32',
    });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'update failed' }, { status: 500 });
  }
}
