/* ---------------------------------------------------------------------------
 * WHAT "THE APP" IS, ENUMERATED ONCE.
 *
 * This was inline in `printed-strings.test.tsx`, where r8's D5 put it: the file
 * list was "`*.tsx` under two named directories", and the only guard on it was
 * `SOURCES.length > 24`. Measured on r7, adding `src/components/primitives/
 * Leak.jsx` and `src/widgets/Leak2.tsx` — each rendering `<span title={note}>
 * {note}</span>` off an untraced prop — left the sweep at 226 sites, UNCHANGED
 * and GREEN, while `tsconfig` sets `allowJs: true` and Next compiles and ships
 * both.
 *
 * ROUND 10 gives the file set a SECOND consumer (`glyph-source.test.ts`), and a
 * denominator with two copies is a denominator that can differ between them —
 * which is the r8 defect one level up. So it lives here, and both sweeps import
 * it. The three authorities and the assertions that their differences are empty
 * stay in `printed-strings.test.tsx`, driven off these exports.
 *
 * WHAT IT ENUMERATES FROM: the filesystem, cross-checked against tsc's parse of
 * the project and the resulting module graph, plus Next's route conventions.
 * WHAT EXECUTES AND IS NOT LISTED: the CSS, the `design/` token sheet, and code
 * in `packages/*` that this app imports — enumerated by their own packages.
 * ------------------------------------------------------------------------- */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

function find(path: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, path);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`${path} not found above ${process.cwd()}`);
}

export const WEB = find('apps/web/package.json').replace(/\/package\.json$/, '');
export const REPO = dirname(dirname(WEB));

/**
 * Extensions Next compiles into the app. `allowJs` is on, so the JavaScript ones
 * are not hypothetical — a `.jsx` beside a `.tsx` is bundled identically.
 */
export const COMPILED_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
];

/**
 * Directories under `apps/web` that are not the shipped app. Everything else is,
 * including any directory nobody has created yet — which is the point of naming
 * the exclusions rather than the inclusions.
 */
export const NOT_THE_APP: ReadonlySet<string> = new Set(['node_modules', 'test', 'e2e', 'public']);

export function isCompiled(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  return COMPILED_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Every file under `apps/web` that Next can compile into the app. */
function appSources(): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (NOT_THE_APP.has(name) || name.startsWith('.')) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (isCompiled(name)) out.push(full);
    }
  };
  walk(WEB);
  return out;
}

export const SOURCES: readonly string[] = appSources();

/** The project as TypeScript itself parses it — not as a regex over the JSON. */
export function parsedProject(): ts.ParsedCommandLine {
  const configPath = join(WEB, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf8'));
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, WEB);
}

export function insideTheApp(path: string): boolean {
  const rel = relative(WEB, path);
  if (rel.startsWith('..') || rel.startsWith('/')) return false;
  if (!isCompiled(rel)) return false;
  return !rel.split('/').some((segment) => NOT_THE_APP.has(segment) || segment.startsWith('.'));
}

/** Files the compiler roots from this app's own tree, on the same terms. */
export function compilerRoots(parsed: ts.ParsedCommandLine): readonly string[] {
  return parsed.fileNames.filter((path) => insideTheApp(path));
}

/** Next's file-based entry points: reachable by URL, not by import. */
export const ROUTE_FILES: readonly string[] = [
  'page',
  'layout',
  'route',
  'error',
  'global-error',
  'not-found',
  'template',
  'default',
  'loading',
];

export function routeEntryPoints(): readonly string[] {
  return SOURCES.filter((path) => {
    const rel = relative(WEB, path);
    if (!rel.startsWith('app/')) return false;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return ROUTE_FILES.some((name) => COMPILED_EXTENSIONS.some((ext) => base === `${name}${ext}`));
  });
}
