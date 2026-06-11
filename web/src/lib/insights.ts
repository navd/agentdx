import { getDb } from './db';

/**
 * Insights engine.
 *
 * Turns raw session/tool data into *judgements*, not numbers. The headline
 * question — "which agent is best?" — is answered on a SHIPPING-EFFICIENCY
 * rubric: how much shipped code (edits + commits) each agent produces per
 * 1M tokens, with reliability as a tiebreak.
 *
 * Honesty about data quality is built in:
 *  - `duration_ms` is session wall-span (includes idle) → unreliable for
 *    "time spent"; we surface it only as a caveat, never in the verdict.
 *  - Some agents (Codex, Cursor) don't record tool errors → reliability is
 *    marked "no signal" rather than a misleading 0%.
 *  - Cursor commits aren't captured from its transcripts.
 */

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'write_file', 'apply_patch', 'str_replace', 'StrReplace'];
const SHELL_TOOLS = ['Bash', 'Shell', 'exec_command'];

export interface AgentMetric {
  agent: string;
  sessions: number;
  edits: number;
  commits: number;
  ship: number;            // edits + commits = "shipped work"
  tokens: number;
  cacheRead: number;       // cache-read tokens (0 = agent logs no cache)
  noTokenCapture: boolean; // logs NO tokens at all (VS Code, Antigravity) → share is meaningless
  partialTokenCapture: boolean; // logs real input/output but no cache reads (Cursor) → share understated, still real
  shipPerMtok: number;     // primary efficiency metric
  tokPerCommit: number | null;
  errRate: number | null;  // null = no error signal from this agent
  archetype: 'Shipper' | 'Thinker' | 'Generalist' | 'Quiet';
}

export interface Insight {
  key: string;
  title: string;
  /** One-sentence judgement — the thing a human reads and remembers. */
  headline: string;
  detail?: string;
}

export interface ScatterDot { x: number; y: number; size: number; color: string; label: string; href: string; }
export interface ShareSeg { key: string; value: number; color: string; label: string; href: string; }
export interface ModelIO { model: string; input: number; output: number; color: string; href: string; }

export interface Insights {
  hasData: boolean;
  agents: AgentMetric[];
  verdict: {
    winner: string | null;
    headline: string;
    reason: string;
  };
  insights: Insight[];
  caveats: string[];
  totals: { ship: number; tokens: number; sessions: number };
  scatter: ScatterDot[];      // per-session effort (tokens) vs output (edits+commits)
  tokenShare: ShareSeg[];     // token spend split by agent
  modelIO: ModelIO[];         // input vs output (fresh tokens) per model
}

/** Stable per-model color palette (distinct, visible on both themes). */
const MODEL_PALETTE = ['#22C55E', '#F59E0B', '#6366F1', '#EC4899', '#06B6D4', '#8B5CF6', '#EF4444'];

/** Stable per-agent colors (match the dashboard chart palette). */
export const AGENT_COLORS: Record<string, string> = {
  'claude-code': '#46A35E', // green
  cowork: '#C15F3C',        // terracotta
  cursor: '#E0A458',        // amber
  codex: '#6366F1',         // indigo
  antigravity: '#14B8A6',   // teal
  vscode: '#3B82F6',        // blue
  continue: '#8B5CF6',      // purple
};
function agentColor(a: string): string {
  return AGENT_COLORS[a] || 'var(--text-muted)';
}

function classify(m: { ship: number; tokens: number; edits: number }): AgentMetric['archetype'] {
  const perM = m.tokens > 0 ? m.ship / (m.tokens / 1e6) : 0;
  if (m.ship < 5 && m.tokens > 50e6) return 'Thinker';   // burns tokens, ships little
  if (m.ship < 5) return 'Quiet';
  if (perM >= 100) return 'Shipper';
  return 'Generalist';
}

