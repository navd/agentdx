'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import type { Graph, GraphNode, GraphEdge, NodeType } from '@/lib/graph';

const TYPE_COLOR: Record<NodeType, string> = {
  agent: 'var(--chart-1)',
  session: 'var(--chart-2)',
  model: 'var(--chart-3)',
  repo: 'var(--chart-4)',
  file: 'var(--chart-5)',
  prompt: '#8B5CF6',
  skill: 'var(--info)',
  tool: 'var(--text-subtle)',
};

const TYPE_ORDER: NodeType[] = ['agent', 'repo', 'model', 'session', 'file', 'prompt', 'skill', 'tool'];

interface Sim { x: number; y: number; vx: number; vy: number; pinned: boolean; }

function fmtK(v: number): string {
  return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v || 0));
}
function fmtWeight(n: GraphNode): string {
  return n.countOnly ? `${fmtK(n.weight)} interactions` : `${fmtK(n.weight)} tokens (in+out)`;
}

export function GraphExplorer({ initial }: { initial: Graph }) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Mutable graph + physics state kept in refs (mutated every frame).
  const nodesRef = useRef<Map<string, GraphNode>>(new Map());
  const edgesRef = useRef<Map<string, GraphEdge>>(new Map());
  const simRef = useRef<Map<string, Sim>>(new Map());
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanding, setExpanding] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<NodeType>>(new Set());
  const [weightBy, setWeightBy] = useState<'tokens' | 'count'>('count');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GraphNode[]>([]);
  const [stats, setStats] = useState<string | null>(null);
  const alphaRef = useRef(1);

  // ── ingest helper: merge nodes/edges, seed positions near a parent ──────────
  const ingest = useCallback((g: Graph, near?: string) => {
    const sim = simRef.current;
    const parent = near ? sim.get(near) : undefined;
    for (const n of g.nodes) {
      if (!nodesRef.current.has(n.id)) nodesRef.current.set(n.id, n);
      if (!sim.has(n.id)) {
        const a = Math.random() * Math.PI * 2;
        const r = 40 + Math.random() * 60;
        sim.set(n.id, {
          x: (parent?.x ?? 0) + Math.cos(a) * r,
          y: (parent?.y ?? 0) + Math.sin(a) * r,
          vx: 0, vy: 0, pinned: false,
        });
      }
    }
    for (const e of g.edges) edgesRef.current.set(e.id, e);
    alphaRef.current = 1;
  }, []);

  // center the world origin in the SVG viewport
  const centerView = useCallback(() => {
    const r = svgRef.current?.getBoundingClientRect();
    setView({ x: (r?.width ?? 800) / 2, y: (r?.height ?? 620) / 2, k: 1 });
  }, []);

  // fit the viewport to the current spread of visible nodes
  const fitView = useCallback(() => {
    const vis = [...nodesRef.current.values()].filter((n) => !hidden.has(n.type));
    const r = svgRef.current?.getBoundingClientRect();
    const W = r?.width ?? 800, H = r?.height ?? 620;
    if (!vis.length) { setView({ x: W / 2, y: H / 2, k: 1 }); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of vis) {
      const s = simRef.current.get(n.id); if (!s) continue;
      minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y);
    }
    const gw = Math.max(maxX - minX, 1), gh = Math.max(maxY - minY, 1);
    const pad = 90;
    const k = Math.max(0.2, Math.min(2, Math.min((W - pad) / gw, (H - pad) / gh)));
    setView({ k, x: W / 2 - ((minX + maxX) / 2) * k, y: H / 2 - ((minY + maxY) / 2) * k });
  }, [hidden]);

  // replace the whole canvas with a new graph (quick queries, reset to overview)
  const replaceWith = useCallback((g: Graph) => {
    nodesRef.current = new Map();
    edgesRef.current = new Map();
    simRef.current = new Map();
    setExpanded(new Set());
    setSelected(null);
    ingest(g);
    setTimeout(() => { fitView(); }, 1300);
    setTick((t) => t + 1);
  }, [ingest, fitView]);

  // initial load
  useEffect(() => {
    ingest(initial);
    centerView();
    setTick((t) => t + 1);
    const id = setTimeout(() => fitView(), 1400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fetch the takeaway fact for the selected node
  useEffect(() => {
    if (!selected) { setStats(null); return; }
    let alive = true;
    setStats(null);
    fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stats: selected }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setStats(j?.fact ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [selected]);

  // debounced entity search
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    const id = setTimeout(async () => {
      try {
        const r = await fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search: q }) });
        if (r.ok) setResults((await r.json()).results || []);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  // ── force simulation loop ───────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const sim = simRef.current;
      const nodes = [...nodesRef.current.values()].filter((n) => !hidden.has(n.type));
      const alpha = alphaRef.current;
      if (alpha > 0.005 && nodes.length) {
        // repulsion (O(n^2) — fine for the few hundred nodes we cap at)
        for (let i = 0; i < nodes.length; i++) {
          const a = sim.get(nodes[i].id)!;
          for (let j = i + 1; j < nodes.length; j++) {
            const b = sim.get(nodes[j].id)!;
            let dx = a.x - b.x, dy = a.y - b.y;
            let d2 = dx * dx + dy * dy || 0.01;
            const f = (2200 * alpha) / d2;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          }
        }
        // springs
        for (const e of edgesRef.current.values()) {
          const a = sim.get(e.source), b = sim.get(e.target);
          if (!a || !b) continue;
          const na = nodesRef.current.get(e.source), nb = nodesRef.current.get(e.target);
          if (!na || !nb || hidden.has(na.type) || hidden.has(nb.type)) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const f = (d - 90) * 0.015 * alpha;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
        // gravity to center + integrate
        for (const n of nodes) {
          const s = sim.get(n.id)!;
          if (s.pinned) { s.vx = 0; s.vy = 0; continue; }
          s.vx -= s.x * 0.004 * alpha;
          s.vy -= s.y * 0.004 * alpha;
          s.vx *= 0.82; s.vy *= 0.82;
          s.x += s.vx; s.y += s.vy;
        }
        alphaRef.current *= 0.992;
        setTick((t) => (t + 1) % 1e9);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [hidden]);

  // ── expand a node ───────────────────────────────────────────────────────────
  const expand = useCallback(async (id: string) => {
    if (expanded.has(id)) return;
    setExpanding(id);
    try {
      const r = await fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId: id }) });
      if (r.ok) {
        const g: Graph = await r.json();
        ingest(g, id);
        setExpanded((s) => new Set(s).add(id));
      }
    } catch { /* ignore */ } finally {
      setExpanding(null);
      setTick((t) => t + 1);
    }
  }, [expanded, ingest]);

  // drop a searched entity onto the canvas, select + expand it, then fit
  const pickResult = useCallback((n: GraphNode) => {
    ingest({ nodes: [n], edges: [] });
    setSelected(n.id);
    setQuery(''); setResults([]);
    expand(n.id);
    setTimeout(() => fitView(), 1400);
  }, [ingest, expand, fitView]);

  // run a seeded quick query (replaces the canvas)
  const runQuick = useCallback(async (key: string) => {
    try {
      const r = await fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quick: key }) });
      if (r.ok) replaceWith(await r.json());
    } catch { /* ignore */ }
  }, [replaceWith]);

  const radius = (n: GraphNode) => {
    const tokenMode = weightBy === 'tokens' && !n.countOnly;
    if (tokenMode) {
      // log scale: a cumulative-token outlier (Codex) must not dwarf the graph
      const base = Math.max(0, Math.log10((n.weight || 0) + 1) - 2) * 4.5;
      return Math.max(6, Math.min(28, 6 + base));
    }
    const v = n.countOnly ? n.weight : (n.count ?? n.weight);
    return Math.max(6, Math.min(28, 6 + Math.sqrt(v) * 1.7));
  };

  // ── pointer: pan background, drag nodes, zoom ───────────────────────────────
  const drag = useRef<{ id: string | null; px: number; py: number; moved: boolean } | null>(null);
  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };
  const onDown = (e: React.PointerEvent, id: string | null) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id, px: e.clientX, py: e.clientY, moved: false };
    if (id) { const s = simRef.current.get(id); if (s) s.pinned = true; }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.px, dy = e.clientY - d.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.id) {
      const w = toWorld(e.clientX, e.clientY);
      const s = simRef.current.get(d.id); if (s) { s.x = w.x; s.y = w.y; s.vx = 0; s.vy = 0; }
      alphaRef.current = Math.max(alphaRef.current, 0.3);
    } else {
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      d.px = e.clientX; d.py = e.clientY;
    }
    setTick((t) => t + 1);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    if (d && d.id && !d.moved) { setSelected(d.id); expand(d.id); }
    if (d && d.id) { const s = simRef.current.get(d.id); if (s && d.moved) s.pinned = true; }
  };
  const onWheel = (e: React.WheelEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const k = Math.max(0.2, Math.min(4, v.k * factor));
      return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
    });
  };

  // ── render data ─────────────────────────────────────────────────────────────
  const sim = simRef.current;
  const visNodes = [...nodesRef.current.values()].filter((n) => !hidden.has(n.type));
  const visIds = new Set(visNodes.map((n) => n.id));
  const visEdges = [...edgesRef.current.values()].filter((e) => visIds.has(e.source) && visIds.has(e.target));
  const maxEdgeW = Math.max(1, ...visEdges.map((e) => e.weight));
  const sel = selected ? nodesRef.current.get(selected) : null;
  const selRels = selected
    ? visEdges.filter((e) => e.source === selected || e.target === selected)
        .map((e) => ({ node: nodesRef.current.get(e.source === selected ? e.target : e.source), rel: e.type }))
        .filter((x) => x.node) as { node: GraphNode; rel: string }[]
    : [];
  const selNeighbors = selRels.map((x) => x.node);

  const counts = TYPE_ORDER.map((t) => ({ t, n: [...nodesRef.current.values()].filter((x) => x.type === t).length })).filter((x) => x.n > 0);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* search + quick queries */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--border-faint)' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 380 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files, prompts, sessions, models…"
            className="f12"
            style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', outline: 'none' }}
          />
          {results.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 60, background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r)', boxShadow: 'var(--shadow-md)', maxHeight: 320, overflowY: 'auto' }}>
              {results.map((n) => (
                <button key={n.id} onClick={() => pickResult(n)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', border: 'none', borderBottom: '1px solid var(--border-faint)', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: TYPE_COLOR[n.type], flexShrink: 0 }} />
                  <span className="f12" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{n.label}</span>
                  <span className="f12 muted">{n.type}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className="f12 muted" style={{ alignSelf: 'center' }}>ask:</span>
          {[['top-files', 'Top files'], ['top-prompts', 'Priciest prompts'], ['top-sessions', 'Biggest sessions']].map(([k, label]) => (
            <button key={k} onClick={() => runQuick(k)} className="f12"
              style={{ padding: '4px 9px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--text)' }}>
              {label}
            </button>
          ))}
          <button onClick={() => replaceWith(initial)} className="f12"
            style={{ padding: '4px 9px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--text-muted)' }}>
            ↺ Overview
          </button>
        </div>
      </div>

      {/* type filters + sizing */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--border-faint)' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {counts.map(({ t, n }) => (
            <button key={t} onClick={() => setHidden((h) => { const s = new Set(h); s.has(t) ? s.delete(t) : s.add(t); return s; })}
              title={`${n} ${t} nodes — click to toggle`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '3px 8px', borderRadius: 20,
                border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer',
                opacity: hidden.has(t) ? 0.4 : 1, textDecoration: hidden.has(t) ? 'line-through' : 'none', color: 'var(--text)',
              }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: TYPE_COLOR[t] }} />
              {t} <span className="muted">{n}</span>
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="f12 muted">size by</span>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {(['tokens', 'count'] as const).map((w) => (
              <button key={w} onClick={() => setWeightBy(w)} className="f12"
                style={{ padding: '3px 9px', cursor: 'pointer', border: 'none', background: weightBy === w ? 'var(--accent-soft)' : 'transparent', color: weightBy === w ? 'var(--accent)' : 'var(--text-muted)', fontWeight: weightBy === w ? 700 : 500 }}>
                {w}
              </button>
            ))}
          </div>
          <button onClick={fitView} className="btn btn-sm" title="Fit graph to view">⤢ Fit</button>
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          width="100%"
          height={620}
          style={{ display: 'block', cursor: drag.current?.id ? 'grabbing' : 'grab', background: 'var(--surface-2)', touchAction: 'none' }}
          onPointerDown={(e) => onDown(e, null)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onWheel={onWheel}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {visEdges.map((e) => {
              const a = sim.get(e.source), b = sim.get(e.target);
              if (!a || !b) return null;
              const hot = selected && (e.source === selected || e.target === selected);
              return (
                <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={hot ? 'var(--accent)' : 'var(--border-strong)'}
                  strokeOpacity={hot ? 0.9 : 0.35}
                  strokeWidth={Math.max(0.5, Math.min(4, (e.weight / maxEdgeW) * 3)) / view.k}>
                  <title>{e.type}</title>
                </line>
              );
            })}
            {visNodes.map((n) => {
              const s = sim.get(n.id); if (!s) return null;
              const r = radius(n);
              const isSel = n.id === selected;
              const dim = selected && !isSel && !selNeighbors.some((x) => x.id === n.id);
              return (
                <g key={n.id} transform={`translate(${s.x},${s.y})`} style={{ cursor: 'pointer' }}
                  onPointerDown={(e) => { e.stopPropagation(); onDown(e, n.id); }}>
                  <circle r={r} fill={TYPE_COLOR[n.type]} fillOpacity={dim ? 0.25 : 0.92}
                    stroke={isSel ? 'var(--accent)' : 'var(--bg)'} strokeWidth={(isSel ? 3 : 1.5) / view.k} />
                  {(r * view.k > 9 || isSel) && (
                    <text y={r + 11 / view.k} textAnchor="middle" fontSize={11 / view.k}
                      fill="var(--text-muted)" fillOpacity={dim ? 0.4 : 1} style={{ pointerEvents: 'none', userSelect: 'none' }}>
                      {n.label}
                    </text>
                  )}
                  {expanding === n.id && <circle r={r + 4 / view.k} fill="none" stroke="var(--accent)" strokeWidth={1.5 / view.k} strokeDasharray="3 3" />}
                </g>
              );
            })}
          </g>
        </svg>

        {/* side panel */}
        {sel && (
          <div style={{
            position: 'absolute', top: 12, right: 12, width: 280, maxHeight: 580, overflowY: 'auto',
            background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)',
            boxShadow: 'var(--shadow-md)', padding: 14,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: TYPE_COLOR[sel.type], flexShrink: 0 }} />
              <span className="f12 muted" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{sel.type}</span>
              <button onClick={() => setSelected(null)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16 }}>×</button>
            </div>
            <div className="fw6" style={{ fontSize: 14, wordBreak: 'break-word', marginBottom: 4 }}>{sel.label}</div>
            <div className="f12 muted" style={{ marginBottom: 4 }}>{fmtWeight(sel)}{sel.sub ? ` · ${sel.sub}` : ''}</div>
            {!sel.countOnly && (sel.tin != null || sel.tout != null || sel.tcache != null) && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '6px 0 2px' }}>
                <span className="f12"><span className="muted">in</span> {fmtK(sel.tin || 0)}</span>
                <span className="f12"><span className="muted">out</span> {fmtK(sel.tout || 0)}</span>
                <span className="f12" title="Cache-read tokens repeat every turn — excluded from node size, shown for context.">
                  <span className="muted">cache-read</span> {fmtK(sel.tcache || 0)}
                </span>
              </div>
            )}
            {stats && (
              <div className="f12" style={{ marginTop: 6, padding: '6px 8px', background: 'var(--surface-2)', borderRadius: 6, lineHeight: 1.5 }}>{stats}</div>
            )}
            {sel.type === 'session' && (
              <Link href={`/sessions/${sel.id.slice('session:'.length)}`} className="lnk f12" style={{ display: 'inline-block', marginTop: 6 }}>Open session ›</Link>
            )}
            {sel.type === 'file' && sel.countOnly && (
              <div className="f12" style={{ color: 'var(--text-subtle)', marginTop: 6, lineHeight: 1.5 }}>
                File weight is interaction count (edits + reads). Tokens are measured per session/model, not per file.
              </div>
            )}
            <div className="f12 muted" style={{ margin: '12px 0 6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {selNeighbors.length} connected
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {selRels.slice(0, 30).map(({ node: nb, rel }, i) => (
                <button key={nb.id + i} onClick={() => { setSelected(nb.id); expand(nb.id); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px', borderRadius: 6, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: TYPE_COLOR[nb.type], flexShrink: 0 }} />
                  <span className="f12" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{nb.label}</span>
                  <span className="f12" style={{ color: 'var(--text-subtle)', flexShrink: 0, fontStyle: 'italic' }}>{rel}</span>
                </button>
              ))}
            </div>
            {!expanded.has(sel.id) && (
              <button onClick={() => expand(sel.id)} className="btn btn-sm" style={{ marginTop: 10, width: '100%' }}>
                {expanding === sel.id ? 'Expanding…' : 'Expand neighbours'}
              </button>
            )}
          </div>
        )}

        <div className="f12 muted" style={{ position: 'absolute', left: 12, bottom: 10, pointerEvents: 'none' }}>
          {visNodes.length} nodes · {visEdges.length} edges — drag to pan · scroll to zoom · click a node to expand
        </div>
      </div>
    </div>
  );
}
