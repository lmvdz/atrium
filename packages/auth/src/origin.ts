/**
 * Origin checking for the WebSocket upgrade.
 *
 * A WebSocket handshake is not subject to the same-origin policy and carries
 * cookies. That combination is cross-site WebSocket hijacking: any page a
 * signed-in person visits can open `ws://atrium/ws`, the browser attaches the
 * session cookie, and the socket is authenticated as them. The `Origin` header
 * is the only thing on the wire that says which page opened it, and — unlike
 * almost every other header — a browser will not let script forge it.
 *
 * Better Auth applies exactly this check to its own HTTP endpoints via
 * `trustedOrigins`. The realtime server has to make it too, against the same
 * list, or the two processes disagree about who "we" are.
 *
 * ## The origin-less case, decided rather than defaulted
 *
 * A non-browser client — `wscat`, a Node script, a health prober — sends no
 * `Origin` at all. Allowing that is allowing anything that can reach the port
 * and hold a cookie; refusing it costs those clients an explicit opt-in.
 *
 * Atrium is browser-facing, so the default is **refuse**. `WS_ALLOW_ORIGINLESS`
 * turns it back on for a deployment that genuinely has non-browser clients, and
 * naming it in the environment is the point: the decision is visible in the
 * deployment rather than buried in a default. The realtime server's own test
 * suite sets it, because a `ws` client is precisely such a caller.
 */

export type OriginVerdict = 'allowed' | 'forbidden' | 'missing';

export interface OriginPolicy {
  /** Origins that may open a socket. Compared exactly, after normalisation. */
  allowed: readonly string[];
  /** Whether a request with no `Origin` header is allowed through. */
  allowOriginless: boolean;
}

/**
 * Judge one `Origin` header value.
 *
 * `missing` is reported separately from `forbidden` so the caller can log the
 * difference — one is a misconfigured client, the other is an attack — while
 * answering both with the same status.
 */
export function checkOrigin(
  origin: string | null | undefined,
  policy: OriginPolicy,
): OriginVerdict {
  if (origin === undefined || origin === null || origin.trim() === '') {
    return policy.allowOriginless ? 'allowed' : 'missing';
  }

  // `null` is what a browser sends from a sandboxed iframe or a `data:` URL.
  // It is a real value, it is not an origin we trust, and it must never match
  // the "absent" branch above.
  const normalised = normaliseOrigin(origin);
  if (normalised === null) return 'forbidden';

  return policy.allowed.some((candidate) => normaliseOrigin(candidate) === normalised)
    ? 'allowed'
    : 'forbidden';
}

/**
 * `https://Atrium.test:443/` → `https://atrium.test`. Comparing raw strings
 * would make a trailing slash or a capital letter into a security decision.
 */
export function normaliseOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return null;
  try {
    const url = new URL(trimmed);
    if (!url.protocol || !url.host) return null;
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}
