#!/usr/bin/env node

import { Command } from 'commander';
import { execSync, spawn, spawnSync } from 'child_process';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, readFileSync, cpSync, mkdirSync, watch, rmSync } from 'fs';
import { homedir } from 'os';
import { createServer } from 'net';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** Single source of truth for the version — the package's own package.json. */
const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
})();

/**
 * Canonical SQLite database path: ~/.agentdx/agentdx.db.
 * Stable across `collect`/`serve`, independent of cwd, and survives npx cache
 * eviction (unlike a path under the installed package in node_modules).
 */
function defaultDbPath() {
  return join(homedir(), '.agentdx', 'agentdx.db');
}

/** Agent source directories that exist on this machine — targets for fs.watch. */
function sourceWatchDirs() {
  const home = homedir();
  const candidates = [
    join(home, '.claude', 'projects'),
    join(claudeAppDir(), 'local-agent-mode-sessions'), // Cowork
    join(home, '.codex'),
    join(home, '.cursor', 'projects'),
    join(home, '.gemini', 'antigravity', 'brain'), // Antigravity
    join(vscodeUserDir(), 'workspaceStorage'),     // VS Code Copilot chat
    join(home, '.continue', 'sessions'),           // Continue.dev
    opencodeDataDir(),                             // opencode
  ];
  return candidates.filter((d) => existsSync(d));
}

/** Read ~/.agentdx/config.json (best-effort; {} on any failure). */
function readConfig() {
  try {
    const p = join(homedir(), '.agentdx', 'config.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    // ignore corrupt/missing config
  }
  return {};
}

/**
 * Resolve a runnable web app directory.
 *
 * When installed via npm/npx the package lives under a `node_modules/`
 * path. Next.js / SWC refuse to transpile TypeScript sources whose path
 * contains `/node_modules/`, so running `next dev` in place yields HTTP 500
 * on every route. To avoid this, copy the web app to a writable location
 * OUTSIDE node_modules (~/.agentdx/web) and run it from there.
 *
 * In the dev repo (path has no node_modules) we run in place.
 */
function resolveWebDir() {
  const inRepo = join(root, 'web');
  // If the package is NOT installed under node_modules (dev repo), run in place.
  if (!inRepo.includes(`${sep}node_modules${sep}`)) {
    return inRepo;
  }
  const workDir = join(homedir(), '.agentdx', 'web');
  mkdirSync(workDir, { recursive: true });
  // Copy sources to a path outside node_modules. The filter is keyed on the
  // path RELATIVE to the web root — the absolute src always contains
  // "node_modules" (the package lives there), so an absolute-path check would
  // exclude everything. Skip only the web app's own nested node_modules/.next
  // so installed deps + build cache in workDir persist across runs.
  cpSync(inRepo, workDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(inRepo, src);
      if (!rel) return true;
      const segs = rel.split(sep);
      return !segs.includes('node_modules') && !segs.includes('.next');
    },
  });
  return workDir;
}

/** Start the Next.js dashboard. Returns the child process. */
/** Spawn `next dev` on `port`. Resolves once we know the outcome from Next's
 *  output: 'ready' (it bound and is serving) or 'inuse' (EADDRINUSE — the
 *  free-port probe lost a race, so the caller should try the next port). */
function trySpawnDashboard(webDir, port, dbPath) {
  // shell:true so Windows resolves `npx` → `npx.cmd`. Pipe stdout/stderr so we
  // can detect the real bind result instead of optimistically declaring "ready".
  const child = spawn('npx', ['next', 'dev', '-p', String(port)], {
    cwd: webDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, AGENTDX_DB: dbPath, AGENTDX_VERSION: VERSION },
  });
  const outcome = new Promise((resolve) => {
    let settled = false;
    const done = (status) => { if (!settled) { settled = true; resolve(status); } };
    const onData = (buf) => {
      const s = buf.toString();
      if (/EADDRINUSE|address already in use/i.test(s)) done('inuse');
      // Next prints "Local: http://localhost:PORT" / "Ready in …" once bound.
      else if (/(- Local:|Ready in|started server)/i.test(s)) done('ready');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', () => done('inuse')); // exited before binding → treat as unusable
  });
  return { child, outcome };
}

async function startDashboard(webDir, port, dbPath, chalk, requestedPort) {
  if (!existsSync(join(webDir, 'node_modules'))) {
    console.log(chalk.dim('  Installing dashboard dependencies (first run only)…'));
    execSync('npm install', { cwd: webDir, stdio: 'inherit' });
  }
  const p = paint(chalk);
  // The free-port probe can race (something grabs the port between the probe
  // closing and Next binding), so retry the actual spawn across ports too.
  for (let tryPort = port; tryPort < port + 12; tryPort++) {
    const { child, outcome } = trySpawnDashboard(webDir, tryPort, dbPath);
    const status = await outcome;
    if (status === 'ready') {
      if (String(tryPort) !== String(requestedPort)) {
        console.log('  ' + p.yellow(`port ${requestedPort} busy → using ${tryPort}`));
      }
      printDashboardBox(chalk, tryPort);
      // From here on, only surface real errors (Next's compile noise stays hidden).
      child.stderr.on('data', (d) => process.stderr.write(d));
      return child;
    }
    child.kill();
  }
  console.log(p.red(`\n  ✗ No free port in ${requestedPort}–${parseInt(requestedPort, 10) + 11}. Close something or pass --port.\n`));
  process.exit(1);
}

