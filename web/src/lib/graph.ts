import type Database from 'better-sqlite3';

/**
 * Knowledge-graph model over agentdx.db.
 *
 * The graph is explored, not dumped: buildGraph() returns a small high-level
 * overview (agents · repos · models with aggregated token edges) and
 * expandNode() pulls the typed neighbours of any single node on demand
 * (agent→sessions, session→files/prompts/tools, file→co-changed files, …).
 *
 * Honesty: token weights are only attached where tokens are actually measured
 * — session, model, agent, repo, prompt. File nodes are weighted by INTERACTION
 * COUNT (edits+reads), never by a fabricated per-file token split.
 */

export type NodeType =
  | 'agent' | 'repo' | 'model' | 'session' | 'file' | 'prompt' | 'skill' | 'tool';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  /**
   * Sizing metric. For token-bearing types this is REAL WORK (input + output),
   * deliberately excluding cache-read — cache reads repeat every turn and would
   * otherwise dominate node size with noise. For files it is interaction count;
   * for skills/tools, invocation count.
   */
  weight: number;
  /** true when `weight` is an interaction/invocation count, not tokens. */
  countOnly?: boolean;
  /**
   * Structural size that IS comparable across agents (sessions / tool calls /
   * interactions) — used when sizing "by count". Token totals aren't comparable
   * (Codex logs cumulative context, Claude logs per-call), so count is the
   * honest default for cross-agent comparison.
   */
  count?: number;
  /** token breakdown (token-bearing nodes only) — surfaced in the side panel. */
  tin?: number;
  tout?: number;
  tcache?: number;
  sub?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; }

export interface GraphOpts {
  /** node types allowed in the overview seed (expansion ignores this). */
  types?: NodeType[];
  /** epoch ms lower bound on session start. */
  since?: number | null;
  /** weight/size basis where a choice exists. */
  weightBy?: 'tokens' | 'count';
}

// Canonical app-wide token total = input + output + cache_read (matches every
// other page; the panel still breaks the three apart). Using input+output only
// here previously reordered nodes — it ranked cache-light agents (Codex) above
// cache-heavy ones (Claude Code) and contradicted each session's detail page.
const SESSION_TOK = '(s.total_input_tokens + s.total_output_tokens + s.total_cache_read)';

const nid = (t: NodeType, key: string) => `${t}:${key}`;
const eid = (a: string, b: string, t: string) => `${a}__${t}__${b}`;

function fileLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

function pushNode(map: Map<string, GraphNode>, n: GraphNode) {
  const ex = map.get(n.id);
  if (!ex || n.weight > ex.weight) map.set(n.id, n);
}

/** Build a session node from a row carrying id/title/agent/tokens/tool_call_count. */
function sessionNodeFrom(r: any): GraphNode {
  return {
    id: nid('session', r.id), type: 'session',
    label: (r.title || r.first_user_message || r.id).toString().slice(0, 40),
    weight: r.w != null ? r.w : (r.ti || 0) + (r.to_ || 0),
    count: r.tcc || 0, tin: r.ti, tout: r.to_, tcache: r.tc,
    sub: `${r.agent} · ${r.tcc || 0} tool calls`,
  };
}

// ── Overview ────────────────────────────────────────────────────────────────

