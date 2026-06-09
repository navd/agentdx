import type { Metadata } from 'next';
import '@/styles/globals.css';
import Sidebar from '@/components/sidebar';
import ThemeToggle from '@/components/theme-toggle';
import CommandPalette from '@/components/command-palette';

export const metadata: Metadata = {
  title: 'AgentDX',
  description: 'Your AI coding agents, summarized — tokens, tools, models, and errors, read locally.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var p=localStorage.getItem('adx-theme')||'system';var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){}})();` }} />
      </head>
      <body>
        <div className="app-shell">
          <Sidebar />
          <div className="main">
            <header className="topbar">
              <div className="topbar-spacer" />
              <div className="topbar-actions">
                <ThemeToggle />
              </div>
            </header>
            <CommandPalette />
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