// ── Port handling ────────────────────────────────────────────────
/** True if `port` can be bound (i.e. is free). Mirrors Next's dual-stack bind. */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

/** First free port at or after `start`, scanning up to `attempts` ports. */
async function findFreePort(start, attempts = 12) {
  let p = parseInt(start, 10) || 3002;
  for (let i = 0; i < attempts; i++, p++) {
    if (await portFree(p)) return p;
  }
  return null;
}

// ── Fancy CLI chrome ─────────────────────────────────────────────
const BRAND = '#15803D'; // ledger green (matches dashboard + landing)
const INNER = 46;

function paint(chalk) {
  const c = chalk;
  return {
    green: c.hex ? c.hex(BRAND) : c.green,
    dim: c.dim,
    bold: c.bold,
    red: c.red,
    yellow: c.yellow,
    white: c.white,
  };
}

/** Flight-recorder banner. */
function printBanner(chalk) {
  const p = paint(chalk);
  console.log();
  console.log('  ' + p.red('●') + '  ' + p.bold(p.green('A G E N T D X')) + '   ' + p.dim('your agents, summarized'));
  console.log('  ' + p.dim('━'.repeat(INNER)));
}

// ── Big logo ─────────────────────────────────────────────────────
const LOGO = [
  ' █████╗  ██████╗ ███████╗███╗   ██╗████████╗██████╗ ██╗  ██╗',
  '██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔══██╗╚██╗██╔╝',
  '███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║  ██║ ╚███╔╝ ',
  '██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║  ██║ ██╔██╗ ',
  '██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██████╔╝██╔╝ ██╗',
  '╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═════╝ ╚═╝  ╚═╝',
];
const LOGO_SHADES = ['#0b3d1f', '#14592e', '#15803D', '#1c9b4b', '#22c55e', '#4ade80'];

function printLogoBig(chalk) {
  const p = paint(chalk);
  const cols = process.stdout.columns || 80;
  console.log();
  if (cols < 64 || !chalk.hex) {
    console.log('  ' + p.bold(p.green('A G E N T D X')));
    console.log('  ' + p.dim('your agents, summarized · 100% local'));
    console.log('  ' + p.dim('━'.repeat(INNER)));
    return;
  }
  LOGO.forEach((line, i) => console.log('  ' + chalk.hex(LOGO_SHADES[i])(line)));
  console.log('  ' + p.dim('your agents, summarized · 100% local'));
  console.log('  ' + p.dim('━'.repeat(58)));
}

// ── Animated per-agent collection renderer ───────────────────────
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const AGENT_ORDER = ['claude-code', 'cowork', 'codex', 'cursor', 'antigravity', 'vscode', 'continue', 'opencode'];

/** opencode data dir (opencode.db lives here). */
function opencodeDataDir() {
  const home = homedir();
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'opencode');
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'opencode');
  return join(home, '.local', 'share', 'opencode');
}

/** Claude desktop app dir — Cowork (local agent mode) workspaces live here. */
function claudeAppDir() {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/Claude');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'Claude');
  return join(home, '.config/Claude');
}

/** VS Code User dir (Copilot chat sessions live under workspaceStorage). */
function vscodeUserDir() {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/Code/User');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'Code/User');
  return join(home, '.config/Code/User');
}

function detectSources() {
  const home = homedir();
  return {
    'claude-code': existsSync(join(home, '.claude', 'projects')),
    cowork: existsSync(join(claudeAppDir(), 'local-agent-mode-sessions')),
    codex: existsSync(join(home, '.codex')),
    cursor: existsSync(join(home, '.cursor', 'projects')),
    antigravity: existsSync(join(home, '.gemini', 'antigravity', 'brain')),
    vscode: existsSync(join(vscodeUserDir(), 'workspaceStorage')),
    continue: existsSync(join(home, '.continue', 'sessions', 'sessions.json')),
    opencode: existsSync(join(opencodeDataDir(), 'opencode.db')),
  };
}

