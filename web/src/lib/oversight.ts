import type Database from 'better-sqlite3';
import { basename } from 'path';

/**
 * Authorship & Oversight — turns the git ground truth (git_commits,
 * git_file_authorship) plus the agent file_events into the four answers:
 *   Q1 % human vs AI   (stock = blame, flow = churn)
 *   Q2 review queue     (explainable per-file score)
 *   Q3 blindspots       (AI-authored, no human eyes, central)
 *   Q4 control trend     (weekly ratio + unreviewed/velocity signals)
 *
 * Honesty: blame line counts are exact; the ai/human label is heuristic and
 * carries a confidence at the commit level. We never claim line-precise
 * authorship — only "introduced in AI-assisted commits".
 */

export interface OversightFile {
  file: string;
  repo: string;
  aiLines: number;
  humanLines: number;
  mixedLines: number;
  totalLines: number;
  aiPct: number;        // (ai + mixed) / total, 0..100
  fanIn: number;        // -1 when centrality unavailable
  risk: string[];
  reviewed: boolean;    // human commit OR seen in a later session (lenient)
  errors: number;
  touches: number;
  lastChange: number | null;
  score: number;        // review priority 0..100
  reasons: string[];
  blindspot: number;    // blindspot score (relative)
}

export interface OversightData {
  repos: { path: string; name: string; files: number }[];
  selectedRepo: string | null;
  coverage: { analyzed: number; total: number; capped: boolean };
  stock: { ai: number; human: number; mixed: number; unknown: number; total: number };
  churn: { ai: number; human: number; mixed: number };
  centralityAvailable: boolean;
  signals: {
    aiStockPct: number;
    aiChurnPct: number;
    unreviewedAiFiles: number;   // AI-authored files no human has touched/seen
    unreviewedAiPct: number;
    aiHumanRatio: number;        // ai : human lines (stock)
    velocityGapPct: number;      // last-4-week AI share of AI+human churn (excl. mixed)
    velocityRising: boolean;     // recent AI share materially above all-time
  };
  blindspotTotal: number;        // full count before the display slice
  trend: { labels: string[]; ai: number[]; human: number[]; mixed: number[] };
  reviewQueue: OversightFile[];
  blindspots: OversightFile[];
  treemap: { file: string; repo: string; total: number; aiPct: number; sessionId: string | null }[];
  weights: Record<string, number>;
}

// Review-priority weights (surfaced in the UI so the score is never a black box).
const WEIGHTS: Record<string, number> = {
  aiAuthorship: 0.25,
  centrality: 0.20,
  neverReviewed: 0.20,
  riskSurface: 0.15,
  recency: 0.10,
  errorDensity: 0.10,
};

const WEEK = 7 * 24 * 3600 * 1000;

// Non-code files (docs, config, data) still count toward the authorship % and
// treemap, but they must NOT dominate the "review this" queue or blindspots —
// a TODO.md the AI wrote is not the load-bearing logic you're worried about.
const NONCODE_EXT = new Set(['md', 'mdx', 'txt', 'json', 'yaml', 'yml', 'csv', 'svg', 'lock', 'rst', 'toml', 'ini', 'cfg']);
function isCode(file: string): boolean {
  const base = file.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true; // no ext → treat as code-ish (e.g. Dockerfile)
  return !NONCODE_EXT.has(base.slice(dot + 1).toLowerCase());
}

function repoName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p;
}

/** file_events stats keyed by basename, for suffix-matching to blame rel paths. */
function loadFileEventStats(db: Database.Database) {
  const rows = db.prepare(`
    SELECT file_path,
           COUNT(*) AS touches,
           SUM(CASE WHEN op = 'read' THEN 1 ELSE 0 END) AS reads,
           SUM(is_error) AS errors,
           COUNT(DISTINCT session_id) AS sessions
    FROM file_events
    WHERE file_path IS NOT NULL
    GROUP BY file_path
  `).all() as { file_path: string; touches: number; reads: number; errors: number; sessions: number }[];
  const byBase = new Map<string, { path: string; touches: number; reads: number; errors: number; sessions: number }[]>();
  for (const r of rows) {
    const b = basename(r.file_path);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b)!.push({ path: r.file_path, touches: r.touches, reads: r.reads, errors: r.errors, sessions: r.sessions });
  }
  return byBase;
}

/** basename → editing events (most-recent first) for direct file→session drill. */
function loadEditSessions(db: Database.Database) {
  const rows = db.prepare(`
    SELECT file_path, session_id, MAX(timestamp) AS ts
    FROM file_events
    WHERE op IN ('edit','write','create') AND file_path IS NOT NULL
    GROUP BY file_path, session_id
  `).all() as { file_path: string; session_id: string; ts: number }[];
  const byBase = new Map<string, { path: string; session_id: string; ts: number }[]>();
  for (const r of rows) {
    const b = basename(r.file_path);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b)!.push({ path: r.file_path, session_id: r.session_id, ts: r.ts });
  }
  return byBase;
}

