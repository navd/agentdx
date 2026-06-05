import type { NextConfig } from 'next';
import path from 'path';
import { readFileSync } from 'fs';

// Version is single-sourced from the root package.json. In the npx flow the CLI
// passes AGENTDX_VERSION (the web dir is copied without the root manifest); in
// the dev repo we read ../package.json directly.
function resolveVersion(): string {
  if (process.env.AGENTDX_VERSION) return process.env.AGENTDX_VERSION;
  try { return JSON.parse(readFileSync(path.join(process.cwd(), '..', 'package.json'), 'utf8')).version; } catch { return 'dev'; }
}

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  env: { AGENTDX_VERSION: resolveVersion() },
  // Hide Next's dev-tools overlay (the floating button) — the CLI serves via
  // `next dev`, so without this end users would see Next's own dev menu.
  devIndicators: false,
  // Pin the workspace root to this app dir. Without this, Next walks up the
  // tree and may pick a parent lockfile (e.g. npx's) as the root, which breaks
  // TypeScript transpilation of the app's own source.
  outputFileTracingRoot: path.join(process.cwd()),
};

export default nextConfig;
