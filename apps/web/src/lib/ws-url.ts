/**
 * Where the WebSocket lives — decided when the page runs, never when it builds.
 *
 * #19's gauntlet routed this as a defect in the scaffold: `NEXT_PUBLIC_WS_URL`
 * is inlined by Next at build time, so the URL is frozen into the JavaScript
 * bundle. One image then cannot be promoted from staging to production, a
 * self-hoster who changes their domain has to rebuild, and — the sharp edge —
 * a bundle built with `ws://localhost:4000` and served over HTTPS produces a
 * mixed-content failure that looks like the server being down.
 *
 * Two runtime routes, in order:
 *
 *  1. **Same origin.** The default and the one to prefer: derive the URL from
 *     `window.location`, so the page connects back to whatever host actually
 *     served it, over `wss:` exactly when the page itself is `https:`. This
 *     needs a reverse proxy in front that forwards `/ws` to the app server —
 *     which is the deployment shape init.md describes anyway. Nothing is
 *     configured, so nothing can be configured wrong.
 *  2. **Runtime config.** For the cases where the socket genuinely is not
 *     same-origin — `pnpm dev`, where Next is on 3000 and the server on 4000 —
 *     an override read from the environment *at request time*. See
 *     `runtime-config.ts` and the `force-dynamic` route it fetches.
 *
 * Neither reads `process.env.NEXT_PUBLIC_*`, and a unit test asserts that no
 * file under `src/lib` ever does again.
 */

export interface RuntimeConfig {
  /**
   * Absolute (`wss://host/ws`) or origin-relative (`/ws`) — an absolute value
   * wins outright, a relative one is resolved against the current origin.
   */
  wsUrl?: string | null;
  /** Same-origin path when there is no `wsUrl`. Defaults to `/ws`. */
  wsPath?: string | null;
}

/** The subset of `window.location` this needs. Keeps the function testable. */
export interface LocationLike {
  protocol: string;
  host: string;
}

export class WsUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsUrlError';
  }
}

/**
 * Resolve the socket URL. Pure: hand it a location and a config and it will
 * give the same answer anywhere, which is what makes the rules above testable
 * rather than merely stated.
 */
export function resolveWsUrl(config: RuntimeConfig = {}, location?: LocationLike): string {
  const here = location ?? currentLocation();
  const configured = config.wsUrl?.trim();

  if (configured) {
    if (/^wss?:\/\//i.test(configured)) return configured;
    if (/^https?:\/\//i.test(configured)) {
      const url = new URL(configured);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.toString();
    }
    if (configured.startsWith('/')) return sameOrigin(here, configured);
    throw new WsUrlError(
      `runtime wsUrl "${configured}" is neither absolute (ws://, wss://, http://, https://) nor origin-relative (/…)`,
    );
  }

  const path = config.wsPath?.trim() || '/ws';
  if (!path.startsWith('/')) {
    throw new WsUrlError(`runtime wsPath "${path}" must start with "/"`);
  }
  return sameOrigin(here, path);
}

function sameOrigin(location: LocationLike, path: string): string {
  if (!location.host) {
    throw new WsUrlError('cannot derive a same-origin WebSocket URL: the location has no host');
  }
  // `https:` → `wss:` is not a preference. A secure page may not open an
  // insecure socket, so getting this backwards is a hard browser failure.
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${path}`;
}

function currentLocation(): LocationLike {
  if (typeof window === 'undefined' || !window.location) {
    throw new WsUrlError(
      'no window.location — the realtime client only connects in the browser; render on the server and connect in an effect',
    );
  }
  return { protocol: window.location.protocol, host: window.location.host };
}
