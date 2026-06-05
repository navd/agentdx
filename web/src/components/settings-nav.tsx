'use client';

import { useState, useEffect } from 'react';
import {
  Database, Monitor, Settings, Clock, History, Info,
  FolderOpen, HardDrive, Palette, CalendarDays, Rows3,
  ToggleLeft, Timer, ChevronRight, Shield,
} from 'lucide-react';

interface NavSection {
  id: string;
  label: string;
  icon: React.ReactNode;
  items: { id: string; label: string; icon: React.ReactNode }[];
}

const sections: NavSection[] = [
  {
    id: 'sources', label: 'Data Sources', icon: <FolderOpen size={15} />,
    items: [
      { id: 'sources', label: 'Agent directories', icon: <FolderOpen size={13} /> },
      { id: 'database', label: 'SQLite database', icon: <HardDrive size={13} /> },
    ],
  },
  {
    id: 'display', label: 'Display', icon: <Monitor size={15} />,
    items: [
      { id: 'display-theme', label: 'Theme', icon: <Palette size={13} /> },
      { id: 'display-period', label: 'Default period', icon: <CalendarDays size={13} /> },
      { id: 'display-pagination', label: 'Items per page', icon: <Rows3 size={13} /> },
    ],
  },
  {
    id: 'collection', label: 'Collection', icon: <Settings size={15} />,
    items: [
      { id: 'collection-auto', label: 'Auto-collect', icon: <ToggleLeft size={13} /> },
      { id: 'collection-interval', label: 'Interval', icon: <Timer size={13} /> },
    ],
  },
  {
    id: 'privacy', label: 'Privacy', icon: <Shield size={15} />,
    items: [
      { id: 'privacy', label: 'Local-only', icon: <Shield size={13} /> },
    ],
  },
  {
    id: 'history', label: 'History', icon: <History size={15} />,
    items: [
      { id: 'history', label: 'Collection runs', icon: <Clock size={13} /> },
    ],
  },
  {
    id: 'about', label: 'About', icon: <Info size={15} />,
    items: [
      { id: 'about', label: 'Version & links', icon: <Info size={13} /> },
    ],
  },
];

export function SettingsNav() {
  const [active, setActive] = useState('sources');
  const [expanded, setExpanded] = useState<string>('sources');

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      const parent = sections.find(s => s.id === hash || s.items.some(i => i.id === hash));
      if (parent) {
        setExpanded(parent.id);
        setActive(hash);
      }
    }
  }, []);

  function handleSectionClick(section: NavSection) {
    if (section.items.length > 1) {
      setExpanded(expanded === section.id ? '' : section.id);
    }
    setActive(section.id);
    const el = document.getElementById(section.items.length === 1 ? section.items[0].id : section.id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleItemClick(sectionId: string, itemId: string) {
    setActive(itemId);
    const el = document.getElementById(itemId) || document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <nav className="card" style={{ position: 'sticky', top: 80 }}>
      <div style={{ padding: '6px 0' }}>
        {sections.map(section => {
          const isExpanded = expanded === section.id;
          const isActive = active === section.id || section.items.some(i => i.id === active);

          return (
            <div key={section.id}>
              <button
                onClick={() => handleSectionClick(section)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '9px 14px', border: 'none', background: isActive ? 'var(--accent-soft)' : 'transparent',
                  color: isActive ? 'var(--accent-text)' : 'var(--text-muted)',
                  fontFamily: 'var(--font)', fontSize: 13, fontWeight: isActive ? 600 : 500,
                  cursor: 'pointer', textAlign: 'left',
                  transition: 'background var(--dur, 0.18s), color var(--dur, 0.18s)',
                }}
                onMouseEnter={e => { if (!isActive) (e.target as HTMLElement).style.background = 'var(--surface-3)'; }}
                onMouseLeave={e => { if (!isActive) (e.target as HTMLElement).style.background = 'transparent'; }}
              >
                <span style={{ display: 'flex', flexShrink: 0 }}>{section.icon}</span>
                <span style={{ flex: 1 }}>{section.label}</span>
                {section.items.length > 1 && (
                  <ChevronRight size={12} style={{
                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform 0.15s',
                    color: 'var(--text-subtle)',
                  }} />
                )}
              </button>
              {isExpanded && section.items.length > 1 && (
                <div style={{ paddingLeft: 14 }}>
                  {section.items.map(item => (
                    <button
                      key={item.id}
                      onClick={() => handleItemClick(section.id, item.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 7, width: '100%',
                        padding: '6px 14px', border: 'none',
                        background: active === item.id ? 'var(--surface-3)' : 'transparent',
                        color: active === item.id ? 'var(--text)' : 'var(--text-subtle)',
                        fontFamily: 'var(--font)', fontSize: 12, fontWeight: active === item.id ? 600 : 400,
                        cursor: 'pointer', textAlign: 'left', borderRadius: 'var(--r-sm)',
                        transition: 'background var(--dur, 0.18s)',
                      }}
                      onMouseEnter={e => (e.target as HTMLElement).style.background = 'var(--surface-3)'}
                      onMouseLeave={e => { if (active !== item.id) (e.target as HTMLElement).style.background = 'transparent'; }}
                    >
                      <span style={{ display: 'flex', flexShrink: 0 }}>{item.icon}</span>
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