function createCollectRenderer(chalk) {
  const p = paint(chalk);
  const tty = !!process.stdout.isTTY;
  const sources = detectSources();
  const BAR_W = 20;
  const NAME_W = Math.max(...AGENT_ORDER.map((a) => a.length));
  const rows = {};
  for (const a of AGENT_ORDER) rows[a] = { state: sources[a] ? 'idle' : 'none', done: 0, total: 0, sessions: 0, finalSessions: null, newSessions: 0 };
  let frame = 0;
  let timer = null;
  let painted = 0;

  function rowStr(name) {
    const r = rows[name];
    const nm = name.padEnd(NAME_W);
    if (r.state === 'none') return `  ${p.dim('·')} ${p.dim(nm)}  ${p.dim('no source')}`;
    if (r.state === 'idle') return `  ${p.dim('·')} ${p.dim(nm)}  ${p.dim('waiting…')}`;
    if (r.state === 'done') {
      const n = r.finalSessions != null ? r.finalSessions : r.sessions;
      if (n === 0) return `  ${p.dim('·')} ${p.dim(nm)}  ${p.dim('no sessions')}`;
      const bar = p.green('█'.repeat(BAR_W));
      const fresh = r.newSessions > 0 ? p.dim(`  +${r.newSessions} new`) : '';
      return `  ${p.green('✓')} ${p.white(nm)}  ${bar} ${p.green(String(n))}${p.dim(' sessions')}${fresh}`;
    }
    // active
    const frac = r.total > 0 ? Math.min(1, r.done / r.total) : 0;
    const filled = Math.round(frac * BAR_W);
    const bar = p.green('█'.repeat(filled)) + p.dim('░'.repeat(BAR_W - filled));
    const detail = r.total > 0 ? `${String(Math.round(frac * 100)).padStart(3)}%  ${r.done}/${r.total}` : 'scanning…';
    return `  ${p.green(SPIN[frame % SPIN.length])} ${p.white(nm)}  ${bar} ${p.dim(detail)}`;
  }

  function paintRows() {
    const lines = AGENT_ORDER.map(rowStr);
    if (tty && painted > 0) process.stdout.write(`\x1b[${painted}A`);
    for (const line of lines) {
      if (tty) process.stdout.write('\x1b[2K' + line + '\n');
      else console.log(line);
    }
    painted = lines.length;
  }

  return {
    hooks: {
      onAgentStart: (a) => { if (rows[a]) rows[a].state = 'active'; },
      onAgentProgress: (a, done, total) => { const r = rows[a]; if (r) { r.state = 'active'; r.done = done; r.total = total; } },
      onAgentDone: (a, stats) => { const r = rows[a]; if (r) { r.state = 'done'; r.sessions = stats.sessions; r.done = r.total || 1; } },
    },
    start() {
      printLogoBig(chalk);
      console.log();
      // In a TTY we paint now and animate in place; without a TTY we can't
      // overwrite lines, so defer the single paint to finalize().
      if (tty) { paintRows(); timer = setInterval(() => { frame++; paintRows(); }, 80); }
    },
    finalize(results) {
      if (timer) { clearInterval(timer); timer = null; }
      for (const r of results || []) {
        const row = rows[r.source];
        if (!row) continue;
        row.state = 'done';
        row.finalSessions = r.totalSessions != null ? r.totalSessions : r.sessions;
        row.newSessions = r.sessions || 0;
      }
      paintRows();
      const totSessions = (results || []).reduce((s, r) => s + (r.totalSessions != null ? r.totalSessions : r.sessions), 0);
      const totMsg = (results || []).reduce((s, r) => s + (r.totalMessages != null ? r.totalMessages : r.messages), 0);
      const totTools = (results || []).reduce((s, r) => s + (r.totalToolCalls != null ? r.totalToolCalls : r.toolCalls), 0);
      console.log('  ' + p.dim('━'.repeat(58)));
      console.log('  ' + p.bold(p.green(String(totSessions))) + p.bold(' sessions') + p.dim(` · ${fmtCount(totMsg)} messages · ${fmtCount(totTools)} tool calls`));
      return totSessions;
    },
  };
}

/** Render one inner row of a box, padding by VISIBLE (uncolored) length. */
function boxRow(chalk, segs) {
  const p = paint(chalk);
  const plain = segs.map((s) => s.t).join('');
  const pad = ' '.repeat(Math.max(0, INNER - plain.length));
  const colored = segs.map((s) => (s.c ? s.c(s.t) : s.t)).join('');
  return p.dim('  │ ') + colored + pad + p.dim(' │');
}

/** Rounded box announcing the live dashboard URL. */
function printDashboardBox(chalk, port) {
  const p = paint(chalk);
  const url = `http://localhost:${port}`;
  console.log();
  console.log(p.dim('  ╭' + '─'.repeat(INNER + 2) + '╮'));
  console.log(boxRow(chalk, [
    { t: '● ', c: p.green }, { t: 'live   ', c: p.green },
    { t: url, c: (s) => p.bold(p.white(s)) },
  ]));
  console.log(boxRow(chalk, [{ t: 'dashboard ready · press Ctrl+C to stop', c: p.dim }]));
  console.log(p.dim('  ╰' + '─'.repeat(INNER + 2) + '╯'));
  console.log();
}

/**
 * Resolve a free port (scanning from `requested`), print the dashboard box,
 * and spawn the server. Exits with guidance if no port is free.
 */
// ── Update check (pull-only: a plain GET to the public npm registry for the
// latest version number — no identifiers, no usage data sent) ────────────────
const PKG = '@agentdx/agentdx';

function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

async function latestVersion() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json())?.version || null;
  } catch { return null; }
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

/**
 * Evict npx's package cache (`$npm_cache/_npx`). Without this, a bare
 * `npx @agentdx/agentdx` keeps re-running the stale cached copy after a global
 * update — npx never re-checks the registry when a cached version satisfies the
 * (empty) range, so the "update available" prompt loops forever. Best-effort.
 */
