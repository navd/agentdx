// `agentdx check` — the "agent diff" for a PR/branch range. Aggregates what the
// AI agents actually did to the code in a base..head range: AI/human line split
// (with confidence), the cost of the sessions behind it, their tool-error rate,
// and which changed files touch risk surface or were never human-reviewed.
//
// P0 is NON-BLOCKING: thresholds only produce warnings, never a non-zero exit.
// Blocking gates are P3 (and need the cross-machine commit-keyed export so the
// data is present on a CI runner, not just the dev's laptop).
//
// Attribution (ai/human/mixed) is a HEURISTIC carrying a confidence — surfaced,
// never asserted as ground truth. Line counts and costs are hard data.

import type Database from 'better-sqlite3';
import { estimateCostUsd } from './pricing.js';

export interface CheckConfig {
  maxSessionCostUsd?: number;
  maxToolErrorRate?: number; // 0..1
  blockIfRiskFlag?: string[]; // warn-only in P0
  maxAiPct?: number; // 0..100
}

export interface AgentDiff {
  repoPath: string;
  base: string;
  head: string;
  rangeCommits: number; // commits in the git range
  commits: { matched: number; ai: number; human: number; mixed: number; unknown: number; correlated: number; meanConfidence: number };
  lines: { ai: number; human: number; total: number; aiPct: number };
  cost: { usd: number; hasUnpriced: boolean; sessions: number };
  tools: { calls: number; errors: number; errorRate: number };
  changedFiles: number;
  riskFiles: { file: string; flags: string[] }[];
  neverReviewed: { file: string; aiLines: number }[];
  warnings: string[];
}

export interface BuildOpts {
  repoPath: string;
  base: string;
  head: string;
  shas: string[]; // commit shas in the range
  changedFiles: string[]; // paths relative to repo root
  config?: CheckConfig;
}

const ph = (n: number) => Array(n).fill('?').join(',');

