#!/usr/bin/env node
// Friendly next-step hint after install. npm's package page always shows
// `npm i @agentdx/agentdx` (a LOCAL install with no `agentdx` on PATH), which
// strands users — so tell them exactly how to actually run it.
try {
  const global = process.env.npm_config_global === 'true';
  const run = global ? 'agentdx' : 'npx @agentdx/agentdx';
  const C = process.stdout.isTTY ? (s) => `\x1b[32m${s}\x1b[0m` : (s) => s;
  process.stdout.write(
    `\n  ${C('✓')} AgentDX installed.\n` +
    `  Start it:  ${C(run)}\n` +
    `  → collects your AI coding-agent sessions, then opens the local dashboard.\n` +
    (global ? '' : `  (installed locally — or run \`npm i -g @agentdx/agentdx\` to get the \`agentdx\` command)\n`) +
    `\n`
  );
} catch {
  // never fail an install over a hint
}
