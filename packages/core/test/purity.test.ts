import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeAttention, evaluateEscalation, reduce, serializeState } from '../src/index.js';
import { at, sampleLog } from './fixtures.js';

/**
 * The zero-I/O boundary, asserted rather than asserted-in-a-comment.
 *
 * `index.ts` opens with "this package must never import `node:*`, a database
 * driver, a network client, or anything that reads a clock", and until now that
 * was a sentence. It is load-bearing for three separate reasons and each of them
 * fails silently if it stops being true:
 *
 *  1. **Replay.** `reduce` must fold the same log to the same bytes on a server,
 *     in a worker and in a browser. One `Date.now()` anywhere in the fold and
 *     the live state and the replayed state diverge on a field nobody is
 *     comparing.
 *  2. **Testability.** Every rule in #4, #5 and #6 is checkable without a
 *     database or a model precisely because none of them can reach one.
 *  3. **Portability.** The reducer runs client-side in the room. A `node:`
 *     import does not fail at build time in a bundler that shims it — it fails
 *     at 3am in somebody's browser.
 *
 * The test reads the source text. That is cruder than an import graph and it is
 * the point: it catches a dynamic `import()`, a bare `fetch`, and a `Date.now()`
 * that no module-resolution check would see.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Every `import … from '…'`, `export … from '…'`, and dynamic `import('…')`. */
function specifiersIn(source: string): string[] {
  const out: string[] = [];
  const statics = source.matchAll(/\b(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g);
  for (const match of statics) if (match[1]) out.push(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1]) out.push(match[1]);
  }
  for (const match of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

/** Strip comments and string literals, so a rule cannot fire on prose about it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** The only third-party import this package is allowed to have. */
const ALLOWED_PACKAGES = new Set(['zod']);

const files = sourceFiles();

describe('the zero-I/O boundary', () => {
  it('finds the source it is supposed to be checking', () => {
    // A glob that silently matches nothing is a test that always passes.
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(files.map((file) => file.split('/').at(-1))).toContain('reduce.ts');
  });

  it('imports nothing but zod and its own relative modules', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
        if (ALLOWED_PACKAGES.has(specifier)) continue;
        offenders.push(`${file.replace(SRC, 'src')} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports no node builtin, under any spelling', () => {
    const builtins =
      /^(?:node:|fs|path|url|os|crypto|http|https|net|tls|zlib|stream|buffer|child_process|worker_threads|perf_hooks|timers|events|util|assert)(?:\/|$)/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
        if (builtins.test(specifier)) offenders.push(`${file.replace(SRC, 'src')} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads no clock, rolls no dice, and reaches no network', () => {
    // The rules a module graph cannot see. Timestamps are supplied by the
    // caller everywhere in this package — that is why every signature that
    // needs one takes an `at`.
    const forbidden: Array<[RegExp, string]> = [
      [/\bDate\.now\b/, 'Date.now() — the caller supplies time'],
      [/\bnew Date\b/, 'new Date() — the caller supplies time'],
      [/\bMath\.random\b/, 'Math.random() — a replay must be reproducible'],
      [/\bperformance\.now\b/, 'performance.now() — a clock is a clock'],
      [/\bprocess\.[a-z]/i, 'process.* — no environment in a pure package'],
      [/\bfetch\s*\(/, 'fetch() — no network'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest — no network'],
      [/\bWebSocket\b/, 'WebSocket — no network'],
      [/\bsetTimeout\b|\bsetInterval\b/, 'timers — nothing here is asynchronous'],
      [/\bcrypto\./, 'crypto.* — ids are supplied by the caller'],
      [/\blocalStorage\b|\bsessionStorage\b/, 'storage — no I/O'],
      [/\bglobalThis\.[a-z]/i, 'globalThis.* — no ambient state'],
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = code(readFileSync(file, 'utf8'));
      for (const [pattern, why] of forbidden) {
        if (pattern.test(source)) offenders.push(`${file.replace(SRC, 'src')}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares zod as its only runtime dependency', () => {
    // The import check above is defeated by a transitive dependency doing the
    // I/O instead, so the manifest is checked too.
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['zod']);
  });

  it('detects a violation when there is one — the check can fail', () => {
    // A purity test that cannot fail is decoration. These are the exact patterns
    // the rules above run, against text that should trip each one.
    expect(specifiersIn("import { readFileSync } from 'node:fs';")).toEqual(['node:fs']);
    expect(specifiersIn("const x = await import('pg');")).toEqual(['pg']);
    expect(specifiersIn("export * from 'drizzle-orm';")).toEqual(['drizzle-orm']);
    expect(/\bDate\.now\b/.test(code('const t = Date.now();'))).toBe(true);
    // …and not against text that only talks about them.
    expect(/\bDate\.now\b/.test(code('// never call Date.now here'))).toBe(false);
    expect(/\bDate\.now\b/.test(code('const message = "do not call Date.now";'))).toBe(false);
  });
});

describe('purity, observed rather than inferred', () => {
  it('folds the same log to the same bytes on repeated runs', () => {
    expect(serializeState(reduce(sampleLog()))).toBe(serializeState(reduce(sampleLog())));
  });

  it('produces the same attention projection for the same state and time', () => {
    const state = reduce(sampleLog());
    expect(JSON.stringify(computeAttention(state, at(20)))).toBe(
      JSON.stringify(computeAttention(state, at(20))),
    );
  });

  it('produces the same escalation verdict for the same text', () => {
    const window = {
      messages: [
        {
          id: 'm1',
          authorId: 'a',
          body: '> quoted at some length, enough to count\n\nyou are right',
        },
      ],
    };
    expect(JSON.stringify(evaluateEscalation(window))).toBe(
      JSON.stringify(evaluateEscalation(window)),
    );
  });

  it('never mutates the input it is given', () => {
    const events = sampleLog();
    const before = JSON.stringify(events);
    const state = reduce(events);
    const stateBefore = serializeState(state);
    computeAttention(state, at(20));
    expect(JSON.stringify(events)).toBe(before);
    expect(serializeState(state)).toBe(stateBefore);
  });
});
