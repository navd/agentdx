'use client';

import { useRouter } from 'next/navigation';
import { useState, useRef } from 'react';

export interface HeatmapDay {
  date: string;
  value: number;
}

export function HeatmapGrid({ data, weeks = 26, cellSize = 12 }: {
  data: HeatmapDay[];
  weeks?: number;
  cellSize?: number;
}) {
  const [hovered, setHovered] = useState<{ day: HeatmapDay; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const router = useRouter();

  const gap = 2;
  const labelW = 24;
  const labelH = 16;
  const totalW = labelW + weeks * (cellSize + gap);
  const totalH = labelH + 7 * (cellSize + gap);

  const valueMap = new Map(data.map(d => [d.date, d.value]));
  const maxVal = Math.max(...data.map(d => d.value), 1);

  // Iterate in UTC so cell keys match the SQL date(started_at/1000,'unixepoch')
  // buckets exactly. Anchoring on local time would drift the key by a day near
  // midnight and misplace sessions (and miscount the cell tooltip).
  const DAY = 86400000;
  const now = Date.now();
  const todayUtcMs = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  let curMs = todayUtcMs - (weeks * 7 - 1) * DAY;
  curMs -= new Date(curMs).getUTCDay() * DAY; // back up to the week's Sunday (UTC)

  const cells: { date: string; col: number; row: number; value: number }[] = [];
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const iso = new Date(curMs).toISOString().split('T')[0];
      if (curMs <= now) {
        cells.push({ date: iso, col, row, value: valueMap.get(iso) || 0 });
      }
      curMs += DAY;
    }
  }

  function intensity(v: number): string {
    if (v === 0) return 'var(--surface-3)';
    const pct = v / maxVal;
    if (pct < 0.25) return 'var(--accent-soft-2)';
    if (pct < 0.5) return 'color-mix(in srgb, var(--accent) 40%, var(--surface-3))';
    if (pct < 0.75) return 'color-mix(in srgb, var(--accent) 65%, var(--surface-3))';
    return 'var(--accent)';
  }

  const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

  const months: { label: string; col: number }[] = [];
  let lastMonth = '';
  for (const cell of cells) {
    if (cell.row === 0) {
      const m = cell.date.slice(0, 7);
      if (m !== lastMonth) {
        const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        months.push({ label: names[parseInt(cell.date.slice(5, 7)) - 1], col: cell.col });
        lastMonth = m;
      }
    }
  }

  function handleMouseEnter(cell: typeof cells[0], e: React.MouseEvent) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setHovered({
      day: { date: cell.date, value: cell.value },
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }

  return (
    <div style={{ position: 'relative', overflowX: 'auto' }}>
      <svg ref={svgRef} width={totalW} height={totalH} style={{ display: 'block' }}>
        {months.map(m => (
          <text key={m.col} x={labelW + m.col * (cellSize + gap)} y={11} fontSize={10} fill="var(--text-subtle)">{m.label}</text>
        ))}
        {dayLabels.map((label, i) => (
          label ? <text key={i} x={0} y={labelH + i * (cellSize + gap) + cellSize - 2} fontSize={9} fill="var(--text-subtle)">{label}</text> : null
        ))}
        {cells.map(cell => (
          <rect
            key={cell.date}
            x={labelW + cell.col * (cellSize + gap)}
            y={labelH + cell.row * (cellSize + gap)}
            width={cellSize}
            height={cellSize}
            rx={2}
            fill={intensity(cell.value)}
            style={{ cursor: 'pointer', transition: 'stroke 0.1s' }}
            stroke={hovered?.day.date === cell.date ? 'var(--accent)' : 'none'}
            strokeWidth={1.5}
            onMouseEnter={(e) => handleMouseEnter(cell, e)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => router.push(`/sessions?date=${cell.date}`)}
          />
        ))}
      </svg>
      {hovered && (
        <div className="chart-tip" style={{ left: hovered.x, top: hovered.y - 36, transform: 'translateX(-50%)' }}>
          {hovered.day.value} session{hovered.day.value !== 1 ? 's' : ''} on {hovered.day.date}
        </div>
      )}
    </div>
  );
}
