'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

type Tone = 'accent' | 'pos' | 'warn' | 'neg' | 'info' | 'neutral';

export interface FlowNode {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  href?: string;
  tone?: Tone;
  icon?: ReactNode;
}

const toneColor: Record<Tone, string> = {
  accent: 'var(--accent)',
  pos: 'var(--pos)',
  warn: 'var(--warn)',
  neg: 'var(--neg)',
  info: 'var(--info)',
  neutral: 'var(--text-muted)',
};

export function SignalFlow({ nodes }: { nodes: FlowNode[] }) {
  if (nodes.length === 0) return null;

  return (
    <div className="signal-flow">
      {nodes.map((node, i) => {
        const tone = node.tone || 'accent';
        const color = toneColor[tone];
        const content = (
          <>
            <span className="flow-pulse" style={{ background: color }} />
            {node.icon && <span className="flow-icon" style={{ color }}>{node.icon}</span>}
            <span className="flow-label">{node.label}</span>
            <strong>{node.value}</strong>
            {node.detail && <small className="flow-detail">{node.detail}</small>}
          </>
        );

        return (
          <div className="flow-step" key={`${node.label}-${i}`}>
            {node.href ? (
              <Link className="flow-node" href={node.href} style={{ '--flow-tone': color } as any}>
                {content}
              </Link>
            ) : (
              <div className="flow-node" style={{ '--flow-tone': color } as any}>
                {content}
              </div>
            )}
            {i < nodes.length - 1 && <span className="flow-edge" />}
          </div>
        );
      })}
    </div>
  );
}