function clearNpxCache() {
  try {
    const cache = execSync('npm config get cache', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (cache && existsSync(join(cache, '_npx'))) {
      rmSync(join(cache, '_npx'), { recursive: true, force: true });
    }
  } catch { /* non-fatal — update still applied globally */ }
}

/** Check npm for a newer version; offer to update before launching. Fail-safe. */
async function maybePromptUpdate(chalk) {
  const p = paint(chalk);
  const latest = await latestVersion();
  if (!latest || !semverGt(latest, VERSION)) return;
  console.log('\n  ' + p.yellow(`▲ AgentDX ${latest} available`) + p.dim(` (you have ${VERSION})`));
  if (!process.stdin.isTTY) {
    console.log('  ' + p.dim(`update: npm i -g ${PKG}@latest`) + '\n');
    return;
  }
  const ans = (await ask('  Update now before launching? [y/N] ')).trim();
  if (/^y(es)?$/i.test(ans)) {
    console.log();
    try {
      execSync(`npm i -g ${PKG}@latest`, { stdio: 'inherit' });
      // Bust the npx cache so a future bare `npx @agentdx/agentdx` resolves the
      // new version instead of replaying the stale cached copy (prompt loop).
      clearNpxCache();
      console.log('\n  ' + p.green(`Updated to ${latest}.`) + p.dim(' Launching the new version…\n'));
      // Re-exec the NEW version with the same args, pinned to @latest so it
      // bypasses any stale npx cache (otherwise `npx agentdx` re-runs the cached
      // old copy → "update available" prompts forever). The relaunched process
      // is already current, so it won't prompt again.
      const args = process.argv.slice(2);
      const r = spawnSync('npx', ['-y', `${PKG}@${latest}`, ...args], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      process.exit(r.status ?? 0);
    } catch {
      console.log('  ' + p.red('Update failed — continuing with current version.\n'));
    }
  } else {
    console.log();
  }
}

async function launchDashboard(requestedPort, dbPath, chalk) {
  await maybePromptUpdate(chalk);
  const p = paint(chalk);
  const webDir = resolveWebDir();
  if (!existsSync(join(webDir, 'package.json'))) {
    console.log(p.yellow('  Web app not initialized. Run from the agentdx root.'));
    process.exit(1);
  }
  // Best-guess starting port; startDashboard retries from here on the actual
  // bind (the probe can race), and prints the "ready" box only once Next binds.
  const port = (await findFreePort(requestedPort, 12)) || parseInt(requestedPort, 10) || 3002;
  return startDashboard(webDir, port, dbPath, chalk, requestedPort);
}

const program = new Command();

program
  .name('agentdx')
  .description('Your AI coding agents, summarized — local usage, oversight, and risk console')
  .version(VERSION)
  .showHelpAfterError('(run `agentdx --help` for usage)');

program
  .command('collect')
  .description('Collect session data from Claude Code and Codex')
  .option('--claude-dir <path>', 'Path to ~/.claude/')
  .option('--codex-dir <path>', 'Path to ~/.codex/')
  .option('--db <path>', 'Path to SQLite database')
  .option('--verbose', 'Print full error details')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const renderer = createCollectRenderer(chalk);
    renderer.start();

    const { runCollection } = await import('../dist/src/collector/index.js');
    const { results } = await runCollection({
      claudeDir: opts.claudeDir,
      codexDir: opts.codexDir,
      dbPath: opts.db || defaultDbPath(),
    }, renderer.hooks);

    const total = renderer.finalize(results);
    if (total === 0) printZeroAgentsMessage(chalk);
    console.log();
    process.exit(0);
  });

program
  .command('serve')
  .description('Start the dashboard web server')
  .option('-p, --port <port>', 'Port number', '3002')
  .option('--db <path>', 'Path to SQLite database')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const dbPath = opts.db || defaultDbPath();
    printBanner(chalk);

    // Honor the saved "auto-collect on startup" preference.
    if (readConfig().auto_collect) {
      console.log('  ' + chalk.dim('auto-collect enabled — collecting first…'));
      try {
        const { runCollection } = await import('../dist/src/collector/index.js');
        const { results } = await runCollection({ dbPath });
        printCollectSummary(chalk, results);
      } catch (err) {
        console.log('  ' + chalk.red(`collection error: ${err.message}`));
      }
    }

    const child = await launchDashboard(opts.port, dbPath, chalk);

    child.on('exit', (code) => process.exit(code || 0));
    process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
  });

