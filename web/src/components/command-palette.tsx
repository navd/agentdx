'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface NavItem {
  label: string;
  href: string;
  detail: string;
}

const ITEMS: NavItem[] = [
  { label: 'Overview', href: '/', detail: 'Dashboard and KPI overview' },
  { label: 'Insights', href: '/insights', detail: 'Verdicts: best agent, shipping efficiency' },
  { label: 'Sessions', href: '/sessions', detail: 'Captured agent sessions' },
  { label: 'Agents & Skills', href: '/agents', detail: 'Agent usage and tool matrix' },
  { label: 'Tokenomics', href: '/tokenomics', detail: 'Tokens, cost, models and providers' },
  { label: 'Repositories & PRs', href: '/repositories', detail: 'Repository activity and pull-request evidence' },
  { label: 'Pull Requests', href: '/repositories', detail: 'PR evidence from git activity' },
  { label: 'Risk & Policy', href: '/risk', detail: 'Findings, risk signals, policy log' },
  { label: 'Rules & Policy', href: '/risk', detail: 'Policy enforcement log' },
  { label: 'Reports', href: '/reports', detail: 'Evidence-backed reports' },
  { label: 'Collector', href: '/collector', detail: 'Collection status and health' },
  { label: 'Settings', href: '/settings', detail: 'Configuration and data sources' },
  { label: 'Failed sessions', href: '/sessions?status=failed', detail: 'Sessions with errors' },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const filtered = useMemo(() => {
    if (!query.trim()) return ITEMS;
    const q = query.toLowerCase();
    return ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.detail.toLowerCase().includes(q)
    );
  }, [query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [filtered]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, []);

  const navigate = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router]
  );

  // Global keyboard listener for Cmd+K / Ctrl+K + custom event from search trigger
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    function handleOpen() {
      setOpen(true);
    }
    (window as any).__openCommandPalette = handleOpen;
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('open-command-palette', handleOpen);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('open-command-palette', handleOpen);
      delete (window as any).__openCommandPalette;
    };
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Keyboard navigation within palette
  function handlePaletteKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIndex]) {
        navigate(filtered[activeIndex].href);
      }
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.children[activeIndex] as HTMLElement | undefined;
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          background: 'rgba(0, 0, 0, 0.45)',
          backdropFilter: 'blur(2px)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingTop: '15vh',
        }}
        onClick={close}
      >
        {/* Palette card */}
        <div
          role="dialog"
          aria-label="Command palette"
          style={{
            width: '100%',
            maxWidth: 560,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--shadow-md)',
            overflow: 'hidden',
            fontFamily: 'var(--font)',
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handlePaletteKeyDown}
        >
          {/* Input row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 16px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            {/* Search icon */}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ width: 18, height: 18, flexShrink: 0 }}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>

            <input
              ref={inputRef}
              type="text"
              placeholder="Search pages and actions..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: 'var(--text)',
                fontSize: 15,
                fontFamily: 'var(--font)',
              }}
            />

            {/* Close button */}
            <button
              onClick={close}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'none',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '2px 6px',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                fontSize: 11,
                fontFamily: 'var(--mono)',
                lineHeight: 1.4,
              }}
              aria-label="Close"
            >
              ESC
            </button>
          </div>

          {/* Results list */}
          <div
            ref={listRef}
            style={{
              maxHeight: 360,
              overflowY: 'auto',
              padding: '6px 0',
            }}
          >
            {filtered.length === 0 && (
              <div
                style={{
                  padding: '24px 16px',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: 14,
                }}
              >
                No results found
              </div>
            )}

            {filtered.map((item, idx) => (
              <div
                key={item.href}
                onClick={() => navigate(item.href)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 16px',
                  cursor: 'pointer',
                  background:
                    idx === activeIndex ? 'var(--surface-3)' : 'transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                {/* Arrow / chevron icon */}
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={idx === activeIndex ? 'var(--accent)' : 'var(--text-muted)'}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: 16, height: 16, flexShrink: 0 }}
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      color: 'var(--text)',
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      marginTop: 1,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Footer hint */}
          <div
            style={{
              padding: '8px 16px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 11,
              color: 'var(--text-muted)',
              fontFamily: 'var(--mono)',
            }}
          >
            <span>
              <kbd style={{ padding: '1px 4px', border: '1px solid var(--border)', borderRadius: 3 }}>&uarr;&darr;</kbd> navigate
            </span>
            <span>
              <kbd style={{ padding: '1px 4px', border: '1px solid var(--border)', borderRadius: 3 }}>&crarr;</kbd> open
            </span>
            <span>
              <kbd style={{ padding: '1px 4px', border: '1px solid var(--border)', borderRadius: 3 }}>esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
