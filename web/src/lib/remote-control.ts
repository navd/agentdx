import { getDb } from '@/lib/db';

export interface RemoteSessionDetail {
  id: string;
  agent: string | null;
  title: string | null;
  started_at: number | null;
  duration_ms: number | null;
  tool_call_count: number | null;
  model_primary: string | null;
  first_user_message: string | null;
  commandCount: number;
  evidenceTypes: string[];
}

export interface RemoteControlData {
  remoteSessions: RemoteSessionDetail[];
  remoteSessionCount: number;
  matchedCalls: number;
  artifactCount: number;
}

// Substrings that flag a tool call as remote-control evidence. 'remote-control'
// is intentionally excluded — it self-matches this tool's own page/skill names.
const KEYWORDS = ['screenshot', 'playwright', 'puppeteer', 'selenium', 'clipboard'];

export function getRemoteControlData(): RemoteControlData {
  const db = getDb();

  const likeClauses = KEYWORDS.map((_, i) => `(tc.tool_input LIKE @kw${i} OR tc.tool_output LIKE @kw${i})`).join(' OR ');
  const params: Record<string, string> = {};
  KEYWORDS.forEach((kw, i) => { params[`kw${i}`] = `%${kw}%`; });

  const remoteCalls = db.prepare(`
    SELECT tc.*, s.agent, s.title, s.started_at, s.duration_ms, s.tool_call_count, s.model_primary
    FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
    WHERE (${likeClauses}) AND s.model_primary != '<synthetic>'
    ORDER BY tc.timestamp DESC LIMIT 100
  `).all(params) as any[];

  const remoteSessions = db.prepare(`
    SELECT DISTINCT s.id, s.agent, s.title, s.started_at, s.duration_ms, s.tool_call_count, s.model_primary, s.first_user_message
    FROM sessions s JOIN tool_calls tc ON tc.session_id = s.id
    WHERE (${likeClauses}) AND s.model_primary != '<synthetic>'
    ORDER BY s.started_at DESC LIMIT 50
  `).all(params) as any[];

  const sessionDetails: RemoteSessionDetail[] = remoteSessions.map((s: any) => {
    const calls = remoteCalls.filter((c: any) => c.session_id === s.id);
    const evidenceTypes = new Set<string>();
    for (const c of calls) {
      const combined = ((c.tool_input || '') + ' ' + (c.tool_output || '')).toLowerCase();
      if (combined.includes('screenshot')) evidenceTypes.add('screenshot');
      if (combined.includes('browser') || combined.includes('playwright') || combined.includes('puppeteer') || combined.includes('selenium')) evidenceTypes.add('browser');
      if (combined.includes('clipboard')) evidenceTypes.add('clipboard');
      if (combined.includes('upload') || combined.includes('download')) evidenceTypes.add('file-transfer');
    }
    return { ...s, commandCount: calls.length, evidenceTypes: Array.from(evidenceTypes) };
  });

  const artifactCount = remoteCalls.filter((c: any) => {
    const combined = ((c.tool_input || '') + ' ' + (c.tool_output || '')).toLowerCase();
    return combined.includes('screenshot') || combined.includes('upload') || combined.includes('download');
  }).length;

  return { remoteSessions: sessionDetails, remoteSessionCount: remoteSessions.length, matchedCalls: remoteCalls.length, artifactCount };
}
