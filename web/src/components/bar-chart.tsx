'use client';

import type { BarData } from '@/lib/chart-data';

export type { BarData };

export function BarChart({ data, height = 180 }: { data: BarData[]; height?: number }) {
  if (data.length === 0) return null;

  const maxTotal = Math.max(...data.map(d => d.segments.reduce((s, seg) => s + seg.value, 0)), 1);

  const agents = Array.from(new Set(data.flatMap(d => d.segments.map(s => s.key))));
  // Legend colors MUST come from the same segments the bars are drawn from —
  // a separate color map here silently mislabels bars (e.g. cursor's bar shown
  // under the vscode legend key).
  const colorByKey = new Map(data.flatMap(d => d.segments.map(s => [s.key, s.color] as const)));

  const barZone = height - 40;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height, padding: '0 4px' }}>
        {data.map((d, i) => {
          const total = d.segments.reduce((s, seg) => s + seg.value, 0);
          const barH = Math.round((total / maxTotal) * barZone);
          return (
            <div key={i} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              <span className="f12 mono muted">{total}</span>
              <div style={{ width: '80%', maxWidth: 48, height: barH, minHeight: total > 0 ? 4 : 0, borderRadius: '3px 3px 0 0', overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse' }}>
                {d.segments.map((seg, j) => {
                  const segPct = total > 0 ? (seg.value / total) * 100 : 0;
                  return (
                    <div
                      key={j}
                      style={{ width: '100%', height: `${segPct}%`, background: seg.color, minHeight: seg.value > 0 ? 2 : 0 }}
                    />
                  );
                })}
              </div>
              <span className="f12 muted" style={{ whiteSpace: 'nowrap' }}>{d.label}</span>
            </div>
          );
        })}
      </div>
      {agents.length > 1 && (
        <div className="row gap-16 mt-8" style={{ justifyContent: 'center' }}>
          {agents.map(a => (
            <span key={a} className="row gap-6 f12">
              <span style={{ width: 10, height: 10, borderRadius: 2, background: colorByKey.get(a) || 'var(--text-subtle)' }} />
              <span className="muted">{a}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
