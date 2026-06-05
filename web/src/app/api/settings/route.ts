import { NextResponse } from 'next/server';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const configPath = join(homedir(), '.agentdx', 'config.json');

    let config: Record<string, unknown> = {};
    try {
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, 'utf8'));
      }
    } catch {
      // start fresh if corrupt
    }

    const ALLOWED_KEYS = [
      'theme',
      'default_period',
      'page_size',
      'collection_interval',
      'auto_collect',
    ];
    const NUMERIC_KEYS = new Set(['page_size', 'collection_interval']);
    const BOOLEAN_KEYS = new Set(['auto_collect']);

    const safeBody = Object.fromEntries(
      Object.entries(body)
        .filter(([k]) => ALLOWED_KEYS.includes(k))
        .map(([k, v]) => {
          if (NUMERIC_KEYS.has(k)) return [k, Number(v)];
          if (BOOLEAN_KEYS.has(k)) return [k, Boolean(v)];
          return [k, v];
        })
        .filter(([, v]) => !(typeof v === 'number' && Number.isNaN(v))),
    );
    Object.assign(config, safeBody);

    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