program
  .command('watch')
  .description('Collect, serve dashboard, and re-collect on file changes (interval fallback)')
  .option('--interval <minutes>', 'Fallback re-collection interval in minutes (defaults to saved setting, else 5)')
  .option('--no-poll', 'Disable the interval safety net; rely on file events only')
  .option('-p, --port <port>', 'Port number', '3002')
  .option('--db <path>', 'Path to SQLite database')
  .action(async (opts, command) => {
    const chalk = (await import('chalk')).default;
    // Precedence: explicit --interval flag > saved collection_interval > 5.
    const fromFlag = command.getOptionValueSource('interval') === 'cli' ? parseInt(opts.interval, 10) : NaN;
    const interval = Number.isFinite(fromFlag) && fromFlag > 0
      ? fromFlag
      : (Number(readConfig().collection_interval) > 0 ? Number(readConfig().collection_interval) : 5);
    const dbPath = opts.db || defaultDbPath();

    const { runCollection } = await import('../dist/src/collector/index.js');

    // Single-flight collection runner: coalesce overlapping triggers. If a run
    // is requested while one is in flight, mark `pending` and run once more
    // after it finishes, so we never miss the latest change nor pile up runs.
    let collecting = false;
    let pending = false;
    async function collect(reason) {
      if (collecting) { pending = true; return; }
      collecting = true;
      console.log(chalk.dim(`\n  Collecting (${reason})…`));
      try {
        const { results: r } = await runCollection({ dbPath });
        const total = r.reduce((s, x) => s + x.sessions, 0);
        console.log(chalk.green(`  ✓ ${total} sessions across ${r.length} sources`));
      } catch (err) {
        console.log(chalk.red(`  Collection error: ${err.message}`));
      } finally {
        collecting = false;
        if (pending) { pending = false; collect('queued change'); }
      }
    }

    // initial collection
    printBanner(chalk);
    console.log('  ' + chalk.dim('watch mode'));
    await collect('startup');

    // start dashboard server (free-port aware)
    const child = await launchDashboard(opts.port, dbPath, chalk);

    // ── File watching: debounce a burst of fs events into one collection ──
    let debounceTimer = null;
    const onFsEvent = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => collect('file change'), 2500);
    };

    const watchers = [];
    const watchDirs = sourceWatchDirs();
    for (const dir of watchDirs) {
      try {
        watchers.push(watch(dir, { recursive: true }, onFsEvent));
      } catch {
        // recursive watch unsupported or dir vanished — skip; interval covers it
      }
    }
    if (watchDirs.length > 0) {
      console.log(chalk.cyan(`\n  Watching ${watchDirs.length} source dir(s) for changes`));
    } else {
      console.log(chalk.yellow('\n  No source dirs found to watch — relying on interval'));
    }

    // interval safety net (covers atomic renames / unsupported recursive watch)
    let timer = null;
    if (opts.poll !== false) {
      timer = setInterval(() => collect('interval'), interval * 60 * 1000);
      console.log(chalk.dim(`  Interval fallback: every ${interval}m`));
    }
    console.log(chalk.dim('  Press Ctrl+C to stop\n'));

    const shutdown = (sig) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (timer) clearInterval(timer);
      for (const w of watchers) { try { w.close(); } catch {} }
      if (sig) child.kill(sig);
      process.exit(0);
    };
    child.on('exit', (code) => { shutdown(null); process.exit(code || 0); });
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });

program
  .command('import <file>')
  .description('Import sessions from a portable JSONL file (any agent)')
  .option('--agent <name>', 'Agent label for imported sessions', 'imported')
  .option('--db <path>', 'Path to SQLite database')
  .action(async (file, opts) => {
    const chalk = (await import('chalk')).default;
    const dbPath = opts.db || defaultDbPath();

    if (!existsSync(file)) {
      console.log(chalk.red(`\n  File not found: ${file}\n`));
      process.exit(1);
    }

    console.log(chalk.bold(`\n  AgentDX Import → agent "${opts.agent}"\n`));
    const { getDb } = await import('../dist/src/core/db.js');
    const { runImport } = await import('../dist/src/collector/import.js');
    const db = getDb(dbPath);
    const stats = await runImport(db, file, { agent: opts.agent });

    console.log(chalk.green(`  ✓ ${stats.sessions} sessions imported`));
    if (stats.errors.length) {
      console.log(chalk.yellow(`  ${stats.errors.length} issues:`));
      for (const e of stats.errors.slice(0, 10)) console.log(chalk.dim(`    - ${e}`));
    }
    console.log();
    process.exit(0);
  });