export function getOversight(db: Database.Database, repoArg?: string | null): OversightData {
  const repoRows = db.prepare(`
    SELECT repo_path AS path, COUNT(*) AS files
    FROM git_file_authorship GROUP BY repo_path ORDER BY files DESC
  `).all() as { path: string; files: number }[];
  const repos = repoRows.map((r) => ({ path: r.path, name: repoName(r.path), files: r.files }));

  const totalRepos = (db.prepare(
    `SELECT COUNT(DISTINCT project_path) AS c FROM sessions WHERE project_path IS NOT NULL AND project_path != ''`,
  ).get() as { c: number }).c;

  const selectedRepo = repoArg && repos.some((r) => r.path === repoArg) ? repoArg : null;
  const repoFilter = selectedRepo ? ' WHERE repo_path = @repo ' : '';
  const bind = selectedRepo ? { repo: selectedRepo } : {};

  // ── Stock (blame) ──────────────────────────────────────────────
  const stock = db.prepare(`
    SELECT COALESCE(SUM(ai_lines),0) AS ai, COALESCE(SUM(human_lines),0) AS human,
           COALESCE(SUM(mixed_lines),0) AS mixed, COALESCE(SUM(unknown_lines),0) AS unknown,
           COALESCE(SUM(total_lines),0) AS total
    FROM git_file_authorship ${repoFilter}
  `).get(bind) as { ai: number; human: number; mixed: number; unknown: number; total: number };

  // ── Churn (commits) ────────────────────────────────────────────
  const churnRows = db.prepare(`
    SELECT attribution AS a, COALESCE(SUM(lines_added),0) AS added
    FROM git_commits ${selectedRepo ? 'WHERE repo_path = @repo' : ''}
    GROUP BY attribution
  `).all(bind) as { a: string; added: number }[];
  const churn = { ai: 0, human: 0, mixed: 0 };
  for (const r of churnRows) {
    if (r.a === 'ai') churn.ai += r.added;
    else if (r.a === 'human') churn.human += r.added;
    else if (r.a === 'mixed') churn.mixed += r.added;
  }

  // ── Weekly trend (last 26 weeks of churn) ──────────────────────
  const commits = db.prepare(`
    SELECT committed_at AS t, attribution AS a, lines_added AS n
    FROM git_commits
    ${selectedRepo ? 'WHERE repo_path = @repo' : ''}
  `).all(bind) as { t: number; a: string; n: number }[];
  const nowMs = Date.now();
  const WEEKS = 26;
  const start = nowMs - WEEKS * WEEK;
  const ai = new Array(WEEKS).fill(0), human = new Array(WEEKS).fill(0), mixed = new Array(WEEKS).fill(0);
  for (const c of commits) {
    if (!c.t || c.t < start) continue;
    const wi = Math.min(WEEKS - 1, Math.floor((c.t - start) / WEEK));
    if (c.a === 'ai') ai[wi] += c.n;
    else if (c.a === 'human') human[wi] += c.n;
    else if (c.a === 'mixed') mixed[wi] += c.n;
  }
  const labels = Array.from({ length: WEEKS }, (_, i) => {
    const d = new Date(start + i * WEEK);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  });
  // Velocity EXCLUDES mixed: a single squashed/rebased commit lands wholly in
  // one week as "mixed" and fakes a "losing control" spike. Compare pure AI vs
  // human, recent vs all-time, so the arrow reflects a real trend.
  const sum4 = (arr: number[]) => arr.slice(-4).reduce((a, b) => a + b, 0);
  const last4Ai = sum4(ai);
  const last4Hum = sum4(human);
  const recentAiShare = last4Ai + last4Hum ? (last4Ai / (last4Ai + last4Hum)) * 100 : 0;
  const allTimeAiShare = churn.ai + churn.human ? (churn.ai / (churn.ai + churn.human)) * 100 : 0;

  // ── Per-file scoring ───────────────────────────────────────────
  const feStats = loadFileEventStats(db);
  const fileRows = db.prepare(`
    SELECT repo_path, file_path, ai_lines, human_lines, mixed_lines, total_lines,
           fan_in, risk_flags, last_ai_commit_at, last_human_commit_at
    FROM git_file_authorship ${repoFilter}
  `).all(bind) as any[];

  const centralityAvailable = fileRows.some((r) => r.fan_in >= 0);
  const maxFanIn = Math.max(1, ...fileRows.map((r) => (r.fan_in > 0 ? r.fan_in : 0)));

  type FeHit = { path: string; touches: number; reads: number; errors: number; sessions: number };
  const matchFe = (rel: string): FeHit | null => {
    const cands = feStats.get(basename(rel));
    if (!cands) return null;
    let hit: FeHit | null = null;
    for (const c of cands) {
      if (!(c.path.endsWith(rel) || basename(c.path) === basename(rel))) continue;
      if (!hit) hit = { path: c.path, touches: 0, reads: 0, errors: 0, sessions: 0 };
      hit.touches += c.touches; hit.reads += c.reads; hit.errors += c.errors;
      hit.sessions = Math.max(hit.sessions, c.sessions);
    }
    return hit;
  };

  const files: OversightFile[] = fileRows.map((r) => {
    const total = r.total_lines || 0;
    const aiAll = r.ai_lines + r.mixed_lines;
    const aiPct = total ? (aiAll / total) * 100 : 0;
    const fe = matchFe(r.file_path);
    const risk = (r.risk_flags ? String(r.risk_flags).split(',') : []).filter(Boolean);
    const reviewed = r.human_lines > 0 || !!(fe && fe.reads > 0);
    const lastChange = Math.max(r.last_ai_commit_at || 0, r.last_human_commit_at || 0) || null;

    // normalized 0..1 signals
    const sAi = aiPct / 100;
    const sCentral = r.fan_in > 0 ? r.fan_in / maxFanIn : 0;
    const sNever = !reviewed && aiAll > 0 ? 1 : 0;
    const sRisk = Math.min(1, risk.length / 2);
    const sRecency = lastChange ? Math.max(0, 1 - (nowMs - lastChange) / (90 * 24 * 3600 * 1000)) : 0;
    const touches = fe?.touches || 0;
    const errors = fe?.errors || 0;
    const sError = touches ? Math.min(1, errors / touches) : 0;

    const score = 100 * (
      WEIGHTS.aiAuthorship * sAi +
      WEIGHTS.centrality * sCentral +
      WEIGHTS.neverReviewed * sNever +
      WEIGHTS.riskSurface * sRisk +
      WEIGHTS.recency * sRecency +
      WEIGHTS.errorDensity * sError
    );

    const reasons: string[] = [];
    if (aiPct >= 60) reasons.push(`${Math.round(aiPct)}% AI-assisted`);
    // Centrality chip suppressed until the import resolver is deep enough to be
    // trustworthy — fan-in is currently near-zero on mixed-language repos.
    if (r.fan_in >= 3) reasons.push(`${r.fan_in} dependents`);
    if (sNever) reasons.push('never reviewed');
    for (const rk of risk) reasons.push(`touches ${rk}`);
    if (sError > 0.2) reasons.push('error-prone');

    return {
      file: r.file_path, repo: r.repo_path,
      aiLines: r.ai_lines, humanLines: r.human_lines, mixedLines: r.mixed_lines, totalLines: total,
      aiPct, fanIn: r.fan_in, risk, reviewed, errors, touches, lastChange,
      score, reasons,
      blindspot: sNever ? aiAll * (0.3 + sCentral) : 0,
    };
  });

  // Everything about "review / control" is code-only — docs/config don't count
  // (the authorship table is already code-only at the collector level now, but
  // keep isCode as a belt-and-suspenders guard).
  const codeFiles = files.filter((f) => isCode(f.file));
  const unreviewedAi = codeFiles.filter((f) => !f.reviewed && (f.aiLines + f.mixedLines) > 0);
  const reviewQueue = [...codeFiles].sort((a, b) => b.score - a.score).slice(0, 40);
  const blindspotsAll = [...codeFiles].filter((f) => f.blindspot > 0).sort((a, b) => b.blindspot - a.blindspot);
  const blindspots = blindspotsAll.slice(0, 25);
  const editSessions = loadEditSessions(db);
  const latestSession = (rel: string): string | null => {
    const cands = editSessions.get(basename(rel));
    if (!cands) return null;
    let best: { session_id: string; ts: number } | null = null;
    for (const c of cands) {
      if (!(c.path.endsWith(rel) || basename(c.path) === basename(rel))) continue;
      if (!best || c.ts > best.ts) best = c;
    }
    return best ? best.session_id : null;
  };
  const treemap = [...codeFiles].sort((a, b) => b.totalLines - a.totalLines).slice(0, 60)
    .map((f) => ({ file: f.file, repo: f.repo, total: f.totalLines, aiPct: f.aiPct, sessionId: latestSession(f.file) }));

  const aiStock = stock.ai + stock.mixed;
  const aiChurn = churn.ai + churn.mixed;
  const churnTotal = churn.ai + churn.human + churn.mixed;

  return {
    repos,
    selectedRepo,
    coverage: { analyzed: repos.length, total: totalRepos, capped: false },
    stock,
    churn,
    centralityAvailable,
    signals: {
      aiStockPct: stock.total ? (aiStock / stock.total) * 100 : 0,
      aiChurnPct: churnTotal ? (aiChurn / churnTotal) * 100 : 0,
      unreviewedAiFiles: unreviewedAi.length,
      unreviewedAiPct: codeFiles.length ? (unreviewedAi.length / codeFiles.length) * 100 : 0,
      aiHumanRatio: stock.human ? aiStock / stock.human : aiStock > 0 ? Infinity : 0,
      velocityGapPct: recentAiShare,
      velocityRising: recentAiShare > allTimeAiShare + 3,
    },
    blindspotTotal: blindspotsAll.length,
    trend: { labels, ai, human, mixed },
    reviewQueue,
    blindspots,
    treemap,
    weights: WEIGHTS,
  };
}
