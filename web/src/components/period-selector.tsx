'use client';

import { useRouter, useSearchParams } from 'next/navigation';

const PERIODS = [
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'qtd', label: 'QTD' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: 'All' },
];

export function PeriodSelector({ defaultPeriod = 'all' }: { defaultPeriod?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const current = params.get('period') || defaultPeriod;

  return (
    <div className="segmented">
      {PERIODS.map(p => (
        <button
          key={p.key}
          className={current === p.key ? 'on' : ''}
          onClick={() => {
            const sp = new URLSearchParams(params.toString());
            sp.set('period', p.key);
            router.push(`?${sp.toString()}`);
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
