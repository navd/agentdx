import { getDb } from '@/lib/db';
import { buildGraph } from '@/lib/graph';
import { GraphExplorer } from '@/components/graph-explorer';
import { ErrorBoundary } from '@/components/error-boundary';

export const dynamic = 'force-dynamic';

export default function GraphPage() {
  const db = getDb();
  const graph = buildGraph(db);

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Knowledge Graph</h1>
          <p className="page-sub">Agents, repos, models, sessions, files, prompts &amp; tools — and how they connect. Click any node to expand its relationships.</p>
          <p className="f12" style={{ color: 'var(--text-subtle)', marginTop: 4, lineHeight: 1.5 }}>
            Node size = activity (tool calls / sessions / interactions) by default — comparable across agents. Switch to <em>tokens</em> for spend: input, output &amp; cache-read are kept disjoint per agent (Codex reports cache-inclusive input — we de-include it so cache is never double-counted), and cache-read shows in the panel, never in sizing. File coverage reflects Edit/Write/Read tools — Codex edits mostly via the shell, so it is under-represented on files.
          </p>
        </div>
      </div>

      <ErrorBoundary fallbackTitle="Graph failed to render">
        <GraphExplorer initial={graph} />
      </ErrorBoundary>
    </div>
  );
}
