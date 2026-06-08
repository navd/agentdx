import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import type Database from 'better-sqlite3';

/**
 * Git ground-truth collector — the human half of "who actually wrote this".
 *
 * AgentDX already records what the AGENTS did (file_events). This module adds
 * what actually LANDED in the tree: `git log` for churn + commit attribution,
 * and `git blame` for the surviving-line ("stock") authorship split.
 *
 * Honesty contract:
 *  - Line counts come straight from git → EXACT.
 *  - The ai/human label is a HEURISTIC: a commit is "AI-assisted" when an agent
 *    session edited the same files around the same time (file_events overlap),
 *    or when a Co-authored-by trailer / bot email names an AI. Every commit
 *    carries a `confidence`. Never present the label as ground-truth authorship.
 *  - Centrality (fan_in) is an approximate import-graph count; -1 = not computed.
 *
 * Idempotent + incremental: keyed off each repo's HEAD sha in collection_state
 * (source `git:<root>`). First run does a full history scan + blames every
 * tracked source file; later runs only re-blame files changed since last HEAD.
 */

// Source CODE only. Deliberately excludes json/yaml/md/csv/etc: data, config,
// and docs are NOT code you can "lose control of", and large generated/data
// blobs (graph.json, *.manifest.json) otherwise dominate the authorship % and
// treemap. Authorship here = real source code authorship.
const SRC_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rb', 'rs', 'java', 'kt',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'scala', 'sql', 'sh',
  'vue', 'svelte', 'css', 'scss', 'tf',
]);

// Files that inflate either side and are not hand-authored logic.
const SKIP_NAME = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|go\.sum|Gemfile\.lock)$/;
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|out|target|coverage|vendor|__pycache__|\.venv|migrations\/generated|graphify-out|\.codegraph|schemas)(\/|$)/;
const GENERATED = /(\.min\.(js|css)|\.lock|\.snap|\.pb\.go|_pb2\.py|\.generated\.|\.manifest\.json$)/i;

// AI authorship signals in commit metadata.
const AI_META = /(claude|anthropic|codex|openai|copilot|cursor|aider|sourcegraph|\bbot\b|github-actions)/i;

// Risk-surface flags from path/name. Load-bearing files get reviewed first.
const RISK_RULES: [string, RegExp][] = [
  ['auth', /(auth|login|session|oauth|jwt|token|password|credential|permission|rbac|acl)/i],
  ['secret', /(secret|\.env|apikey|api[_-]?key|private[_-]?key|\.pem|vault)/i],
  ['payment', /(payment|billing|charge|stripe|invoice|checkout|payout|refund)/i],
  ['migration', /(migration|migrate|schema\.sql|\.sql$|alembic|flyway)/i],
  ['infra', /(terraform|\.tf$|dockerfile|docker-compose|k8s|kubernetes|helm|\.ya?ml$|ansible)/i],
  ['deploy', /(deploy|release|ci\.ya?ml|\.github\/workflows|pipeline|jenkins)/i],
  ['config', /(config|settings|middleware|webpack|vite\.config|next\.config)/i],
];

const HOUR = 3600 * 1000;
const WINDOW_BEFORE = 24 * HOUR; // agent edit may precede the commit by a day
const WINDOW_AFTER = 1 * HOUR;
const MAX_BLAME_FILES = 3000;
const MAX_GRAPH_FILES = 4000;
const MAX_READ_BYTES = 200 * 1024;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function tryGit(repo: string, args: string[]): string | null {
  try { return git(repo, args); } catch { return null; }
}

function skipFile(rel: string): boolean {
  if (SKIP_PATH.test(rel) || GENERATED.test(rel)) return true;
  const base = basename(rel);
  if (SKIP_NAME.test(base)) return true;
  const ext = extname(base).slice(1).toLowerCase();
  return !SRC_EXT.has(ext);
}

function riskFlags(rel: string): string {
  const hits: string[] = [];
  for (const [flag, re] of RISK_RULES) if (re.test(rel)) hits.push(flag);
  return hits.join(',');
}

