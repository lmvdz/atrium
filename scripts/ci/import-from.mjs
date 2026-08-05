/**
 * Import a dependency as one of the workspaces would.
 *
 * These CI scripts live at the repo root but need packages that only the
 * workspaces declare (`postgres` from @atrium/db, `@playwright/test` from
 * @atrium/web). Resolving from the workspace rather than from here keeps the
 * dependency graph honest — root does not grow phantom dependencies — and, for
 * the schema reflection, guarantees the drizzle-orm instance doing the
 * reflecting is the one the schema was built against.
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function importFrom(packageDir, specifier) {
  const resolver = createRequire(pathToFileURL(resolve(packageDir, 'package.json')));
  return import(pathToFileURL(resolver.resolve(specifier)).href);
}

/**
 * The CommonJS door into the same house. `import()` of a CJS module only sees
 * the named exports Node's lexer can find statically — for `@playwright/test`
 * that is none of the ones we need — whereas `require()` hands back the real
 * `module.exports`.
 */
export function requireFrom(packageDir, specifier) {
  return createRequire(pathToFileURL(resolve(packageDir, 'package.json')))(specifier);
}
