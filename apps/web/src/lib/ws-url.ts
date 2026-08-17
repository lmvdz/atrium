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
  /**
   * Where the browser reads Electric shapes (#201) — ALWAYS a same-origin path,
   * never an absolute URL, and `null` when this deployment has no sync fabric.
   *
   * Deliberately not the twin of `wsUrl`. The socket may legitimately live on
   * another origin (`pnpm dev` puts it on :4000), so that value is allowed to be
   * absolute. A shape read may not: it is authorized by the session cookie, and
   * a cookie only rides a same-origin request. An absolute value here would be a
   * cross-origin fetch that arrives unauthenticated at an Electric which cannot
   * authenticate anyway — a room's document readable by anyone who guessed the
   * URL. `resolveElectricShapeUrl` refuses one rather than trusting the config.
   */
  electricShapePath?: string | null;
}

/** The path the shape proxy is mounted at when nothing says otherwise. */
export const DEFAULT_ELECTRIC_SHAPE_PATH = '/electric/v1/shape';

/**
 * Resolve the shape endpoint the Yjs transport reads a room's document from.
 *
 * Same-origin by construction, for the reason `electricShapePath` gives: the
 * proxy authorizes the read against the session cookie, and a cross-origin URL
 * would send the request without one. Pure, like `resolveWsUrl`, so the rule is
 * testable rather than merely asserted.
 *
 * NOT YET WIRED. As of #201 this function has no product caller — the Yjs
 * transport that reads through it lands with E2/E4 (`app/prototype/
 * electric-transport.ts` is the prototype, not a mounted client). Only
 * `test/ws-url.test.ts` exercises it today, so its absolute-URL refusal is a
 * guarantee kept ready, not an active guard standing in a live request path.
 * When E2/E4 mount the transport, this becomes the one place the browser learns
 * the shape origin, and the refusal starts doing its job.
 */
export function resolveElectricShapeUrl(
  config: RuntimeConfig = {},
  location?: LocationLike,
): string {
  const here = location ?? currentLocation();
  const path = config.electricShapePath?.trim() || DEFAULT_ELECTRIC_SHAPE_PATH;
  if (!path.startsWith('/')) {
    throw new WsUrlError(
      `runtime electricShapePath "${path}" must be an origin-relative path starting with "/" — a shape read is authorized by the session cookie, which only rides a same-origin request`,
    );
  }
  return `${here.protocol}//${here.host}${path}`;
}

/** The app route the Yjs write door (#202) is mounted at, per room. */
export const ELECTRIC_SEND_PATH_PREFIX = '/api/rooms';

/**
 * Resolve the endpoint the Yjs transport PUTs a room's updates to (#202).
 *
 * Same-origin by construction, and for a sharper reason than the shape read: the
 * write is authorized by the session COOKIE, and a cookie only rides a
 * same-origin request. A cross-origin send would arrive with no session and be
 * refused 401 — so, unlike the socket URL, there is no configurable absolute
 * form here at all. The door is a Next route in THIS app; it is not remountable
 * elsewhere the way the read proxy can be, so the path is a fixed template around
 * the room id rather than a runtime-config value.
 *
 * Pure, like `resolveWsUrl` — hand it a room and a location and it answers the
 * same anywhere, so the same-origin rule is testable rather than merely stated.
 * NOT YET WIRED into a mounted client: `electric-transport.ts` is the transport
 * this feeds, and it lands mounted with E4; this is the one place the browser
 * will learn the write origin when it does.
 */
export function resolveElectricSendUrl(room: string, location?: LocationLike): string {
  const here = location ?? currentLocation();
  if (!here.host) {
    throw new WsUrlError('cannot derive a same-origin send URL: the location has no host');
  }
  return `${here.protocol}//${here.host}${ELECTRIC_SEND_PATH_PREFIX}/${encodeURIComponent(room)}/ydoc`;
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
