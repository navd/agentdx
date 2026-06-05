'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';

export interface ScatterPoint {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  href: string;
}

export function ScatterPlot({ points, xLabel, yLabel, width = 600, height = 240, logX = false }: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  width?: number;
  height?: number;
  /** Log-scale the X axis — use when X spans several orders of magnitude. */
  logX?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const router = useRouter();

  if (points.length === 0) return null;

  const padL = 50;
  const padR = 20;
  const padT = 16;
  const padB = 36;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxX = Math.max(...points.map(p => p.x), 1);
  const maxY = Math.max(...points.map(p => p.y), 1);
  const maxSize = Math.max(...points.map(p => p.size), 1);

  const logMax = Math.log10(maxX + 1);
  function px(val: number) {
    if (logX) return padL + (Math.log10(Math.max(0, val) + 1) / logMax) * plotW;
    return padL + (val / maxX) * plotW;
  }
  function py(val: number) { return padT + plotH - (val / maxY) * plotH; }
  function pr(val: number) { return 3 + (val / maxSize) * 9; }

  function fmtNum(v: number): string {
    if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return String(Math.round(v));
  }

  function fmtMs(ms: number): string {
    if (ms <= 0) return '0';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm > 0 ? `${h}h${rm}m` : `${h}h`;
  }

  const isDuration = xLabel.toLowerCase().includes('duration');
  const fmtX = isDuration ? fmtMs : fmtNum;
  const fmtY = fmtNum;

  // Log axis: ticks at powers of ten that fall within range. Linear: quartiles.
  const xTicks = logX
    ? [10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9].filter(v => v <= maxX * 1.2)
    : [...new Set([0, 0.25, 0.5, 0.75, 1].map(p => Math.round(maxX * p)))];
  const yTicks = [...new Set([0, 0.25, 0.5, 0.75, 1].map(p => Math.round(maxY * p)))];

  function handleHover(i: number, e: React.MouseEvent) {
    setHovered(i);
    const svg = svgRef.current;
    if (svg) {
      const rect = svg.getBoundingClientRect();
      setTipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top - 40 });
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
        {yTicks.map(v => (
          <g key={`y-${v}`}>
            <line x1={padL} x2={width - padR} y1={py(v)} y2={py(v)} stroke="var(--grid)" strokeWidth={1} />
            <text x={padL - 8} y={py(v) + 4} textAnchor="end" fontSize={9} fill="var(--text-subtle)" fontFamily="var(--mono)">{fmtY(v)}</text>
          </g>
        ))}
        {xTicks.map(v => (
          <text key={`x-${v}`} x={px(v)} y={height - 8} textAnchor="middle" fontSize={9} fill="var(--text-subtle)" fontFamily="var(--mono)">{fmtX(v)}</text>
        ))}
        <text x={width / 2} y={height - 2} textAnchor="middle" fontSize={10} fill="var(--text-muted)">{xLabel}</text>
        <text x={12} y={padT + plotH / 2} textAnchor="middle" fontSize={10} fill="var(--text-muted)" transform={`rotate(-90, 12, ${padT + plotH / 2})`}>{yLabel}</text>
        {points.map((p, i) => (
          <circle
            key={i}
            cx={px(p.x)}
            cy={py(p.y)}
            r={pr(p.size)}
            fill={p.color}
            opacity={hovered !== null && hovered !== i ? 0.3 : 0.7}
            style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
            onMouseEnter={(e) => handleHover(i, e)}
            onMouseLeave={() => { setHovered(null); setTipPos(null); }}
            onClick={() => router.push(p.href)}
          />
        ))}
      </svg>
      {hovered !== null && tipPos && (
        <div className="chart-tip" style={{ left: tipPos.x, top: tipPos.y, transform: 'translateX(-50%)' }}>
          <div style={{ fontWeight: 600 }}>{points[hovered].label}</div>
          <div className="f12 muted">{xLabel}: {fmtX(points[hovered].x)} · {yLabel}: {fmtY(points[hovered].y)}</div>
        </div>
      )}
    </div>
  );
}
