// Sync the shared `src/core` modules that BOTH the CLI (compiled to dist, Node
// ESM) and the Next dashboard need. The web app cannot import across the `web/`
// boundary, so we generate copies under web/src/lib.
//
// The one wrinkle: Node ESM requires explicit `.js` import specifiers, but the
// Next/webpack bundler will not resolve `./pricing.js` to `pricing.ts`. So for
// the web copies we rewrite `from './pricing.js'` → `from './pricing'`.
//
// Source of truth is always src/core/*.ts — never hand-edit the web copies.

import { readFileSync, writeFileSync } from 'fs';

const BANNER = '// GENERATED from src/core/%s by scripts/sync-shared.mjs — do not edit.\n';

function sync(src, dest, name) {
  let code = readFileSync(src, 'utf8');
  // Web bundler resolves extensionless relative imports, not `.js` ones.
  code = code.replace(/from '\.\/([A-Za-z0-9_-]+)\.js'/g, "from './$1'");
  writeFileSync(dest, BANNER.replace('%s', name) + code);
}

sync('src/core/pricing.ts', 'web/src/lib/pricing.ts', 'pricing.ts');
sync('src/core/finops.ts', 'web/src/lib/finops.ts', 'finops.ts');
sync('src/core/models.ts', 'web/src/lib/models.ts', 'models.ts');
sync('src/core/datasource.ts', 'web/src/lib/datasource-contract.ts', 'datasource.ts');

console.log('synced shared modules → web/src/lib');
