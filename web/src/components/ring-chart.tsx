'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface RingSegment {
  key: string;
  value: number;
  color: string;
  label: string;
  href?: string;
}

function fmtValue(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
}

export function RingChart({ segments, size = 220, strokeWidth = 32, centerLabel, centerValue, showLegend = false }: {
  segments: RingSegment[];
  size?: number;
  strokeWidth?: number;
  centerLabel?: string;
  centerValue?: string;
  showLegend?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const router = useRouter();

  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return null;

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;

  let accumulated = 0;
  const arcs = segments.filter(s => s.value > 0).map((seg, i) => {
    const pct = seg.value / total;
    const dashLen = pct * circumference;
    const dashOffset = -accumulated * circumference;
    accumulated += pct;
    return { ...seg, dashLen, dashOffset, index: i, pct };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', overflow: 'visible' }}>
          {arcs.map((arc) => (
            <circle
              key={arc.key}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={hovered === arc.index ? strokeWidth + 4 : strokeWidth}
              strokeDasharray={`${arc.dashLen} ${circumference - arc.dashLen}`}
              strokeDashoffset={arc.dashOffset}
              style={{ cursor: arc.href ? 'pointer' : 'default', transition: `opacity var(--dur, 0.18s), stroke-width var(--dur, 0.18s)` }}
              opacity={hovered !== null && hovered !== arc.index ? 0.35 : 1}
              onMouseEnter={() => setHovered(arc.index)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => arc.href && router.push(arc.href)}
            />
          ))}
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
        }}>
          {hovered !== null ? (
            <>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{arcs[hovered].label}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>
                {(arcs[hovered].pct * 100).toFixed(1)}%
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-subtle)', marginTop: 2 }}>{fmtValue(arcs[hovered].value)}</span>
            </>
          ) : (
            <>
              {centerValue && <span style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{centerValue}</span>}
              {centerLabel && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{centerLabel}</span>}
            </>
          )}
        </div>
      </div>
      {showLegend && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', justifyContent: 'center' }}>
          {arcs.slice(0, 6).map(arc => (
            <span key={arc.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: arc.href ? 'pointer' : 'default' }}
              onClick={() => arc.href && router.push(arc.href)}
              onMouseEnter={() => setHovered(arc.index)}
              onMouseLeave={() => setHovered(null)}
            >
              <span style={{ width: 8, height: 8, borderRadius: 2, background: arc.color, flexShrink: 0 }} />
              {arc.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
