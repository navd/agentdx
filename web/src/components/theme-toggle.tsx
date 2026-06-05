'use client';

import { useEffect, useState } from 'react';

type Pref = 'system' | 'light' | 'dark';

export default function ThemeToggle() {
  const [pref, setPref] = useState<Pref>('system');

  useEffect(() => {
    const stored = localStorage.getItem('adx-theme') as Pref | null;
    if (stored) setPref(stored);
    applyTheme(stored || 'system');
  }, []);

  function applyTheme(p: Pref) {
    localStorage.setItem('adx-theme', p);
    const isDark = p === 'dark' || (p === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    setPref(p);
  }

  return (
    <div className="segmented theme-seg">
      <button className={pref === 'system' ? 'on' : ''} onClick={() => applyTheme('system')} title="System">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
      </button>
      <button className={pref === 'light' ? 'on' : ''} onClick={() => applyTheme('light')} title="Light">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
      <button className={pref === 'dark' ? 'on' : ''} onClick={() => applyTheme('dark')} title="Dark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      </button>
    </div>
  );
}
