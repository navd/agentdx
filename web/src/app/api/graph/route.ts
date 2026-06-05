import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { expandNode, searchNodes, quickQuery, nodeStats } from '@/lib/graph';

export const dynamic = 'force-dynamic';

// Graph interactions, all local + read-only:
//  - { nodeId }   → typed neighbours of a node (click-to-expand)
//  - { search }   → entities matching a query (search box)
//  - { quick }    → a seeded "quick query" subgraph
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const db = getDb();

    if (typeof body.search === 'string') {
      return NextResponse.json({ results: searchNodes(db, body.search) });
    }
    if (typeof body.quick === 'string') {
      return NextResponse.json(quickQuery(db, body.quick));
    }
    if (typeof body.stats === 'string' && body.stats.includes(':')) {
      return NextResponse.json(nodeStats(db, body.stats) || { fact: null });
    }
    if (typeof body.nodeId === 'string' && body.nodeId.includes(':')) {
      return NextResponse.json(expandNode(db, body.nodeId));
    }
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'graph request failed' }, { status: 500 });
  }
}
