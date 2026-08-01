import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWsUrl, WsUrlError } from '../src/lib/ws-url.js';

/**
 * The routed finding from #19, kept fixed: the WebSocket endpoint must be
 * decided when the page runs, not when it builds.
 */

const https = { protocol: 'https:', host: 'atrium.example' };
const http = { protocol: 'http:', host: 'localhost:3000' };

describe('resolveWsUrl — same-origin by default', () => {
  it('derives wss:// from an https page', () => {
    expect(resolveWsUrl({}, https)).toBe('wss://atrium.example/ws');
  });

  it('derives ws:// from an http page', () => {
    expect(resolveWsUrl({}, http)).toBe('ws://localhost:3000/ws');
  });

  it('follows a proxy that forwards the socket somewhere else', () => {
    expect(resolveWsUrl({ wsPath: '/realtime' }, https)).toBe('wss://atrium.example/realtime');
  });

  it('refuses a path that is not origin-relative', () => {
    expect(() => resolveWsUrl({ wsPath: 'realtime' }, https)).toThrow(WsUrlError);
  });

  it('refuses to invent an origin when there is no host', () => {
    expect(() => resolveWsUrl({}, { protocol: 'https:', host: '' })).toThrow(WsUrlError);
  });
});

describe('resolveWsUrl — runtime override', () => {
  it('takes an absolute ws:// URL as given', () => {
    expect(resolveWsUrl({ wsUrl: 'ws://localhost:4000/ws' }, https)).toBe('ws://localhost:4000/ws');
  });

  it('upgrades an https:// override to wss://', () => {
    expect(resolveWsUrl({ wsUrl: 'https://edge.example/ws' }, http)).toBe('wss://edge.example/ws');
  });

  it('resolves an origin-relative override against the current page', () => {
    expect(resolveWsUrl({ wsUrl: '/socket' }, https)).toBe('wss://atrium.example/socket');
  });

  it('ignores an empty or whitespace override rather than producing "wss://"', () => {
    expect(resolveWsUrl({ wsUrl: '   ' }, https)).toBe('wss://atrium.example/ws');
    expect(resolveWsUrl({ wsUrl: null }, https)).toBe('wss://atrium.example/ws');
  });

  it('refuses a value that is neither absolute nor origin-relative', () => {
    expect(() => resolveWsUrl({ wsUrl: 'atrium.example/ws' }, https)).toThrow(WsUrlError);
  });
});

describe('nothing in the client library reads a build-time environment variable', () => {
  /**
   * The regression guard, not a style rule. `NEXT_PUBLIC_*` is *inlined by the
   * bundler*, so a single reference anywhere under `src/` reintroduces the
   * baked-URL defect no matter how the value is used. A test is the only thing
   * that keeps that from creeping back in a year from now.
   */
  it('reads neither NEXT_PUBLIC_ nor process.env anywhere under src/', () => {
    const offenders: string[] = [];
    for (const file of walk(join(import.meta.dirname, '..', 'src'))) {
      const code = withoutComments(readFileSync(file, 'utf8'));
      if (code.includes('NEXT_PUBLIC_')) offenders.push(`${file}: NEXT_PUBLIC_`);
      if (code.includes('process.env')) offenders.push(`${file}: process.env`);
    }
    expect(offenders).toEqual([]);
  });

  it('reads the runtime config from a force-dynamic route handler', () => {
    const code = withoutComments(
      readFileSync(
        join(import.meta.dirname, '..', 'app', 'api', 'runtime-config', 'route.ts'),
        'utf8',
      ),
    );
    expect(code).toContain("export const dynamic = 'force-dynamic'");
    expect(code).toContain('process.env.ATRIUM_WS_URL');
    // The route runs on the server, so `process.env` is right here — what must
    // never appear is the prefix the bundler inlines.
    expect(code).not.toContain('NEXT_PUBLIC_');
  });

  it('does not let next.config.ts inline anything into the bundle', () => {
    const config = readFileSync(join(import.meta.dirname, '..', 'next.config.ts'), 'utf8');
    // An `env:` block is exactly the build-time inlining mechanism.
    expect(config).not.toMatch(/^\s*env:\s*\{/m);
    expect(config).not.toMatch(/NEXT_PUBLIC_WS_URL:/);
  });
});

/**
 * Code with the prose taken out.
 *
 * These files *discuss* `NEXT_PUBLIC_` at length — that is the point of the
 * comments — so a raw substring search would fail on the explanation of why the
 * thing is banned. Block comments go, and so do whole-line `//` ones; trailing
 * comments are deliberately left in, because leaving them can only produce a
 * false alarm, and stripping them (`'ws://…'` is not a comment) could hide a
 * real one.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) yield path;
  }
}