function fmtTokShort(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

export function getInsights(): Insights {
  const db = getDb();
  const editList = EDIT_TOOLS.map((t) => `'${t}'`).join(',');
  const shellList = SHELL_TOOLS.map((t) => `'${t}'`).join(',');

  // Token total includes cache reads — same definition the rest of the
  // dashboard (Models ring, status) uses, so the headline numbers reconcile.
  const base = db.prepare(`
    SELECT agent, COUNT(*) AS sessions,
      SUM(total_input_tokens + total_output_tokens + total_cache_read) AS tokens,
      SUM(total_cache_read) AS cacheRead,
      SUM(turn_count) AS turns
    FROM sessions GROUP BY agent
  `).all() as Array<{ agent: string; sessions: number; tokens: number; cacheRead: number; turns: number }>;

  if (base.length === 0) {
    return { hasData: false, agents: [], verdict: { winner: null, headline: 'No data yet.', reason: 'Run `agentdx collect` to populate insights.' }, insights: [], caveats: [], totals: { ship: 0, tokens: 0, sessions: 0 }, scatter: [], tokenShare: [], modelIO: [] };
  }

  const editsBy = mapCount(db.prepare(`
    SELECT s.agent AS a, COUNT(*) AS n FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    WHERE tc.tool_name IN (${editList}) GROUP BY s.agent
  `).all());
  const commitsBy = mapCount(db.prepare(`
    SELECT s.agent AS a, COUNT(*) AS n FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    WHERE tc.tool_name IN (${shellList}) AND tc.tool_input LIKE '%git commit%' GROUP BY s.agent
  `).all());
  const errBy = new Map<string, { e: number; t: number }>();
  for (const r of db.prepare(`
    SELECT s.agent AS a, SUM(tc.is_error) AS e, COUNT(*) AS t FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id GROUP BY s.agent
  `).all() as Array<{ a: string; e: number; t: number }>) {
    errBy.set(r.a, { e: r.e || 0, t: r.t || 0 });
  }

  const agents: AgentMetric[] = base.map((b) => {
    const edits = editsBy.get(b.agent) || 0;
    const commits = commitsBy.get(b.agent) || 0;
    const ship = edits + commits;
    const tokens = b.tokens || 0;
    const cacheRead = b.cacheRead || 0;
    const er = errBy.get(b.agent) || { e: 0, t: 0 };
    // An agent that logged tool calls but never a single error almost
    // certainly doesn't emit an error signal — don't fake a perfect 0%.
    const errSignal = er.e > 0;
    return {
      agent: b.agent,
      sessions: b.sessions,
      edits,
      commits,
      ship,
      tokens,
      cacheRead,
      // Distinguish a total capture failure (no tokens at all → share is
      // meaningless) from a partial one (real input/output logged but no cache
      // reads, e.g. Cursor → share is understated but still real). Conflating
      // them hid Cursor's genuine non-zero tokens behind a "~0%".
      noTokenCapture: b.sessions > 0 && tokens === 0,
      partialTokenCapture: b.sessions > 0 && tokens > 0 && cacheRead === 0,
      shipPerMtok: tokens > 0 ? ship / (tokens / 1e6) : 0,
      tokPerCommit: commits > 0 ? tokens / commits : null,
      errRate: errSignal ? (100 * er.e) / er.t : null,
      archetype: classify({ ship, tokens, edits }),
    };
  }).sort((a, z) => z.shipPerMtok - a.shipPerMtok);

  const totals = {
    ship: agents.reduce((s, a) => s + a.ship, 0),
    tokens: agents.reduce((s, a) => s + a.tokens, 0),
    sessions: agents.reduce((s, a) => s + a.sessions, 0),
  };

  // ── Verdict ───────────────────────────────────────────────────
  // Lead with ABSOLUTE shipped-output share — it can't be distorted by uneven
  // token capture across agents (Cursor undercounts; Claude is cache-heavy),
  // unlike a per-token ratio. Efficiency is reported as a supporting figure.
  const totalShip = agents.reduce((s, a) => s + a.ship, 0) || 1;
  const ranked = [...agents].sort((a, z) => z.ship - a.ship);
  const winner = ranked[0];
  const runner = ranked[1];

  let verdictHeadline: string;
  let verdictReason: string;
  if (winner && winner.ship >= 10) {
    const share = Math.round((100 * winner.ship) / totalShip);
    verdictHeadline = `${winner.agent} is your primary shipper — ${share}% of every change you ship.`;
    verdictReason = `${winner.edits.toLocaleString()} edits + ${winner.commits} commits (${winner.ship.toLocaleString()} of ${totalShip.toLocaleString()})` +
      (runner ? `, vs ${Math.round((100 * runner.ship) / totalShip)}% from ${runner.agent}` : '') +
      `. It ships ${winner.shipPerMtok < 1 ? winner.shipPerMtok.toFixed(1) : Math.round(winner.shipPerMtok)} changes per 1M tokens` +
      (winner.errRate != null ? ` at a ${winner.errRate.toFixed(1)}% tool-error rate` : '') + '.';
  } else {
    verdictHeadline = `Not enough shipped work to crown a winner yet.`;
    verdictReason = `Keep collecting — the verdict sharpens as more sessions land.`;
  }

  // ── Sentence-led insights ─────────────────────────────────────
  const insights: Insight[] = [];

  const thinker = agents.find((a) => a.archetype === 'Thinker');
  if (thinker) {
    insights.push({
      key: 'thinker',
      title: 'Thinker, not shipper',
      headline: `${thinker.agent} is where you reason, not where you ship.`,
      detail: `${fmtTokShort(thinker.tokens)} tokens produced just ${thinker.ship} change${thinker.ship === 1 ? '' : 's'}` +
        (thinker.tokPerCommit ? ` — ~${fmtTokShort(thinker.tokPerCommit)} tokens per commit` : '') +
        `. That's exploration spend, not delivery.`,
    });
  }

  const shipper = agents.find((a) => a.archetype === 'Shipper') || winner;
  if (shipper && shipper.ship >= 10) {
    insights.push({
      key: 'workhorse',
      title: 'Your workhorse',
      headline: `${shipper.agent} did ${pct(shipper.ship, totals.ship)} of all your shipped work.`,
      detail: `${shipper.edits.toLocaleString()} edits + ${shipper.commits} commits. When code actually lands, it's almost always ${shipper.agent}.`,
    });
  }

  // Require a meaningful commit count on both ends — comparing tokens-per-commit
  // across agents with 1-2 commits is noise, not signal.
  const MIN_COMMITS = 5;
  const withCommitCost = agents.filter((a) => a.tokPerCommit != null && a.commits >= MIN_COMMITS).sort((a, z) => (a.tokPerCommit! - z.tokPerCommit!));
  if (withCommitCost.length >= 2) {
    const cheap = withCommitCost[0];
    const dear = withCommitCost[withCommitCost.length - 1];
    const ratio = dear.tokPerCommit! / cheap.tokPerCommit!;
    insights.push({
      key: 'commit-cost',
      title: 'Cost of a commit',
      headline: `A commit costs ${fmtTokShort(cheap.tokPerCommit!)} tokens on ${cheap.agent} but ${fmtTokShort(dear.tokPerCommit!)} on ${dear.agent}.`,
      detail: `${ratio.toFixed(0)}× difference. Route delivery work to ${cheap.agent}; reserve ${dear.agent} for hard reasoning.`,
    });
  }

  const reliable = agents.filter((a) => a.errRate != null).sort((a, z) => a.errRate! - z.errRate!);
  if (reliable.length) {
    const r = reliable[0];
    insights.push({
      key: 'reliability',
      title: 'Error tax',
      headline: reliable.length === 1
        ? `${r.agent} fails ${r.errRate!.toFixed(1)}% of its tool calls — the only agent that reports errors.`
        : `${r.agent} is your most reliable: ${r.errRate!.toFixed(1)}% tool-error rate.`,
      detail: `Every failed call is rework. Agents without an error rate below simply don't report one.`,
    });
  }

  // ── Caveats (honesty) ─────────────────────────────────────────
  const caveats: string[] = [];
  caveats.push('Tokens include cached reads (matches the rest of the dashboard). Most of Claude’s volume is cheap cached-context reuse; Codex does the most fresh-input work — so raw token share overstates Claude’s real cost.');
  caveats.push('Cross-agent token-efficiency is approximate — capture completeness differs (Cursor records no cache and undercounts), so the verdict leads with absolute shipped output, not a per-token ratio.');
  caveats.push('Time-spent is omitted: session duration is wall-span (includes idle), not active work — too noisy to rank on.');
  const noErr = agents.filter((a) => a.errRate == null).map((a) => a.agent);
  if (noErr.length) caveats.push(`No tool-error signal from ${noErr.join(', ')} — reliability can't be compared there.`);
  if ((commitsBy.get('cursor') || 0) === 0 && agents.some((a) => a.agent === 'cursor')) {
    caveats.push("Cursor commits aren't captured from its transcripts, so its shipping rate is understated.");
  }

  // ── Effort → output scatter (one dot per session) ─────────────
  const sessionRows = db.prepare(`
    SELECT s.id, s.agent,
      (s.total_input_tokens + s.total_output_tokens + s.total_cache_read) AS tokens,
      s.turn_count AS turns,
      (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id AND t.tool_name IN (${editList})) AS edits,
      (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id AND t.tool_name IN (${shellList}) AND t.tool_input LIKE '%git commit%') AS commits
    FROM sessions s
  `).all() as Array<{ id: string; agent: string; tokens: number; turns: number; edits: number; commits: number }>;

  const scatter: ScatterDot[] = sessionRows
    .map((r) => ({
      x: r.tokens || 0,
      y: (r.edits || 0) + (r.commits || 0),
      size: Math.max(1, r.turns || 1),
      color: agentColor(r.agent),
      label: `${r.agent} · ${(r.edits || 0) + (r.commits || 0)} changes · ${fmtTokShort(r.tokens || 0)} tok`,
      href: `/sessions/${r.id}`,
    }))
    .filter((d) => d.x > 0 || d.y > 0);

  // ── Token spend split by agent ────────────────────────────────
  const tokenShare: ShareSeg[] = agents
    .filter((a) => a.tokens > 0)
    .map((a) => ({ key: a.agent, value: a.tokens, color: agentColor(a.agent), label: a.agent, href: `/sessions?agent=${encodeURIComponent(a.agent)}` }));

  // ── Input vs output (fresh tokens) per model ──────────────────
  // Cache reads excluded here on purpose: this card is about *fresh* work —
  // how much the model reads in vs writes out, where the real cost lives.
  const modelRows = db.prepare(`
    SELECT model, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp
    FROM model_usage WHERE model != '<synthetic>'
    GROUP BY model HAVING (inp + outp) > 0
    ORDER BY (inp + outp) DESC LIMIT 7
  `).all() as Array<{ model: string; inp: number; outp: number }>;
  const modelIO: ModelIO[] = modelRows.map((r, i) => ({
    model: r.model,
    input: r.inp || 0,
    output: r.outp || 0,
    color: MODEL_PALETTE[i % MODEL_PALETTE.length],
    href: `/sessions?model=${encodeURIComponent(r.model)}`,
  }));

  return { hasData: true, agents, verdict: { winner: winner?.agent ?? null, headline: verdictHeadline, reason: verdictReason }, insights, caveats, totals, scatter, tokenShare, modelIO };
}

function mapCount(rows: any[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.a, r.n);
  return m;
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  return Math.round((100 * part) / whole) + '%';
}
