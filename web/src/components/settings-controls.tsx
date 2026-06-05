'use client';

import { useState, useCallback } from 'react';
import { Check } from 'lucide-react';

type Saving = 'idle' | 'saving' | 'saved' | 'error';

async function persist(patch: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Transient "Saved ✓" indicator shared by all controls. */
function SaveDot({ state }: { state: Saving }) {
  if (state === 'saving') return <span className="f12 muted">Saving…</span>;
  if (state === 'saved')
    return (
      <span className="f12" style={{ color: 'var(--pos)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <Check size={12} /> Saved
      </span>
    );
  if (state === 'error') return <span className="f12" style={{ color: 'var(--neg)' }}>Failed</span>;
  return null;
}

function useSaver() {
  const [state, setState] = useState<Saving>('idle');
  const save = useCallback(async (patch: Record<string, unknown>) => {
    setState('saving');
    const ok = await persist(patch);
    setState(ok ? 'saved' : 'error');
    if (ok) setTimeout(() => setState('idle'), 1800);
  }, []);
  return { state, save };
}

const seg: React.CSSProperties = { display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' };
function segBtn(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--text-muted)',
    transition: 'background 0.12s',
  };
}

/** Theme: persists to config AND drives the live dashboard via localStorage + data-theme. */
export function ThemeControl({ initial }: { initial: 'system' | 'light' | 'dark' }) {
  const [value, setValue] = useState(initial);
  const { state, save } = useSaver();

  const apply = (next: 'system' | 'light' | 'dark') => {
    setValue(next);
    try {
      localStorage.setItem('adx-theme', next);
      const dark = next === 'dark' || (next === 'system' && matchMedia('(prefers-color-scheme:dark)').matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      window.dispatchEvent(new Event('adx-theme-change'));
    } catch {}
    save({ theme: next });
  };

  return (
    <div className="row between" style={{ padding: '4px 0' }} id="display-theme">
      <div><div className="f13 fw6">Theme</div><div className="f12 muted">Dashboard color scheme</div></div>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <SaveDot state={state} />
        <div style={seg} role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((opt) => (
            <button key={opt} type="button" style={segBtn(value === opt)} onClick={() => apply(opt)}>
              {opt[0].toUpperCase() + opt.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface SelectRowProps {
  id: string;
  title: string;
  sub: string;
  field: string;
  initial: string | number;
  numeric?: boolean;
  options: { value: string | number; label: string }[];
}

export function SelectRow({ id, title, sub, field, initial, numeric, options }: SelectRowProps) {
  const [value, setValue] = useState(String(initial));
  const { state, save } = useSaver();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setValue(v);
    save({ [field]: numeric ? Number(v) : v });
  };

  return (
    <div className="row between" style={{ padding: '4px 0' }} id={id}>
      <div><div className="f13 fw6">{title}</div><div className="f12 muted">{sub}</div></div>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <SaveDot state={state} />
        <select className="adx-select" value={value} onChange={onChange}>
          {options.map((o) => (
            <option key={o.value} value={String(o.value)}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function ToggleRow({
  id, title, sub, field, initial,
}: { id: string; title: string; sub: string; field: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const { state, save } = useSaver();

  const toggle = () => {
    const next = !on;
    setOn(next);
    save({ [field]: next });
  };

  return (
    <div className="row between" style={{ padding: '4px 0' }} id={id}>
      <div><div className="f13 fw6">{title}</div><div className="f12 muted">{sub}</div></div>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <SaveDot state={state} />
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={toggle}
          className="adx-switch"
          data-on={on ? 'true' : 'false'}
        >
          <span className="adx-switch-knob" />
        </button>
      </div>
    </div>
  );
}