/** Resolve the set of distinct repo roots AgentDX has session history for. */
function discoverRepos(db: Database.Database): string[] {
  const paths = new Set<string>();
  for (const r of db.prepare(
    `SELECT DISTINCT project_path AS p FROM sessions WHERE project_path IS NOT NULL AND project_path != ''
     UNION SELECT DISTINCT path AS p FROM repositories WHERE path IS NOT NULL AND path != ''`,
  ).all() as { p: string }[]) {
    if (r.p) paths.add(r.p);
  }
  const roots = new Set<string>();
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const top = tryGit(p, ['rev-parse', '--show-toplevel']);
    if (top) roots.add(top.trim());
  }
  return [...roots];
}

interface FileEventLite { ts: number; session_id: string; }

/** basename → events (edit/write/create only), for cheap commit↔session overlap. */
function loadAgentEdits(db: Database.Database): Map<string, { rel: string; ev: FileEventLite }[]> {
  const idx = new Map<string, { rel: string; ev: FileEventLite }[]>();
  const rows = db.prepare(
    `SELECT file_path, session_id, timestamp FROM file_events
     WHERE op IN ('edit','write','create') AND file_path IS NOT NULL`,
  ).all() as { file_path: string; session_id: string; timestamp: number }[];
  for (const r of rows) {
    const b = basename(r.file_path);
    if (!idx.has(b)) idx.set(b, []);
    idx.get(b)!.push({ rel: r.file_path, ev: { ts: r.timestamp, session_id: r.session_id } });
  }
  return idx;
}

interface CommitRec {
  sha: string; author_name: string; author_email: string; committed_at: number;
  coauthors: string; files: string[]; lines_added: number; lines_removed: number;
}

/** Parse `git log --numstat` with our \x1f-delimited header line. */
function parseLog(out: string): CommitRec[] {
  const commits: CommitRec[] = [];
  let cur: CommitRec | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\x1e')) {
      if (cur) commits.push(cur);
      const [sha, an, ae, aISO, co] = line.slice(1).split('\x1f');
      cur = {
        sha, author_name: an || '', author_email: ae || '',
        committed_at: aISO ? Date.parse(aISO) : 0,
        coauthors: co || '', files: [], lines_added: 0, lines_removed: 0,
      };
    } else if (cur && line.trim()) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (m) {
        cur.files.push(m[3]);
        // Churn line counts EXCLUDE lockfiles/generated/vendored — otherwise a
        // single commit that adds a 3M-line generated file fakes a mountain in
        // the trend. Blame already filters these; churn must match.
        if (skipFile(m[3])) continue;
        if (m[1] !== '-') cur.lines_added += parseInt(m[1], 10);
        if (m[2] !== '-') cur.lines_removed += parseInt(m[2], 10);
      }
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

/** Classify a commit as ai/human/mixed and attach a confidence + linked session. */
function attribute(
  c: CommitRec, editIdx: Map<string, { rel: string; ev: FileEventLite }[]>,
): { attribution: string; confidence: number; session_id: string | null } {
  if (AI_META.test(c.coauthors) || AI_META.test(c.author_email) || AI_META.test(c.author_name)) {
    return { attribution: 'ai', confidence: 0.95, session_id: null };
  }
  const codeFiles = c.files.filter((f) => !skipFile(f));
  if (codeFiles.length === 0) return { attribution: 'human', confidence: 0.4, session_id: null };

  let overlap = 0;
  let session: string | null = null;
  let best = 0;
  for (const rel of codeFiles) {
    const cands = editIdx.get(basename(rel));
    if (!cands) continue;
    for (const { rel: p, ev } of cands) {
      if (!p.endsWith(rel) && basename(p) !== basename(rel)) continue;
      if (ev.ts >= c.committed_at - WINDOW_BEFORE && ev.ts <= c.committed_at + WINDOW_AFTER) {
        overlap++;
        if (ev.ts > best) { best = ev.ts; session = ev.session_id; }
        break;
      }
    }
  }
  if (overlap === 0) return { attribution: 'human', confidence: 0.7, session_id: null };
  if (overlap === codeFiles.length) return { attribution: 'ai', confidence: 0.8, session_id: session };
  return { attribution: 'mixed', confidence: 0.6, session_id: session };
}

