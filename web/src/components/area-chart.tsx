'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';

export interface AreaSeries {
  key: string;
  color: string;
  data: number[];
}

export function AreaChart({ series, labels, height = 180, stacked = true, hrefTemplate, xLabel = 'week starting' }: {
  series: AreaSeries[];
  labels: string[];
  height?: number;
  stacked?: boolean;
  hrefTemplate?: string;
  xLabel?: string;
}) {
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const router = useRouter();

  if (series.length === 0 || labels.length === 0) return null;

  const padL = 40;
  const padR = 24;
  const padT = 12;
  const padB = 30;
  const w = 600;
  const plotW = w - padL - padR;
  const plotH = height - padT - padB;

  const n = labels.length;
  const cumulative: number[][] = Array.from({ length: n }, () => []);

  if (stacked) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let s = 0; s < series.length; s++) {
        sum += series[s].data[i] || 0;
        cumulative[i][s] = sum;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < series.length; s++) {
        cumulative[i][s] = series[s].data[i] || 0;
      }
    }
  }

  const maxVal = Math.max(...cumulative.map(c => c[c.length - 1] || 0), 1);

  function x(i: number) { return padL + (i / Math.max(n - 1, 1)) * plotW; }
  function y(val: number) { return padT + plotH - (val / maxVal) * plotH; }

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(pct => ({
    val: Math.round(maxVal * pct),
    yPos: y(maxVal * pct),
  }));

  // Thin x-axis ticks: with many weekly buckets every label collides into an
  // illegible smear, so show ~8 evenly-spaced labels (always the first + last).
  const MAX_TICKS = 8;
  const stride = Math.max(1, Math.ceil(n / MAX_TICKS));
  const ticks: number[] = [];
  for (let i = 0; i < n; i += stride) ticks.push(i);
  const lastTick = ticks[ticks.length - 1];
  if (lastTick !== n - 1) {
    // Replace a too-close final tick with the last index, else append it.
    if (n - 1 - lastTick < stride * 0.5) ticks[ticks.length - 1] = n - 1;
    else ticks.push(n - 1);
  }
  const tickSet = new Set(ticks);

  const paths = series.map((s, si) => {
    const topPoints = labels.map((_, i) => `${x(i)},${y(cumulative[i][si])}`);
    const botPoints = labels.map((_, i) => {
      const below = si > 0 ? cumulative[i][si - 1] : 0;
      return `${x(i)},${y(below)}`;
    }).reverse();
    return { key: s.key, color: s.color, d: `M${topPoints.join(' L')} L${botPoints.join(' L')} Z` };
  });

  function fmtVal(v: number): string {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
  }

  function handleHover(i: number, e: React.MouseEvent) {
    setHoveredCol(i);
    const svg = svgRef.current;
    if (svg) {
      const rect = svg.getBoundingClientRect();
      setTipPos({ x: e.clientX - rect.left, y: 8 });
    }
  }

  function handleClick(i: number) {
    const href = hrefTemplate?.replace('{label}', labels[i]);
    if (href) router.push(href);
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
        {gridLines.map(g => (
          <g key={g.val}>
            <line x1={padL} x2={w - padR} y1={g.yPos} y2={g.yPos} stroke="var(--grid)" strokeWidth={1} />
            <text x={padL - 6} y={g.yPos + 4} textAnchor="end" fontSize={10} fill="var(--text-subtle)" fontFamily="var(--mono)">{fmtVal(g.val)}</text>
          </g>
        ))}
        {/* Vertical guides only at labelled ticks (one per drawn label). */}
        {ticks.map((i) => (
          <line key={`vg-${i}`} x1={x(i)} x2={x(i)} y1={padT} y2={padT + plotH} stroke="var(--grid)" strokeWidth={1} opacity={0.5} />
        ))}
        {paths.map(p => (
          <path key={p.key} d={p.d} fill={p.color} opacity={0.25} />
        ))}
        {series.map((s, si) => {
          const line = labels.map((_, i) => `${x(i)},${y(cumulative[i][si])}`);
          return <polyline key={s.key + '-line'} points={line.join(' ')} fill="none" stroke={s.color} strokeWidth={1.5} />;
        })}
        {labels.map((label, i) => (
          tickSet.has(i) ? (
            <text
              key={`label-${i}`}
              x={x(i)}
              y={height - 14}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontSize={10}
              fill="var(--text-muted)"
              fontFamily="var(--mono)"
            >{label}</text>
          ) : null
        ))}
        <text x={padL + plotW / 2} y={height - 3} textAnchor="middle" fontSize={9} fill="var(--text-subtle)">{xLabel}</text>
        {labels.map((_, i) => {
          const colW = plotW / n;
          return (
            <rect
              key={`hover-${i}`}
              x={x(i) - colW / 2}
              y={padT}
              width={colW}
              height={plotH}
              fill={hoveredCol === i ? 'var(--accent)' : 'transparent'}
              opacity={0.06}
              onMouseEnter={(e) => handleHover(i, e)}
              onMouseLeave={() => { setHoveredCol(null); setTipPos(null); }}
              onClick={() => handleClick(i)}
              style={{ cursor: hrefTemplate ? 'pointer' : 'default' }}
            />
          );
        })}
        {hoveredCol !== null && (
          <line x1={x(hoveredCol)} x2={x(hoveredCol)} y1={padT} y2={padT + plotH} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 2" />
        )}
      </svg>
      {hoveredCol !== null && tipPos && (
        <div className="chart-tip" style={{ left: tipPos.x, top: tipPos.y, transform: 'translateX(-50%)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{labels[hoveredCol]}</div>
          {series.map((s, si) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
              <span>{s.key}: {fmtVal(stacked ? (series[si].data[hoveredCol!] || 0) : cumulative[hoveredCol!][si])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
