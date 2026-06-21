// GENERATED from src/core/datasource.ts by scripts/sync-shared.mjs — do not edit.
// A pluggable data source for the dashboard. Pages read through this interface
// rather than touching SQLite directly, so the backing store can vary; the
// default reads the local SQLite database.

import type { FinopsReport } from './finops';
import type { ModelsReport } from './models';

export interface AgentDxDataSource {
  /** Human label for the current scope, e.g. "Local machine". */
  readonly scope: string;
  /** Cross-agent cost report (Tokenomics "Cost" lens). Async-friendly. */
  finops(period: string): Promise<FinopsReport> | FinopsReport;
  /** Model/token report (Tokenomics "Models" lens). Async-friendly. */
  models(period: string): Promise<ModelsReport> | ModelsReport;
}