/** Approximate import fan-in across tracked source files. */
function computeFanIn(repo: string, files: string[]): Map<string, number> | null {
  if (files.length > MAX_GRAPH_FILES) return null;
  const fileSet = new Set(files);
  const fanIn = new Map<string, number>();
  for (const f of files) fanIn.set(f, 0);

  const resolveRel = (fromFile: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null; // external/package import
    const baseDir = dirname(fromFile);
    let target = join(baseDir, spec).replace(/\\/g, '/').replace(/^\.\//, '');
    const cands = [target, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go'].map((e) => target + e),
      ...['index.ts', 'index.tsx', 'index.js', '__init__.py'].map((i) => `${target}/${i}`)];
    for (const c of cands) if (fileSet.has(c)) return c;
    return null;
  };

  const IMPORT = /(?:import\s[^'"]*from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]|from\s+([.\w]+)\s+import)/g;
  for (const f of files) {
    let content: string;
    try {
      if (statSync(join(repo, f)).size > MAX_READ_BYTES) continue;
      content = readFileSync(join(repo, f), 'utf-8');
    } catch { continue; }
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = IMPORT.exec(content))) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!spec) continue;
      const target = resolveRel(f, spec);
      if (target && target !== f && !seen.has(target)) {
        seen.add(target);
        fanIn.set(target, (fanIn.get(target) || 0) + 1);
      }
    }
  }
  return fanIn;
}

