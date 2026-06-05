export function Sparkline({ data, width = 80, height = 28, color = 'var(--accent)', responsive = false }: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  // When true the svg stretches to its container's width (the viewBox + a
  // non-scaling stroke keep the line crisp), so the trend fills the card
  // instead of sitting as a tiny stub at the bottom.
  responsive?: boolean;
}) {
  if (data.length < 2) return null;

  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pad = 3;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return `${x},${y}`;
  });

  const areaPoints = [`${pad},${height - pad}`, ...points, `${width - pad},${height - pad}`];
  const [lastX, lastY] = points[points.length - 1].split(',');
  const gid = `spark-${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <svg
      width={responsive ? '100%' : width}
      height={responsive ? undefined : height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={responsive ? 'none' : 'xMidYMid meet'}
      style={{ display: 'block', width: responsive ? '100%' : undefined, height: responsive ? '100%' : undefined }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <polygon points={areaPoints.join(' ')} fill={`url(#${gid})`} />
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect={responsive ? 'non-scaling-stroke' : undefined} />
      <circle cx={lastX} cy={lastY} r={2.5} fill={color} vectorEffect={responsive ? 'non-scaling-stroke' : undefined} />
    </svg>
  );
}
