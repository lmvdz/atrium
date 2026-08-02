import type { RuntimeConfig } from './ws-url.js';

/**
 * The runtime override, fetched rather than bundled.
 *
 * Two sources, cheapest first:
 *
 *  1. `window.__ATRIUM_RUNTIME__`, if the page was served with it inline. A
 *     reverse proxy or an edge worker can inject that without rebuilding, and
 *     it costs no round trip.
 *  2. `GET /api/runtime-config`, a `force-dynamic` route handler that reads the
 *     server's environment per request. `force-dynamic` is the load-bearing
 *     word: a statically prerendered route would freeze the environment at
 *     build time and reintroduce exactly the defect this replaces.
 *
 * A failure here is not fatal. An empty config falls through to the
 * same-origin default in `resolveWsUrl`, which is the right answer for any
 * deployment behind a proxy — so a missing config endpoint degrades to the
 * common case rather than to a blank screen.
 */

declare global {
  interface Window {
    __ATRIUM_RUNTIME__?: RuntimeConfig;
  }
}

export const RUNTIME_CONFIG_PATH = '/api/runtime-config';

let cached: Promise<RuntimeConfig> | null = null;

export async function loadRuntimeConfig(
  fetchImpl: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined,
  path: string = RUNTIME_CONFIG_PATH,
): Promise<RuntimeConfig> {
  if (typeof window !== 'undefined' && window.__ATRIUM_RUNTIME__) {
    return window.__ATRIUM_RUNTIME__;
  }
  if (!fetchImpl) return {};
  cached ??= (async () => {
    try {
      const response = await fetchImpl(path, { cache: 'no-store' });
      if (!response.ok) return {};
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) return {};
      const { wsUrl, wsPath } = body as RuntimeConfig;
      return {
        wsUrl: typeof wsUrl === 'string' ? wsUrl : null,
        wsPath: typeof wsPath === 'string' ? wsPath : null,
      };
    } catch {
      return {};
    }
  })();
  return cached;
}

/** Drop the memoised config — for tests, and for a deliberate re-read. */
export function resetRuntimeConfigCache(): void {
  cached = null;
}
