// Public library surface — pure compute utilities over the local database
// (each takes a better-sqlite3 Database as a type-only parameter, so importing
// this barrel pulls no native dependency).

export * from './pricing.js';
export * from './finops.js';
export * from './models.js';
export * from './check.js';
export * from './baseline.js';
export * from './datasource.js';