/** Blame one file → {sha: lineCount}. Returns null on binary/error. */
function blameFile(repo: string, rel: string): Map<string, number> | null {
  const out = tryGit(repo, ['blame', '--line-porcelain', 'HEAD', '--', rel]);
  if (out == null) return null;
  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    // porcelain header for each line starts with "<40-hex-sha> orig final num"
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

function collectRepo(db: Database.Database, repo: string): void {
  const headOut = tryGit(repo, ['rev-parse', 'HEAD']);
  if (!headOut) return; // empty repo / no commits
  const head = headOut.trim();

  const stateRow = db.prepare(`SELECT last_file FROM collection_state WHERE source = ?`)
    .get(`git:${repo}`) as { last_file: string } | undefined;
  const lastSha = stateRow?.last_file || null;
  if (lastSha === head) return; // nothing new since last collect

  const editIdx = loadAgentEdits(db);

  // 1. Commits — full history on first run, else only the new range.
  const range = lastSha ? `${lastSha}..HEAD` : 'HEAD';
  const fmt = '\x1e%H\x1f%an\x1f%ae\x1f%aI\x1f%(trailers:key=Co-authored-by,valueonly,separator=%x2c)';
  const logOut = tryGit(repo, ['log', '--no-merges', '--numstat', `--pretty=format:${fmt}`, range]);
  const commits = logOut ? parseLog(logOut) : [];

  const insCommit = db.prepare(`
    INSERT OR REPLACE INTO git_commits
      (sha, repo_path, author_name, author_email, committed_at, lines_added, lines_removed,
       files_changed, coauthors, attribution, confidence, session_id, collected_at)
    VALUES (@sha,@repo_path,@author_name,@author_email,@committed_at,@lines_added,@lines_removed,
       @files_changed,@coauthors,@attribution,@confidence,@session_id,@collected_at)`);

  const now = Date.now();
  const attrBySha = new Map<string, string>();
  const txCommits = db.transaction(() => {
    for (const c of commits) {
      const a = attribute(c, editIdx);
      attrBySha.set(c.sha, a.attribution);
      insCommit.run({
        sha: c.sha, repo_path: repo, author_name: c.author_name, author_email: c.author_email,
        committed_at: c.committed_at, lines_added: c.lines_added, lines_removed: c.lines_removed,
        files_changed: c.files.length, coauthors: c.coauthors || null,
        attribution: a.attribution, confidence: a.confidence, session_id: a.session_id, collected_at: now,
      });
    }
  });
  txCommits();

  // Attribution lookup for ANY blame sha (across all prior runs too).
  const shaAttr = (sha: string): string => {
    if (attrBySha.has(sha)) return attrBySha.get(sha)!;
    const row = db.prepare(`SELECT attribution FROM git_commits WHERE sha = ?`).get(sha) as { attribution: string } | undefined;
    const a = row?.attribution || 'unknown';
    attrBySha.set(sha, a);
    return a;
  };
  const shaTime = (sha: string): number => {
    const row = db.prepare(`SELECT committed_at FROM git_commits WHERE sha = ?`).get(sha) as { committed_at: number } | undefined;
    return row?.committed_at || 0;
  };

  // 2. Which files to (re)blame.
  const tracked = (tryGit(repo, ['ls-files']) || '').split('\n').filter(Boolean);
  const sourceFiles = tracked.filter((f) => !skipFile(f));
  let targets: string[];
  if (lastSha) {
    const changed = (tryGit(repo, ['diff', '--name-only', `${lastSha}..HEAD`]) || '').split('\n').filter(Boolean);
    targets = changed.filter((f) => !skipFile(f) && existsSync(join(repo, f)));
    // Drop authorship rows for files deleted since last run.
    const gone = changed.filter((f) => !existsSync(join(repo, f)));
    const del = db.prepare(`DELETE FROM git_file_authorship WHERE repo_path = ? AND file_path = ?`);
    db.transaction(() => { for (const f of gone) del.run(repo, f); })();
  } else {
    targets = sourceFiles;
  }
  if (targets.length > MAX_BLAME_FILES) targets = targets.slice(0, MAX_BLAME_FILES);

  // 3. Centrality (whole-repo import graph; recomputed when anything changed).
  const fanIn = targets.length ? computeFanIn(repo, sourceFiles) : null;

  // 4. Blame each target → per-file authorship split.
  const upsert = db.prepare(`
    INSERT INTO git_file_authorship
      (repo_path, file_path, ai_lines, human_lines, mixed_lines, unknown_lines, total_lines,
       fan_in, risk_flags, last_ai_commit_at, last_human_commit_at, head_sha, computed_at)
    VALUES (@repo_path,@file_path,@ai,@human,@mixed,@unknown,@total,@fan_in,@risk,@last_ai,@last_human,@head,@computed)
    ON CONFLICT(repo_path, file_path) DO UPDATE SET
      ai_lines=@ai, human_lines=@human, mixed_lines=@mixed, unknown_lines=@unknown, total_lines=@total,
      fan_in=@fan_in, risk_flags=@risk, last_ai_commit_at=@last_ai, last_human_commit_at=@last_human,
      head_sha=@head, computed_at=@computed`);

  const txBlame = db.transaction(() => {
    for (const rel of targets) {
      const counts = blameFile(repo, rel);
      if (!counts) continue;
      let ai = 0, human = 0, mixed = 0, unknown = 0, total = 0, lastAi = 0, lastHuman = 0;
      for (const [sha, n] of counts) {
        total += n;
        const a = shaAttr(sha);
        if (a === 'ai') { ai += n; lastAi = Math.max(lastAi, shaTime(sha)); }
        else if (a === 'human') { human += n; lastHuman = Math.max(lastHuman, shaTime(sha)); }
        else if (a === 'mixed') { mixed += n; lastAi = Math.max(lastAi, shaTime(sha)); }
        else unknown += n;
      }
      if (total === 0) continue;
      upsert.run({
        repo_path: repo, file_path: rel, ai, human, mixed, unknown, total,
        fan_in: fanIn ? (fanIn.get(rel) ?? 0) : -1, risk: riskFlags(rel) || null,
        last_ai: lastAi || null, last_human: lastHuman || null, head: head, computed: now,
      });
    }
  });
  txBlame();

  // 5. Advance the watermark.
  db.prepare(`
    INSERT INTO collection_state (source, last_file, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET last_file = excluded.last_file, updated_at = excluded.updated_at
  `).run(`git:${repo}`, head, now);
}

/**
 * Collect git ground truth for every local repo AgentDX has session history for.
 * Best-effort per repo: a failure on one repo never blocks the others.
 */
export function collectGit(db: Database.Database): { repos: number; analyzed: number } {
  // One-time reset when the authorship logic changes (churn now excludes
  // generated files). Wipe the derived git tables + per-repo watermarks so the
  // next pass recomputes from scratch. Guarded so it runs at most once.
  const RESET = 'git_authorship_v3';
  const seen = db.prepare(`SELECT 1 FROM collection_state WHERE source = ?`).get(RESET);
  if (!seen) {
    db.transaction(() => {
      db.exec(`DELETE FROM git_commits; DELETE FROM git_file_authorship;
               DELETE FROM collection_state WHERE source LIKE 'git:%';`);
      db.prepare(`INSERT INTO collection_state (source, updated_at) VALUES (?, ?)`).run(RESET, Date.now());
    })();
  }

  const repos = discoverRepos(db);
  let analyzed = 0;
  for (const repo of repos) {
    try { collectRepo(db, repo); analyzed++; } catch { /* skip this repo */ }
  }
  return { repos: repos.length, analyzed };
}