program
  .command('check')
  .description('Agent diff for a commit range — AI/human split, cost, risk (non-blocking)')
  .option('--db <path>', 'Path to SQLite database')
  .option('--base <ref>', 'Base ref', 'origin/main')
  .option('--head <ref>', 'Head ref', 'HEAD')
  .option('--format <fmt>', 'text | markdown | json | sarif', 'text')
  .option('--out <path>', 'Write to a file instead of stdout')
  .option('--config <path>', 'Path to .agentdx.json (default: <repo>/.agentdx.json)')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const p = paint(chalk);
    const Database = (await import('better-sqlite3')).default;
    const dbPath = opts.db || defaultDbPath();

    if (!existsSync(dbPath)) { console.log(chalk.yellow('\n  No database found. Run `agentdx collect` first.\n')); return; }

    let repoPath;
    try { repoPath = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim(); }
    catch { console.log(chalk.yellow('  Not a git repository.')); return; }

    const g = (args) => { try { return execSync(`git ${args}`, { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
    // Resolve base: fall back when the requested ref (e.g. origin/main) is absent.
    let base = opts.base;
    if (!g(`rev-parse --verify --quiet ${base}`)) {
      base = g('rev-parse --verify --quiet main') ? 'main' : (g('rev-parse --verify --quiet HEAD~1') ? 'HEAD~1' : '');
    }
    const head = opts.head;
    const shas = base ? g(`rev-list ${base}..${head}`).split('\n').filter(Boolean) : [];
    const changedFiles = base ? g(`diff --name-only ${base}...${head}`).split('\n').filter(Boolean) : [];

    let raw = {};
    const cfgPath = opts.config || join(repoPath, '.agentdx.json');
    if (existsSync(cfgPath)) { try { raw = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* ignore malformed config */ } }
    const cfg = {
      maxSessionCostUsd: raw.max_session_cost ?? raw.maxSessionCostUsd,
      maxToolErrorRate: raw.max_tool_error_rate ?? raw.maxToolErrorRate,
      blockIfRiskFlag: raw.block_if_risk_flag ?? raw.blockIfRiskFlag,
      maxAiPct: raw.max_ai_pct ?? raw.maxAiPct,
    };

    const { buildAgentDiff, toMarkdown, toSarif } = await import('../dist/src/core/check.js');
    const db = new Database(dbPath, { readonly: true });
    let diff;
    try { diff = buildAgentDiff(db, { repoPath, base: base || '(none)', head, shas, changedFiles, config: cfg }); }
    finally { db.close(); }

    let output;
    if (opts.format === 'json') output = JSON.stringify(diff, null, 2);
    else if (opts.format === 'markdown') output = toMarkdown(diff);
    else if (opts.format === 'sarif') output = toSarif(diff);
    else output = renderCheckText(p, diff);

    if (opts.out) { writeFileSync(opts.out, output + '\n'); console.log(p.green(`  ✓ wrote ${opts.out}`)); }
    else console.log(output);
    process.exitCode = 0; // P0: always non-blocking
  });

program
  .command('statusline')
  .description('One-line baseline meter for a repo (pipe Claude Code statusLine JSON on stdin)')
  .option('--db <path>', 'Path to SQLite database')
  .option('--repo <path>', 'Repo path (default: stdin workspace dir, else cwd)')
  .option('--json', 'Emit JSON instead of a status line')
  .action(async (opts) => {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = opts.db || defaultDbPath();
    const input = await readStdinJson();
    const repo = opts.repo || input?.workspace?.current_dir || input?.cwd || process.cwd();

    // Never break a host status bar: on any miss, emit a minimal line and exit 0.
    if (!existsSync(dbPath)) { console.log(''); return; }

    const { repoBaseline } = await import('../dist/src/core/baseline.js');
    const db = new Database(dbPath, { readonly: true });
    let base;
    try { base = repoBaseline(db, repo); } finally { db.close(); }

    const chalk = (await import('chalk')).default;
    const model = input?.model?.display_name || input?.model?.id || '';
    const curCost = typeof input?.cost?.total_cost_usd === 'number' ? input.cost.total_cost_usd : null;
    const name = repo.split('/').filter(Boolean).slice(-1)[0] || repo;

    if (opts.json) {
      const ratio = base && curCost != null && base.medianCostUsd > 0 ? curCost / base.medianCostUsd : null;
      console.log(JSON.stringify({ repo, model, currentCostUsd: curCost, baseline: base, ratio }));
      return;
    }

    const fmtMoney = (n) => (n < 0.01 ? '<$0.01' : '$' + n.toFixed(2));
    // Live mode: Claude Code piped the current session cost → show the meter.
    if (curCost != null && base && base.medianCostUsd > 0) {
      const ratio = curCost / base.medianCostUsd;
      const dot = ratio >= 2 ? chalk.red('●') : ratio >= 1.1 ? chalk.yellow('●') : chalk.green('●');
      const rtxt = ratio >= 1.1 ? `${ratio.toFixed(1)}× median` : 'on track';
      const parts = [model && chalk.dim(model), chalk.bold(fmtMoney(curCost)), `${dot} ${rtxt}`, chalk.dim(name)].filter(Boolean);
      console.log(parts.join(chalk.dim(' · ')));
      return;
    }
    // Informational mode (manual run / no live cost): show the repo baseline.
    if (base) {
      console.log([chalk.dim(name), `med ${fmtMoney(base.medianCostUsd)} · ${fmtTok(base.medianTokens)} tok`, chalk.dim(`${base.sessions} sessions`)].join(chalk.dim(' · ')));
      return;
    }
    console.log(model ? chalk.dim(`${model} · ${name} (no baseline yet)`) : '');
  });

program
  .command('finops')
  .description('Cross-agent AI cost report — what each repo / model / agent cost')
  .option('--db <path>', 'Path to SQLite database')
  .option('--period <p>', 'Window: 30d, 90d, qtd, ytd, month=YYYY-MM, all', '30d')
  .option('--by <dim>', 'Group rows by: repo, model, agent, day', 'repo')
  .option('--json', 'Emit raw JSON')
  .option('--csv <path>', 'Write a finance-importable CSV')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const p = paint(chalk);
    const Database = (await import('better-sqlite3')).default;
    const dbPath = opts.db || defaultDbPath();

    if (!existsSync(dbPath)) {
      console.log(chalk.yellow('\n  No database found. Run `agentdx collect` first.\n'));
      return;
    }

    const { buildFinopsReport } = await import('../dist/src/core/finops.js');
    const { fmtUsd } = await import('../dist/src/core/pricing.js');
    const db = new Database(dbPath, { readonly: true });
    let report;
    try { report = buildFinopsReport(db, opts.period); } finally { db.close(); }

    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }

    const dim = ['repo', 'model', 'agent', 'day'].includes(opts.by) ? opts.by : 'repo';
    const rows = dim === 'day'
      ? report.daily.map((d) => ({ key: d.day, label: d.day, sessions: null, tokens: d.tokens, costUsd: d.costUsd, hasUnpriced: false, local: false }))
      : dim === 'model' ? report.byModel : dim === 'agent' ? report.byAgent : report.byRepo;

    if (opts.csv) { writeFinopsCsv(opts.csv, report); console.log(p.green(`\n  ✓ wrote ${opts.csv}`)); }

    const t = report.totals;
    console.log();
    console.log('  ' + p.bold('AgentDX FinOps') + p.dim(`  ·  ${labelPeriod(report.period)}`));
    console.log('  ' + p.dim('─'.repeat(INNER)));
    console.log('  ' + p.bold(p.green(fmtUsd(t.costUsd))) + p.dim(`  ·  ${fmtTok(t.tokens)} tokens  ·  ${t.sessions} sessions  ·  ${t.repos} repos  ·  ${t.models} models`));
    if (t.hasUnpriced) console.log('  ' + p.yellow('~ some models unpriced — cost shown is a floor'));
    console.log();
    console.log('  ' + p.dim(`by ${dim}`));
    printFinopsTable(p, dim, rows, fmtUsd);
    console.log();
    console.log('  ' + p.dim('Estimated at API list prices. Flat-rate plans (Claude Max / Cursor pooled) have no per-request truth.'));
    console.log();
  });