// SQLite caps bound variables (default 999), so split big IN-lists. 900 leaves
// headroom for the extra repo_path bind on some queries.
const CHUNK = 900;
function chunks<T>(a: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

export function buildAgentDiff(db: Database.Database, opts: BuildOpts): AgentDiff {
  const { repoPath, base, head, shas, changedFiles, config = {} } = opts;

  const commits = { matched: 0, ai: 0, human: 0, mixed: 0, unknown: 0, correlated: 0, meanConfidence: 0 };
  let aiLines = 0, humanLines = 0, otherLines = 0, confSum = 0, confN = 0;
  const sessionIds = new Set<string>();

  for (const part of chunks(shas)) {
    const rows = db.prepare(
      `SELECT attribution, confidence, session_id, lines_added FROM git_commits WHERE repo_path = ? AND sha IN (${ph(part.length)})`,
    ).all(repoPath, ...part) as { attribution: string | null; confidence: number | null; session_id: string | null; lines_added: number | null }[];
    for (const r of rows) {
      commits.matched++;
      const attr = (r.attribution || 'unknown') as 'ai' | 'human' | 'mixed' | 'unknown';
      const la = Number(r.lines_added) || 0;
      if (attr === 'ai') { commits.ai++; aiLines += la; }
      else if (attr === 'human') { commits.human++; humanLines += la; }
      else if (attr === 'mixed') { commits.mixed++; aiLines += la; } // mixed = AI-touched
      else { commits.unknown++; otherLines += la; }
      if (r.session_id) { commits.correlated++; sessionIds.add(r.session_id); }
      if (r.confidence != null) { confSum += Number(r.confidence); confN++; }
    }
  }
  commits.meanConfidence = confN ? confSum / confN : 0;

  const totalLines = aiLines + humanLines + otherLines;
  const aiPct = aiLines + humanLines > 0 ? (aiLines / (aiLines + humanLines)) * 100 : 0;

  // Cost + tool reliability of the sessions behind these commits.
  let costUsd = 0, hasUnpriced = false, calls = 0, errors = 0;
  for (const ids of chunks([...sessionIds])) {
    const mu = db.prepare(
      `SELECT model, input_tokens AS input, output_tokens AS output, cache_read AS cacheRead, cache_write AS cacheWrite FROM model_usage WHERE session_id IN (${ph(ids.length)})`,
    ).all(...ids) as { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }[];
    for (const m of mu) {
      const c = estimateCostUsd(m.model, { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite });
      if (c == null) hasUnpriced = true; else costUsd += c;
    }
    const tc = db.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(is_error), 0) AS errors FROM tool_calls WHERE session_id IN (${ph(ids.length)})`,
    ).get(...ids) as { calls: number; errors: number };
    calls += tc.calls; errors += tc.errors;
  }
  const errorRate = calls ? errors / calls : 0;

  // Risk surface + never-reviewed among the changed files.
  const riskFiles: { file: string; flags: string[] }[] = [];
  const neverReviewed: { file: string; aiLines: number }[] = [];
  for (const part of chunks(changedFiles)) {
    const fa = db.prepare(
      `SELECT file_path, ai_lines, human_lines, risk_flags FROM git_file_authorship WHERE repo_path = ? AND file_path IN (${ph(part.length)})`,
    ).all(repoPath, ...part) as { file_path: string; ai_lines: number; human_lines: number; risk_flags: string | null }[];
    for (const f of fa) {
      if (f.risk_flags) riskFiles.push({ file: f.file_path, flags: f.risk_flags.split(',').filter(Boolean) });
      if ((f.human_lines || 0) === 0 && (f.ai_lines || 0) > 0) neverReviewed.push({ file: f.file_path, aiLines: f.ai_lines });
    }
  }

  // Warnings only (P0 never blocks).
  const warnings: string[] = [];
  if (config.maxSessionCostUsd != null && costUsd > config.maxSessionCostUsd) warnings.push(`cost $${costUsd.toFixed(2)} exceeds $${config.maxSessionCostUsd}`);
  if (config.maxToolErrorRate != null && errorRate > config.maxToolErrorRate) warnings.push(`tool-error rate ${(errorRate * 100).toFixed(0)}% exceeds ${(config.maxToolErrorRate * 100).toFixed(0)}%`);
  if (config.maxAiPct != null && aiPct > config.maxAiPct) warnings.push(`AI authorship ${aiPct.toFixed(0)}% exceeds ${config.maxAiPct}%`);
  if (config.blockIfRiskFlag?.length) {
    const set = new Set(config.blockIfRiskFlag);
    const hit = riskFiles.filter((rf) => rf.flags.some((fl) => set.has(fl)));
    if (hit.length) warnings.push(`${hit.length} file(s) touch protected surface [${config.blockIfRiskFlag.join(', ')}]`);
  }

  return {
    repoPath, base, head, rangeCommits: shas.length, commits,
    lines: { ai: aiLines, human: humanLines, total: totalLines, aiPct },
    cost: { usd: costUsd, hasUnpriced, sessions: sessionIds.size },
    tools: { calls, errors, errorRate },
    changedFiles: changedFiles.length, riskFiles, neverReviewed, warnings,
  };
}

const usd = (n: number) => (n < 0.01 ? '<$0.01' : '$' + n.toFixed(2));

/** Sticky PR-comment markdown. */
export function toMarkdown(d: AgentDiff): string {
  if (d.commits.matched === 0) {
    return `### 🤖 AgentDX agent diff\n\nNo AI-agent sessions correlated to the ${d.rangeCommits} commit(s) in \`${d.base}..${d.head}\`.`;
  }
  const conf = d.commits.meanConfidence;
  const lines = [
    '### 🤖 AgentDX agent diff',
    '',
    `**${d.lines.ai.toLocaleString()} AI** / ${d.lines.human.toLocaleString()} human lines added · ${d.lines.aiPct.toFixed(0)}% AI _(confidence ${(conf * 100).toFixed(0)}%)_`,
    `**${usd(d.cost.usd)}**${d.cost.hasUnpriced ? ' (floor)' : ''} across ${d.cost.sessions} session(s) · ${d.tools.calls} tool calls · ${(d.tools.errorRate * 100).toFixed(0)}% errors`,
    `${d.commits.correlated}/${d.rangeCommits} commits correlated to agent sessions`,
  ];
  if (d.riskFiles.length) {
    lines.push('', '**⚠ Risk surface touched:**');
    for (const r of d.riskFiles.slice(0, 10)) lines.push(`- \`${r.file}\` — ${r.flags.join(', ')}`);
  }
  if (d.neverReviewed.length) {
    lines.push('', `**👁 Never human-reviewed (${d.neverReviewed.length}):**`);
    for (const r of d.neverReviewed.slice(0, 10)) lines.push(`- \`${r.file}\` — ${r.aiLines} AI lines, 0 human`);
  }
  if (d.warnings.length) {
    lines.push('', '**Threshold warnings (non-blocking):**');
    for (const w of d.warnings) lines.push(`- ⚠ ${w}`);
  }
  lines.push('', '_Attribution is a confidence-scored heuristic; line counts and cost are exact. Non-blocking._');
  return lines.join('\n');
}

/** SARIF 2.1.0 so AppSec ingests AI-authored hotspots alongside CodeQL/ESLint. */
export function toSarif(d: AgentDiff): string {
  const results: any[] = [];
  for (const r of d.riskFiles) {
    results.push({
      ruleId: 'agentdx/risk-surface',
      level: 'warning',
      message: { text: `AI-touched file on risk surface: ${r.flags.join(', ')}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: r.file } } }],
    });
  }
  for (const r of d.neverReviewed) {
    results.push({
      ruleId: 'agentdx/never-reviewed',
      level: 'warning',
      message: { text: `${r.aiLines} AI-authored lines with no human review` },
      locations: [{ physicalLocation: { artifactLocation: { uri: r.file } } }],
    });
  }
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: 'AgentDX',
        informationUri: 'https://github.com/navd/agentdx',
        rules: [
          { id: 'agentdx/risk-surface', name: 'RiskSurfaceTouched', shortDescription: { text: 'AI-touched file on a risk surface (auth/secret/migration/etc.)' } },
          { id: 'agentdx/never-reviewed', name: 'NeverHumanReviewed', shortDescription: { text: 'AI-authored file with no human-authored lines' } },
        ],
      } },
      results,
    }],
  }, null, 2);
}
