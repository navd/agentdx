// Distinct hues per agent (not two greens) so bars/legends are tell-apart.
export const AGENT_COLORS: Record<string, string> = {
  'claude-code': '#46A35E', // green
  'cowork': '#C15F3C',      // terracotta
  'cursor': '#E0A458',      // amber
  'codex': '#6366F1',       // indigo
  'antigravity': '#14B8A6', // teal
  vscode: '#3B82F6',        // blue
  continue: '#8B5CF6',      // purple
};

export function agentColor(a: string): string {
  return AGENT_COLORS[a] || 'var(--text-subtle)';
}

export interface BarData {
  label: string;
  segments: { key: string; value: number; color: string }[];
}

export function buildBarData(
  rows: Array<{ month: string; agent: string; cnt: number }>,
  agents: string[]
): BarData[] {
  const grouped = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!grouped.has(r.month)) grouped.set(r.month, new Map());
    grouped.get(r.month)!.set(r.agent, r.cnt);
  }

  const months = Array.from(grouped.keys()).sort();
  return months.map(m => {
    const map = grouped.get(m)!;
    return {
      label: formatMonth(m),
      segments: agents.map(a => ({
        key: a,
        value: map.get(a) || 0,
        color: AGENT_COLORS[a] || 'var(--text-subtle)',
      })),
    };
  });
}

function formatMonth(ym: string): string {
  const [, m] = ym.split('-');
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[parseInt(m)] || m;
}
