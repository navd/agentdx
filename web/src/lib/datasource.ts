// The dashboard reads through a pluggable data source rather than touching
// SQLite directly. The default reads the local database. The interface itself
// is the shared contract in src/core/datasource.ts (synced here as
// datasource-contract and exported from the @agentdx/agentdx package).

import { getDb } from './db';
import { buildFinopsReport } from './finops';
import { buildModelsReport } from './models';
import type { AgentDxDataSource } from './datasource-contract';

export type { AgentDxDataSource };

/** Reads everything from the local SQLite database. */
export class LocalSqliteSource implements AgentDxDataSource {
  readonly scope = 'Local machine';

  finops(period: string) {
    return buildFinopsReport(getDb(), period);
  }
  models(period: string) {
    return buildModelsReport(getDb(), period);
  }
}

export function getDataSource(): AgentDxDataSource {
  return new LocalSqliteSource();
}
