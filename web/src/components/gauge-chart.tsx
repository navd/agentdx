'use client';

export function GaugeChart({ value, label, size = 160 }: {
  value: number;
  label: string;
  size?: number;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const strokeWidth = size * 0.1;
  const radius = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;

  // Semicircle: half the circumference
  const halfCirc = Math.PI * radius;
  const valueDash = (clamped / 100) * halfCirc;

  const color = clamped < 30 ? 'var(--pos)' : clamped < 60 ? 'var(--warn)' : 'var(--neg)';

  return (
    <div style={{ width: size, height: size * 0.55, position: 'relative', overflow: 'hidden' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
        {/* Background semicircle (top half) */}
        <circle
          cx={cx} cy={cy} r={radius}
          fill="none" stroke="var(--surface-3)" strokeWidth={strokeWidth}
          strokeDasharray={`${halfCirc} ${halfCirc * 2}`}
          strokeLinecap="round"
          transform={`rotate(180, ${cx}, ${cy})`}
        />
        {/* Value arc */}
        <circle
          cx={cx} cy={cy} r={radius}
          fill="none" stroke={color} strokeWidth={strokeWidth}
          strokeDasharray={`${valueDash} ${halfCirc * 2}`}
          strokeLinecap="round"
          transform={`rotate(180, ${cx}, ${cy})`}
        />
      </svg>
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: size * 0.16, fontWeight: 700, color }}>{clamped.toFixed(0)}%</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
      </div>
    </div>
  );
}
