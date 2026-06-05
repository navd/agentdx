'use client';

import Link from 'next/link';
import { useState } from 'react';

export interface TreemapItem {
  key: string;
  value: number;
  label: string;
  subLabel?: string;
  color: string;
  href: string;
}

interface Rect { x: number; y: number; w: number; h: number; item: TreemapItem }

function squarify(items: TreemapItem[], x: number, y: number, w: number, h: number): Rect[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ x, y, w, h, item: items[0] }];

  const total = items.reduce((s, it) => s + it.value, 0);
  if (total === 0) return [];

  const sorted = [...items].sort((a, b) => b.value - a.value);
  const rects: Rect[] = [];

  function layoutRow(row: TreemapItem[], rowTotal: number, rx: number, ry: number, rw: number, rh: number) {
    const isHoriz = rw >= rh;
    const mainSize = isHoriz ? (rowTotal / total) * rw : (rowTotal / total) * rh;

    let offset = 0;
    for (const item of row) {
      const ratio = item.value / rowTotal;
      const crossSize = isHoriz ? rh * ratio : rw * ratio;
      if (isHoriz) {
        rects.push({ x: rx, y: ry + offset, w: mainSize, h: crossSize, item });
      } else {
        rects.push({ x: rx + offset, y: ry, w: crossSize, h: mainSize, item });
      }
      offset += crossSize;
    }

    if (isHoriz) return { x: rx + mainSize, y: ry, w: rw - mainSize, h: rh };
    return { x: rx, y: ry + mainSize, w: rw, h: rh - mainSize };
  }

  function worstRatio(row: TreemapItem[], rowTotal: number, sideLen: number): number {
    const area = (rowTotal / total) * w * h;
    let worst = 0;
    for (const item of row) {
      const itemArea = (item.value / total) * w * h;
      const rowLen = area / sideLen;
      const itemLen = itemArea / rowLen;
      const ratio = Math.max(rowLen / itemLen, itemLen / rowLen);
      worst = Math.max(worst, ratio);
    }
    return worst;
  }

  let remaining = [...sorted];
  let rx = x, ry = y, rw = w, rh = h;

  while (remaining.length > 0) {
    const sideLen = Math.min(rw, rh);
    const row: TreemapItem[] = [remaining[0]];
    let rowTotal = remaining[0].value;
    remaining = remaining.slice(1);

    let currentWorst = worstRatio(row, rowTotal, sideLen);

    while (remaining.length > 0) {
      const next = remaining[0];
      const newRow = [...row, next];
      const newTotal = rowTotal + next.value;
      const newWorst = worstRatio(newRow, newTotal, sideLen);

      if (newWorst <= currentWorst) {
        row.push(next);
        rowTotal = newTotal;
        currentWorst = newWorst;
        remaining = remaining.slice(1);
      } else {
        break;
      }
    }

    const rem = layoutRow(row, rowTotal, rx, ry, rw, rh);
    rx = rem.x; ry = rem.y; rw = rem.w; rh = rem.h;
  }

  return rects;
}

export function Treemap({ items, width = 600, height = 280 }: {
  items: TreemapItem[];
  width?: number;
  height?: number;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const filtered = items.filter(it => it.value > 0);
  if (filtered.length === 0) return null;

  const rects = squarify(filtered, 0, 0, width, height);

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: `${width}/${height}` }}>
      {rects.map(r => {
        const pctX = (r.x / width) * 100;
        const pctY = (r.y / height) * 100;
        const pctW = (r.w / width) * 100;
        const pctH = (r.h / height) * 100;
        const isSmall = pctW < 8 || pctH < 12;

        return (
          <Link
            key={r.item.key}
            href={r.item.href}
            className="treemap-cell"
            style={{
              left: `${pctX}%`, top: `${pctY}%`, width: `${pctW}%`, height: `${pctH}%`,
              background: r.item.color,
              opacity: hovered && hovered !== r.item.key ? 0.6 : 1,
            }}
            onMouseEnter={() => setHovered(r.item.key)}
            onMouseLeave={() => setHovered(null)}
          >
            {!isSmall && (
              <>
                <span className="tm-label">{r.item.label}</span>
                {r.item.subLabel && <span className="tm-value">{r.item.subLabel}</span>}
              </>
            )}
          </Link>
        );
      })}
    </div>
  );
}