/** High-level seed graph: agents, repos, models + aggregated token edges. */
export function buildGraph(db: Database.Database, opts: GraphOpts = {}): Graph {
  const since = opts.since ?? null;
  const sinceClause = since ? `WHERE s.started_at >= ${Number(since)}` : '';
  const allow = new Set(opts.types ?? ['agent', 'repo', 'model']);

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  if (allow.has('agent')) {
    for (const r of db.prepare(`
      SELECT s.agent AS k, SUM(${SESSION_TOK}) AS w, COUNT(*) AS c,
             SUM(s.total_input_tokens) AS ti, SUM(s.total_output_tokens) AS to_, SUM(s.total_cache_read) AS tc
      FROM sessions s ${sinceClause} GROUP BY s.agent
    `).all() as any[]) {
      if (!r.k) continue;
      pushNode(nodes, { id: nid('agent', r.k), type: 'agent', label: r.k, weight: r.w || 0, count: r.c, tin: r.ti, tout: r.to_, tcache: r.tc, sub: `${r.c} sessions` });
    }
  }

  if (allow.has('repo')) {
    for (const r of db.prepare(`
      SELECT s.project_path AS k, SUM(${SESSION_TOK}) AS w, COUNT(*) AS c,
             SUM(s.total_input_tokens) AS ti, SUM(s.total_output_tokens) AS to_, SUM(s.total_cache_read) AS tc
      FROM sessions s ${sinceClause} ${sinceClause ? 'AND' : 'WHERE'} s.project_path IS NOT NULL
      GROUP BY s.project_path
    `).all() as any[]) {
      if (!r.k) continue;
      const name = r.k.split(/[\\/]/).filter(Boolean).pop() || r.k;
      pushNode(nodes, { id: nid('repo', r.k), type: 'repo', label: name, weight: r.w || 0, count: r.c, tin: r.ti, tout: r.to_, tcache: r.tc, sub: `${r.c} sessions` });
    }
  }

  if (allow.has('model')) {
    for (const r of db.prepare(`
      SELECT mu.model AS k, SUM(mu.input_tokens + mu.output_tokens) AS w, COUNT(DISTINCT mu.session_id) AS c,
             SUM(mu.input_tokens) AS ti, SUM(mu.output_tokens) AS to_, SUM(mu.cache_read) AS tc
      FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
      ${sinceClause} GROUP BY mu.model
    `).all() as any[]) {
      if (!r.k) continue;
      pushNode(nodes, { id: nid('model', r.k), type: 'model', label: r.k, weight: r.w || 0, count: r.c, tin: r.ti, tout: r.to_, tcache: r.tc });
    }
  }

  const has = (id: string) => nodes.has(id);
  const addEdge = (a: string, b: string, type: string, weight: number) => {
    if (!has(a) || !has(b)) return;
    edges.set(eid(a, b, type), { id: eid(a, b, type), source: a, target: b, type, weight });
  };

  // agent ↔ repo
  for (const r of db.prepare(`
    SELECT s.agent AS a, s.project_path AS r, SUM(${SESSION_TOK}) AS w
    FROM sessions s ${sinceClause} ${sinceClause ? 'AND' : 'WHERE'} s.project_path IS NOT NULL
    GROUP BY s.agent, s.project_path
  `).all() as any[]) {
    addEdge(nid('agent', r.a), nid('repo', r.r), 'works-in', r.w || 0);
  }
  // agent ↔ model and repo ↔ model
  for (const r of db.prepare(`
    SELECT s.agent AS a, s.project_path AS r, mu.model AS m,
           SUM(mu.input_tokens + mu.output_tokens) AS w
    FROM model_usage mu JOIN sessions s ON s.id = mu.session_id
    ${sinceClause} GROUP BY s.agent, s.project_path, mu.model
  `).all() as any[]) {
    addEdge(nid('agent', r.a), nid('model', r.m), 'uses', r.w || 0);
    if (r.r) addEdge(nid('repo', r.r), nid('model', r.m), 'runs', r.w || 0);
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ── Search ──────────────────────────────────────────────────────────────────

/** Find any entity by name/text across every node type. Powers the search box. */
export function searchNodes(db: Database.Database, q: string, limit = 24): GraphNode[] {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const out: GraphNode[] = [];

  for (const r of db.prepare(`
    SELECT file_path, COUNT(*) c FROM file_events WHERE file_path LIKE ? ESCAPE '\\'
    GROUP BY file_path ORDER BY c DESC LIMIT 8`).all(like) as any[]) {
    out.push({ id: nid('file', r.file_path), type: 'file', label: fileLabel(r.file_path), weight: r.c, countOnly: true, sub: r.file_path });
  }
  for (const r of db.prepare(`
    SELECT id, title, first_user_message, agent, tool_call_count AS tcc,
           total_input_tokens AS ti, total_output_tokens AS to_, total_cache_read AS tc, ${SESSION_TOK} AS w FROM sessions s
    WHERE title LIKE ? ESCAPE '\\' OR first_user_message LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'
    ORDER BY w DESC LIMIT 6`).all(like, like, like) as any[]) {
    out.push({ id: nid('session', r.id), type: 'session', label: (r.title || r.first_user_message || r.id).toString().slice(0, 40), weight: r.w || 0, count: r.tcc || 0, tin: r.ti, tout: r.to_, tcache: r.tc, sub: r.agent });
  }
  for (const r of db.prepare(`
    SELECT m.id, m.content_text, m.input_tokens + m.output_tokens AS w FROM messages m
    WHERE m.role = 'user' AND m.content_text LIKE ? ESCAPE '\\'
    ORDER BY w DESC LIMIT 6`).all(like) as any[]) {
    out.push({ id: nid('prompt', r.id), type: 'prompt', label: r.content_text.replace(/\s+/g, ' ').slice(0, 44), weight: r.w || 0, sub: 'prompt' });
  }
  for (const r of db.prepare(`SELECT project_path AS p, SUM(${SESSION_TOK}) AS w FROM sessions s WHERE project_path LIKE ? ESCAPE '\\' GROUP BY project_path LIMIT 4`).all(like) as any[]) {
    if (!r.p) continue;
    out.push({ id: nid('repo', r.p), type: 'repo', label: r.p.split(/[\\/]/).filter(Boolean).pop() || r.p, weight: r.w || 0, sub: r.p });
  }
  for (const r of db.prepare(`SELECT DISTINCT model FROM model_usage WHERE model LIKE ? ESCAPE '\\' LIMIT 4`).all(like) as any[]) {
    out.push({ id: nid('model', r.model), type: 'model', label: r.model, weight: 0 });
  }
  for (const r of db.prepare(`SELECT DISTINCT agent FROM sessions WHERE agent LIKE ? ESCAPE '\\' LIMIT 4`).all(like) as any[]) {
    out.push({ id: nid('agent', r.agent), type: 'agent', label: r.agent, weight: 0 });
  }
  for (const r of db.prepare(`SELECT skill, COUNT(*) c FROM skill_invocations WHERE skill LIKE ? ESCAPE '\\' GROUP BY skill LIMIT 4`).all(like) as any[]) {
    out.push({ id: nid('skill', r.skill), type: 'skill', label: r.skill, weight: r.c, countOnly: true });
  }
  for (const r of db.prepare(`SELECT tool_name, COUNT(*) c FROM tool_calls WHERE tool_name LIKE ? ESCAPE '\\' GROUP BY tool_name LIMIT 4`).all(like) as any[]) {
    out.push({ id: nid('tool', r.tool_name), type: 'tool', label: r.tool_name, weight: r.c, countOnly: true });
  }

  return out.slice(0, limit);
}

/** Seeded "quick query" subgraphs — answer a common question with one click. */
export function quickQuery(db: Database.Database, key: string): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const push = (n: GraphNode) => nodes.set(n.id, n);
  const link = (a: string, b: string, t: string, w: number) => edges.set(eid(a, b, t), { id: eid(a, b, t), source: a, target: b, type: t, weight: w });
  const repoNode = (p: string) => { const name = p.split(/[\\/]/).filter(Boolean).pop() || p; nodes.set(nid('repo', p), { id: nid('repo', p), type: 'repo', label: name, weight: 0, sub: 'repository' }); };

  if (key === 'top-files') {
    for (const r of db.prepare(`SELECT file_path, repo_path, COUNT(*) c, SUM(lines_added) a, SUM(lines_removed) rm FROM file_events GROUP BY file_path ORDER BY c DESC LIMIT 20`).all() as any[]) {
      push({ id: nid('file', r.file_path), type: 'file', label: fileLabel(r.file_path), weight: r.c, count: r.c, countOnly: true, sub: `${r.c} touches · +${r.a}/-${r.rm}` });
      if (r.repo_path) { repoNode(r.repo_path); link(nid('file', r.file_path), nid('repo', r.repo_path), 'in', r.c); } // cluster files by repo
    }
  } else if (key === 'top-prompts') {
    for (const r of db.prepare(`SELECT m.id, m.content_text, m.session_id, m.input_tokens + m.output_tokens AS w, s.agent, s.title, s.first_user_message, s.started_at, s.tool_call_count AS tcc, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.role='user' AND m.content_text IS NOT NULL ORDER BY w DESC LIMIT 18`).all() as any[]) {
      push({ id: nid('prompt', r.id), type: 'prompt', label: r.content_text.replace(/\s+/g, ' ').slice(0, 44), weight: r.w || 0, sub: 'prompt' });
      nodes.set(nid('session', r.session_id), sessionNodeFrom(r));
      link(nid('prompt', r.id), nid('session', r.session_id), 'in', r.w || 0); // anchor each prompt to its session
    }
  } else if (key === 'top-sessions') {
    for (const r of db.prepare(`SELECT s.id, s.title, s.first_user_message, s.agent, s.project_path, s.tool_call_count AS tcc, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc, s.started_at, ${SESSION_TOK} AS w FROM sessions s ORDER BY w DESC LIMIT 18`).all() as any[]) {
      nodes.set(nid('session', r.id), sessionNodeFrom(r));
      nodes.set(nid('agent', r.agent), { id: nid('agent', r.agent), type: 'agent', label: r.agent, weight: 0 });
      link(nid('agent', r.agent), nid('session', r.id), 'ran', 0);
      if (r.project_path) { repoNode(r.project_path); link(nid('session', r.id), nid('repo', r.project_path), 'in', 0); } // cluster sessions by repo
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ── Node stats (the takeaway fact shown when a node is selected) ─────────────

export function nodeStats(db: Database.Database, nodeId: string): { fact: string } | null {
  const i = nodeId.indexOf(':');
  const type = nodeId.slice(0, i);
  const key = nodeId.slice(i + 1);

  if (type === 'file') {
    const r = db.prepare(`
      SELECT COUNT(*) touches, SUM(op IN ('edit','write','create')) edits,
             COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT agent) agents,
             SUM(lines_added) a, SUM(lines_removed) rm, MAX(timestamp) last
      FROM file_events WHERE file_path = ?`).get(key) as any;
    if (!r || !r.touches) return null;
    const day = new Date(r.last).toISOString().slice(0, 10);
    return { fact: `${r.edits} edits · ${r.touches} touches · ${r.sessions} sessions · ${r.agents} agent${r.agents === 1 ? '' : 's'} · +${r.a || 0}/-${r.rm || 0} · last ${day}` };
  }
  if (type === 'session') {
    const s = db.prepare(`SELECT tool_call_count tcc, duration_ms FROM sessions WHERE id = ?`).get(key) as any;
    if (!s) return null;
    const f = db.prepare(`SELECT COUNT(DISTINCT file_path) c FROM file_events WHERE session_id = ?`).get(key) as any;
    const p = db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id = ? AND role = 'user'`).get(key) as any;
    const mins = s.duration_ms ? Math.round(s.duration_ms / 60000) : null;
    return { fact: `${s.tcc || 0} tool calls · ${f.c} files · ${p.c} prompts${mins != null ? ` · ${mins}m` : ''}` };
  }
  if (type === 'repo') {
    const r = db.prepare(`SELECT COUNT(*) sessions, COUNT(DISTINCT agent) agents FROM sessions WHERE project_path = ?`).get(key) as any;
    const f = db.prepare(`SELECT COUNT(DISTINCT file_path) c FROM file_events WHERE repo_path = ?`).get(key) as any;
    if (!r || !r.sessions) return null;
    return { fact: `${r.sessions} sessions · ${r.agents} agents · ${f.c} files touched` };
  }
  return null;
}

// ── Expansion ───────────────────────────────────────────────────────────────

const LIMIT = 16;

/** Return the typed neighbours of a single node, ready to merge into the canvas. */
export function expandNode(db: Database.Database, nodeId: string): Graph {
  const idx = nodeId.indexOf(':');
  const type = nodeId.slice(0, idx) as NodeType;
  const key = nodeId.slice(idx + 1);

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const link = (a: string, b: string, t: string, w: number) =>
    edges.set(eid(a, b, t), { id: eid(a, b, t), source: a, target: b, type: t, weight: w });

  const sessionNode = (r: any): GraphNode => ({
    id: nid('session', r.id), type: 'session',
    label: (r.title || r.first_user_message || r.id).toString().slice(0, 40),
    weight: r.w || 0, count: r.tcc || 0, tin: r.ti, tout: r.to_, tcache: r.tc,
    sub: `${r.agent} · ${r.tcc || 0} tool calls · ${new Date(r.started_at).toISOString().slice(0, 10)}`,
  });

  switch (type) {
    case 'agent':
    case 'repo':
    case 'model':
    case 'skill':
    case 'tool': {
      // All five fan out to their top sessions.
      let rows: any[] = [];
      if (type === 'agent') rows = db.prepare(`
        SELECT s.id, s.title, s.first_user_message, s.agent, s.started_at, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc, s.tool_call_count AS tcc, ${SESSION_TOK} AS w
        FROM sessions s WHERE s.agent = ? ORDER BY w DESC LIMIT ${LIMIT}`).all(key);
      else if (type === 'repo') rows = db.prepare(`
        SELECT s.id, s.title, s.first_user_message, s.agent, s.started_at, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc, s.tool_call_count AS tcc, ${SESSION_TOK} AS w
        FROM sessions s WHERE s.project_path = ? ORDER BY w DESC LIMIT ${LIMIT}`).all(key);
      else if (type === 'model') rows = db.prepare(`
        SELECT s.id, s.title, s.first_user_message, s.agent, s.started_at, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc, s.tool_call_count AS tcc, ${SESSION_TOK} AS w
        FROM sessions s JOIN model_usage mu ON mu.session_id = s.id
        WHERE mu.model = ? ORDER BY w DESC LIMIT ${LIMIT}`).all(key);
      else if (type === 'skill') rows = db.prepare(`
        SELECT s.id, s.title, s.first_user_message, s.agent, s.started_at, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc, s.tool_call_count AS tcc, ${SESSION_TOK} AS w
        FROM sessions s JOIN skill_invocations si ON si.session_id = s.id
        WHERE si.skill = ? GROUP BY s.id ORDER BY w DESC LIMIT ${LIMIT}`).all(key);
      else rows = db.prepare(`
        SELECT s.id, s.title, s.first_user_message, s.agent, s.started_at, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc, s.tool_call_count AS tcc, ${SESSION_TOK} AS w
        FROM sessions s JOIN tool_calls tc ON tc.session_id = s.id
        WHERE tc.tool_name = ? GROUP BY s.id ORDER BY w DESC LIMIT ${LIMIT}`).all(key);
      for (const r of rows) {
        nodes.set(nid('session', r.id), sessionNode(r));
        link(nodeId, nid('session', r.id), 'has', r.w || 0);
      }
      break;
    }

    case 'session': {
      const s = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(key) as any;
      if (!s) break;
      if (s.project_path) {
        const name = s.project_path.split(/[\\/]/).filter(Boolean).pop() || s.project_path;
        nodes.set(nid('repo', s.project_path), { id: nid('repo', s.project_path), type: 'repo', label: name, weight: 0, sub: 'repository' });
        link(nodeId, nid('repo', s.project_path), 'in', 0);
      }
      nodes.set(nid('agent', s.agent), { id: nid('agent', s.agent), type: 'agent', label: s.agent, weight: 0 });
      link(nid('agent', s.agent), nodeId, 'ran', 0);
      // models
      for (const r of db.prepare(`SELECT model, input_tokens AS ti, output_tokens AS to_, cache_read AS tc, input_tokens+output_tokens AS w FROM model_usage WHERE session_id = ? ORDER BY w DESC`).all(key) as any[]) {
        if (!r.model) continue;
        nodes.set(nid('model', r.model), { id: nid('model', r.model), type: 'model', label: r.model, weight: r.w || 0, tin: r.ti, tout: r.to_, tcache: r.tc });
        link(nodeId, nid('model', r.model), 'uses', r.w || 0);
      }
      // files
      for (const r of db.prepare(`
        SELECT file_path, COUNT(*) c, SUM(lines_added) a, SUM(lines_removed) rm
        FROM file_events WHERE session_id = ? GROUP BY file_path ORDER BY c DESC LIMIT ${LIMIT}`).all(key) as any[]) {
        nodes.set(nid('file', r.file_path), { id: nid('file', r.file_path), type: 'file', label: fileLabel(r.file_path), weight: r.c, countOnly: true, sub: `${r.c} touches · +${r.a}/-${r.rm}` });
        link(nodeId, nid('file', r.file_path), 'touched', r.c);
      }
      // prompts (top user messages by tokens)
      for (const r of db.prepare(`
        SELECT id, content_text, input_tokens+output_tokens AS w
        FROM messages WHERE session_id = ? AND role = 'user' AND content_text IS NOT NULL
        ORDER BY w DESC LIMIT 6`).all(key) as any[]) {
        nodes.set(nid('prompt', r.id), { id: nid('prompt', r.id), type: 'prompt', label: r.content_text.replace(/\s+/g, ' ').slice(0, 44), weight: r.w || 0, sub: 'prompt' });
        link(nid('prompt', r.id), nodeId, 'in', r.w || 0);
      }
      // skills + tools
      for (const r of db.prepare(`SELECT skill, COUNT(*) c FROM skill_invocations WHERE session_id = ? GROUP BY skill ORDER BY c DESC LIMIT 8`).all(key) as any[]) {
        nodes.set(nid('skill', r.skill), { id: nid('skill', r.skill), type: 'skill', label: r.skill, weight: r.c, countOnly: true });
        link(nodeId, nid('skill', r.skill), 'invoked', r.c);
      }
      for (const r of db.prepare(`SELECT tool_name, COUNT(*) c FROM tool_calls WHERE session_id = ? GROUP BY tool_name ORDER BY c DESC LIMIT 8`).all(key) as any[]) {
        if (!r.tool_name) continue;
        nodes.set(nid('tool', r.tool_name), { id: nid('tool', r.tool_name), type: 'tool', label: r.tool_name, weight: r.c, countOnly: true });
        link(nodeId, nid('tool', r.tool_name), 'called', r.c);
      }
      break;
    }

    case 'file': {
      // sessions that touched this file
      for (const r of db.prepare(`
        SELECT s.id, s.title, s.first_user_message, s.agent, s.started_at, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc, s.tool_call_count AS tcc, ${SESSION_TOK} AS w,
               COUNT(*) c
        FROM file_events fe JOIN sessions s ON s.id = fe.session_id
        WHERE fe.file_path = ? GROUP BY s.id ORDER BY c DESC LIMIT ${LIMIT}`).all(key) as any[]) {
        nodes.set(nid('session', r.id), sessionNode(r));
        link(nid('session', r.id), nodeId, 'touched', r.c);
      }
      // co-changed files (edited in the same sessions)
      for (const r of db.prepare(`
        SELECT b.file_path AS f, COUNT(DISTINCT a.session_id) c
        FROM file_events a JOIN file_events b ON a.session_id = b.session_id AND b.file_path <> a.file_path
        WHERE a.file_path = ? GROUP BY b.file_path ORDER BY c DESC LIMIT ${LIMIT}`).all(key) as any[]) {
        nodes.set(nid('file', r.f), { id: nid('file', r.f), type: 'file', label: fileLabel(r.f), weight: r.c, countOnly: true, sub: `co-changed ×${r.c}` });
        link(nodeId, nid('file', r.f), 'co-changed', r.c);
      }
      break;
    }

    case 'prompt': {
      const m = db.prepare(`SELECT session_id, seq FROM messages WHERE id = ?`).get(key) as any;
      if (!m) break;
      const sid = m.session_id;
      // the turn = everything between this user message and the next user message
      const nxt = db.prepare(`SELECT MIN(seq) AS s FROM messages WHERE session_id = ? AND role = 'user' AND seq > ?`).get(sid, m.seq) as any;
      const seq0 = m.seq, seq1 = nxt?.s ?? 1e15;

      const s = db.prepare(`SELECT s.id, s.title, s.first_user_message, s.agent, s.started_at, s.total_input_tokens AS ti, s.total_output_tokens AS to_, s.total_cache_read AS tc, s.tool_call_count AS tcc, ${SESSION_TOK} AS w FROM sessions s WHERE s.id = ?`).get(sid) as any;
      if (s) { nodes.set(nid('session', sid), sessionNode(s)); link(nodeId, nid('session', sid), 'in', s.w || 0); }

      // model that answered this turn
      const mdl = db.prepare(`SELECT model, COUNT(*) c FROM messages WHERE session_id = ? AND role = 'assistant' AND model IS NOT NULL AND seq >= ? AND seq < ? GROUP BY model ORDER BY c DESC LIMIT 1`).get(sid, seq0, seq1) as any;
      if (mdl?.model) { nodes.set(nid('model', mdl.model), { id: nid('model', mdl.model), type: 'model', label: mdl.model, weight: 0 }); link(nodeId, nid('model', mdl.model), 'answered', 0); }

      // files this prompt led to
      for (const r of db.prepare(`
        SELECT fe.file_path, COUNT(*) c, SUM(fe.lines_added) a, SUM(fe.lines_removed) rm
        FROM file_events fe JOIN tool_calls tc ON tc.id = fe.tool_call_id JOIN messages msg ON msg.id = tc.message_id
        WHERE fe.session_id = ? AND msg.seq >= ? AND msg.seq < ?
        GROUP BY fe.file_path ORDER BY c DESC LIMIT ${LIMIT}`).all(sid, seq0, seq1) as any[]) {
        nodes.set(nid('file', r.file_path), { id: nid('file', r.file_path), type: 'file', label: fileLabel(r.file_path), weight: r.c, count: r.c, countOnly: true, sub: `+${r.a}/-${r.rm}` });
        link(nodeId, nid('file', r.file_path), 'changed', r.c);
      }
      // tools this prompt fired
      for (const r of db.prepare(`
        SELECT tc.tool_name, COUNT(*) c FROM tool_calls tc JOIN messages msg ON msg.id = tc.message_id
        WHERE tc.session_id = ? AND msg.seq >= ? AND msg.seq < ? AND tc.tool_name IS NOT NULL
        GROUP BY tc.tool_name ORDER BY c DESC LIMIT 8`).all(sid, seq0, seq1) as any[]) {
        nodes.set(nid('tool', r.tool_name), { id: nid('tool', r.tool_name), type: 'tool', label: r.tool_name, weight: r.c, count: r.c, countOnly: true });
        link(nodeId, nid('tool', r.tool_name), 'fired', r.c);
      }
      break;
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
