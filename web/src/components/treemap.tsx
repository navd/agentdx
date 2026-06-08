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

  const sorted = [...items].filter((it) => it.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length === 0) return [];
  const rects: Rect[] = [];

  let remaining = [...sorted];
  // Sum of the items not yet laid out. Every row's main dimension is its share
  // of THIS — not the original total — so each row fully fills the shrinking
  // sub-rectangle and no dead space is left at the end.
  let remTotal = remaining.reduce((s, it) => s + it.value, 0);
  let rx = x, ry = y, rw = w, rh = h;

  // worst aspect ratio if `rowTotal` fills the short side of the current rect.
  const worst = (rowTotal: number, maxItem: number, minItem: number, sideLen: number, rectArea: number) => {
    const rowArea = (rowTotal / remTotal) * rectArea;
    const maxArea = (maxItem / remTotal) * rectArea;
    const minArea = (minItem / remTotal) * rectArea;
    const s2 = sideLen * sideLen;
    return Math.max((s2 * maxArea) / (rowArea * rowArea), (rowArea * rowArea) / (s2 * minArea));
  };

  while (remaining.length > 0) {
    const sideLen = Math.min(rw, rh);
    const rectArea = rw * rh;
    const row: TreemapItem[] = [remaining[0]];
    let rowTotal = remaining[0].value;
    let rowMax = remaining[0].value, rowMin = remaining[0].value;
    let i = 1;
    while (i < remaining.length) {
      const next = remaining[i];
      const nMax = Math.max(rowMax, next.value), nMin = Math.min(rowMin, next.value);
      if (worst(rowTotal + next.value, nMax, nMin, sideLen, rectArea) > worst(rowTotal, rowMax, rowMin, sideLen, rectArea)) break;
      row.push(next); rowTotal += next.value; rowMax = nMax; rowMin = nMin; i++;
    }
    remaining = remaining.slice(row.length);

    // Lay the row along the short side; main dimension = row's share of what's left.
    const isHoriz = rw >= rh;
    const mainSize = (rowTotal / remTotal) * (isHoriz ? rw : rh);
    let offset = 0;
    for (const item of row) {
      const crossSize = (item.value / rowTotal) * (isHoriz ? rh : rw);
      if (isHoriz) rects.push({ x: rx, y: ry + offset, w: mainSize, h: crossSize, item });
      else rects.push({ x: rx + offset, y: ry, w: crossSize, h: mainSize, item });
      offset += crossSize;
    }
    if (isHoriz) { rx += mainSize; rw -= mainSize; }
    else { ry += mainSize; rh -= mainSize; }
    remTotal -= rowTotal;
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
