'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

type Tone = 'accent' | 'pos' | 'warn' | 'neg' | 'info' | 'neutral';

export interface DrillTile {
  label: string;
  value: ReactNode;
  detail?: string;
  href: string;
  icon?: ReactNode;
  tone?: Tone;
}

const toneColor: Record<Tone, string> = {
  accent: 'var(--accent)',
  pos: 'var(--pos)',
  warn: 'var(--warn)',
  neg: 'var(--neg)',
  info: 'var(--info)',
  neutral: 'var(--text-muted)',
};

export function DrilldownTiles({ tiles }: { tiles: DrillTile[] }) {
  return (
    <div className="drill-grid">
      {tiles.map((tile) => {
        const color = toneColor[tile.tone || 'accent'];
        return (
          <Link className="drill-tile" href={tile.href} key={tile.label} style={{ '--drill-tone': color } as any}>
            {tile.icon && <span className="drill-icon" style={{ color }}>{tile.icon}</span>}
            <span className="drill-copy">
              <span className="drill-label">{tile.label}</span>
              <strong>{tile.value}</strong>
              {tile.detail && <small>{tile.detail}</small>}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
