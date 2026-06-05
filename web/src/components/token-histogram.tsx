'use client';

import { useState } from 'react';

export interface HistoBucket {
  label: string;
  clean: number;
  errors: number;
}

/**
 * Session-size histogram: one bar per token-magnitude bucket, height = session
 * count, stacked clean (green) vs has-errors (amber). Replaces the linear-Y
 * scatter where ~all sessions smeared along y=0.
 */
export function TokenHistogram({ buckets }: { buckets: HistoBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const w = 680;
  const h = 260;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const totals = buckets.map((b) => b.clean + b.errors);
  const maxCount = Math.max(...totals, 1);
  const n = buckets.length;
  const slot = plotW / n;
  const barW = Math.min(54, slot * 0.62);

  // "Nice" y ticks
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((maxCount * i) / tickCount));
  const uniqTicks = [...new Set(yTicks)];

  function yPos(v: number) { return padT + plotH - (v / maxCount) * plotH; }

  return (
    <div style={{ position: 'relative' }}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
        {/* grid + y labels */}
        {uniqTicks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={w - padR} y1={yPos(v)} y2={yPos(v)} stroke="var(--grid)" strokeWidth={1} />
            <text x={padL - 8} y={yPos(v) + 4} textAnchor="end" fontSize={10} fill="var(--text-subtle)" fontFamily="var(--mono)">{v}</text>
          </g>
        ))}

        {buckets.map((b, i) => {
          const cx = padL + slot * i + slot / 2;
          const x = cx - barW / 2;
          const total = b.clean + b.errors;
          const cleanH = (b.clean / maxCount) * plotH;
          const errH = (b.errors / maxCount) * plotH;
          const isHover = hover === i;
          return (
            <g
              key={b.label}
              onMouseEnter={(e) => { setHover(i); const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top - 12 }); }}
              onMouseMove={(e) => { const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top - 12 }); }}
              onMouseLeave={() => { setHover(null); setTip(null); }}
              style={{ cursor: 'default' }}
            >
              {/* invisible full-height hit area */}
              <rect x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent" />
              {/* clean (bottom) */}
              {b.clean > 0 && (
                <rect x={x} y={padT + plotH - cleanH} width={barW} height={cleanH} rx={2} fill="var(--accent)" opacity={isHover ? 1 : 0.85} />
              )}
              {/* errors (top) */}
              {b.errors > 0 && (
                <rect x={x} y={padT + plotH - cleanH - errH} width={barW} height={errH} rx={2} fill="var(--warn)" opacity={isHover ? 1 : 0.85} />
              )}
              {/* count above bar */}
              {total > 0 && (
                <text x={cx} y={padT + plotH - cleanH - errH - 5} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--text-muted)" fontFamily="var(--mono)">{total}</text>
              )}
              {/* x label */}
              <text x={cx} y={h - 20} textAnchor="middle" fontSize={10} fill="var(--text-muted)" fontFamily="var(--mono)">{b.label}</text>
            </g>
          );
        })}
        <text x={padL + plotW / 2} y={h - 4} textAnchor="middle" fontSize={10} fill="var(--text-subtle)">tokens per session</text>
      </svg>

      {hover !== null && tip && (
        <div className="chart-tip" style={{ left: tip.x, top: tip.y, transform: 'translateX(-50%)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{buckets[hover].label} tokens</div>
          <div className="f12">{buckets[hover].clean + buckets[hover].errors} sessions</div>
          <div className="f12 muted">{buckets[hover].clean} clean · {buckets[hover].errors} with errors</div>
        </div>
      )}
    </div>
  );
}