program
  .command('status')
  .description('Show collection stats')
  .option('--db <path>', 'Path to SQLite database')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const Database = (await import('better-sqlite3')).default;
    const dbPath = opts.db || defaultDbPath();

    if (!existsSync(dbPath)) {
      console.log(chalk.yellow('\n  No database found. Run `agentdx collect` first.\n'));
      return;
    }

    const db = new Database(dbPath, { readonly: true });
    const sessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get();
    const messages = db.prepare('SELECT COUNT(*) as c FROM messages').get();
    const toolCalls = db.prepare('SELECT COUNT(*) as c FROM tool_calls').get();
    const repos = db.prepare('SELECT COUNT(*) as c FROM repositories').get();
    const tokens = db.prepare('SELECT SUM(total_input_tokens) as i, SUM(total_output_tokens) as o, SUM(total_cache_read) as cr, SUM(total_cache_write) as cw FROM sessions').get();
    const models = db.prepare('SELECT DISTINCT model FROM model_usage ORDER BY model').all();
    const lastRun = db.prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 1').get();

    console.log(chalk.bold('\n  AgentDX Status'));
    console.log(chalk.dim('  ─────────────────'));
    console.log(`  Database: ${dbPath}`);
    if (lastRun) {
      const ago = Math.round((Date.now() - lastRun.started_at) / 60000);
      console.log(`  Last collection: ${ago}m ago`);
    }
    console.log();
    console.log(`  Sessions:    ${sessions.c}`);
    console.log(`  Messages:    ${messages.c}`);
    console.log(`  Tool calls:  ${toolCalls.c}`);
    console.log(`  Repos:       ${repos.c}`);
    console.log(`  Tokens:      ${fmtTok((tokens.i || 0) + (tokens.cr || 0))} in / ${fmtTok(tokens.o || 0)} out (${fmtTok(tokens.cr || 0)} cached)`);
    console.log(`  Models:      ${models.filter(m => m.model !== '<synthetic>').map(m => m.model).join(', ')}`);
    console.log();
    db.close();
  });

// default: collect then serve
program
  .action(async () => {
    const chalk = (await import('chalk')).default;
    const p = paint(chalk);

    // first-run welcome (before the logo so it reads top-to-bottom)
    const { getUserConfig, setUserConfig } = await import('../dist/src/core/config.js');
    const userCfg = getUserConfig();
    if (!userCfg.notice_shown) {
      console.log();
      console.log('  ' + p.green('Welcome.') + p.dim(' AgentDX runs 100% locally — it reads your agents’ local logs'));
      console.log('  ' + p.dim('and writes one SQLite file on this machine. No accounts, no uploads, no telemetry.'));
      setUserConfig({ notice_shown: true });
    }

    // collect — animated logo + per-agent progress bars
    const renderer = createCollectRenderer(chalk);
    renderer.start();
    const { runCollection } = await import('../dist/src/collector/index.js');
    const { results } = await runCollection({ dbPath: defaultDbPath() }, renderer.hooks);
    if (renderer.finalize(results) === 0) {
      printZeroAgentsMessage(chalk);
    }

    const child = await launchDashboard('3002', defaultDbPath(), chalk);

    child.on('exit', (code) => process.exit(code || 0));
    process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
  });

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/** Aligned, colored per-source collection summary with a total footer. */
function printCollectSummary(chalk, results, { verbose = false } = {}) {
  const p = paint(chalk);
  const nameW = Math.max(8, ...results.map((r) => r.source.length));
  console.log();
  for (const r of results) {
    // Show what's captured in the DB (totals), not just this run's additions —
    // falling back to the run delta if totals weren't provided.
    const totSessions = r.totalSessions ?? r.sessions;
    const totMessages = r.totalMessages ?? r.messages;
    const totTools = r.totalToolCalls ?? r.toolCalls;
    const has = totSessions > 0;
    const dot = has ? p.green('✓') : p.dim('·');
    const name = (has ? p.white : p.dim)(r.source.padEnd(nameW));
    const fresh = r.sessions > 0 ? p.dim(` (+${r.sessions} new)`) : '';
    const detail = has
      ? p.bold(p.green(String(totSessions))) + p.dim(` sessions · ${fmtCount(totMessages)} msg · ${fmtCount(totTools)} tools`) + fresh
      : p.dim('no sessions');
    console.log(`  ${dot} ${name}  ${detail}`);
    if (r.errors.length) {
      console.log('    ' + p.yellow(`${r.errors.length} error${r.errors.length > 1 ? 's' : ''}${verbose ? ':' : ' (--verbose)'}`));
      if (verbose) for (const e of r.errors) console.log('      ' + p.dim('- ' + e));
    }
  }
  const total = results.reduce((s, r) => s + (r.totalSessions ?? r.sessions), 0);
  console.log('  ' + p.dim('━'.repeat(INNER)));
  console.log('  ' + p.bold(p.green(String(total))) + p.bold(' sessions captured'));
}

function printZeroAgentsMessage(chalk) {
  console.log(chalk.yellow('\n  No AI coding agent data found. Supported agents:'));
  console.log(chalk.dim('    • Claude Code   ~/.claude/projects/'));
  console.log(chalk.dim('    • Cowork        Claude desktop app (local agent mode)'));
  console.log(chalk.dim('    • Codex         ~/.codex/'));
  console.log(chalk.dim('    • Cursor        ~/.cursor/'));
  console.log(chalk.dim('    • Antigravity   ~/.gemini/antigravity/'));
}

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

function renderCheckText(p, d) {
  const usd = (n) => (n < 0.01 ? '<$0.01' : '$' + n.toFixed(2));
  const L = [''];
  L.push('  ' + p.bold('AgentDX agent diff') + p.dim(`  ·  ${d.base}..${d.head}`));
  L.push('  ' + p.dim('─'.repeat(INNER)));
  if (!d.commits.matched) {
    L.push('  ' + p.dim(`No agent sessions correlated to ${d.rangeCommits} commit(s) in range.`));
    L.push('');
    return L.join('\n');
  }
  const conf = (d.commits.meanConfidence * 100).toFixed(0);
  L.push('  ' + p.bold(p.green(d.lines.ai.toLocaleString() + ' AI')) + p.dim(` / ${d.lines.human.toLocaleString()} human lines · ${d.lines.aiPct.toFixed(0)}% AI (conf ${conf}%)`));
  L.push('  ' + p.bold(usd(d.cost.usd)) + p.dim(`${d.cost.hasUnpriced ? ' (floor)' : ''} · ${d.cost.sessions} sessions · ${d.tools.calls} tools · ${(d.tools.errorRate * 100).toFixed(0)}% err`));
  L.push('  ' + p.dim(`${d.commits.correlated}/${d.rangeCommits} commits correlated`));
  if (d.riskFiles.length) {
    L.push('', '  ' + p.yellow('⚠ risk surface:'));
    for (const r of d.riskFiles.slice(0, 10)) L.push('    ' + p.dim(`${r.file} — ${r.flags.join(', ')}`));
  }
  if (d.neverReviewed.length) {
    L.push('', '  ' + p.yellow(`👁 never reviewed (${d.neverReviewed.length}):`));
    for (const r of d.neverReviewed.slice(0, 10)) L.push('    ' + p.dim(`${r.file} — ${r.aiLines} AI lines`));
  }
  if (d.warnings.length) {
    L.push('');
    for (const w of d.warnings) L.push('  ' + p.yellow('⚠ ' + w));
  }
  L.push('');
  return L.join('\n');
}

// Read a JSON blob piped on stdin (e.g. Claude Code's statusLine payload).
// Returns null in a TTY or on empty/invalid input — never throws.
async function readStdinJson() {
  if (process.stdin.isTTY) return null;
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const s = Buffer.concat(chunks).toString('utf8').trim();
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function labelPeriod(period) {
  if (period === '30d') return 'last 30 days';
  if (period === '90d') return 'last 90 days';
  if (period === 'qtd') return 'quarter to date';
  if (period === 'ytd') return 'year to date';
  if (period === 'all') return 'all time';
  const m = /^month=(\d{4}-\d{2})$/.exec(period);
  if (m) return m[1];
  return period;
}

function shortRepo(pth) {
  if (!pth || pth === '(unknown)') return '(unknown)';
  const parts = String(pth).split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function printFinopsTable(p, dim, rows, fmtUsd) {
  if (!rows.length) { console.log('  ' + p.dim('no usage in this period')); return; }
  const labelOf = (r) => (dim === 'repo' ? shortRepo(r.label) : String(r.label));
  const nameW = Math.min(38, Math.max(8, ...rows.map((r) => labelOf(r).length)));
  rows.slice(0, 40).forEach((r, i) => {
    const name = labelOf(r).slice(0, nameW).padEnd(nameW);
    const rawCost = r.local ? '$0 local' : (r.hasUnpriced ? '~' : '') + fmtUsd(r.costUsd);
    const cost = rawCost.padStart(10);
    const colored = r.local ? p.dim(cost) : r.hasUnpriced ? p.yellow(cost) : p.green(cost);
    const tok = p.dim(fmtTok(r.tokens).padStart(8));
    const sess = r.sessions == null ? '' : p.dim(String(r.sessions).padStart(5));
    console.log('  ' + p.dim(String(i + 1).padStart(2)) + '  ' + name + '  ' + colored + '  ' + tok + (sess ? '  ' + sess : ''));
  });
  if (rows.length > 40) console.log('  ' + p.dim(`… +${rows.length - 40} more`));
}

function writeFinopsCsv(path, report) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ['dimension,key,input,output,cache_read,cache_write,tokens,sessions,cost_usd,has_unpriced,local'];
  const push = (dim, r) => lines.push([dim, r.label, r.input, r.output, r.cacheRead, r.cacheWrite, r.tokens, r.sessions, (r.costUsd ?? 0).toFixed(4), r.hasUnpriced ? 1 : 0, r.local ? 1 : 0].map(esc).join(','));
  report.byRepo.forEach((r) => push('repo', r));
  report.byModel.forEach((r) => push('model', r));
  report.byAgent.forEach((r) => push('agent', r));
  writeFileSync(path, lines.join('\n') + '\n');
}

program.parse();
