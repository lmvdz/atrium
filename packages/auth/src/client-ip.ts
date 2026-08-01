/**
 * Where a request came from, for rate limiting.
 *
 * This is a *trust* question before it is a parsing question. `X-Forwarded-For`
 * is a header, and a header is whatever the client typed unless something in
 * front of us rewrote it. So:
 *
 *  - With no trusted proxy configured (`trustProxyHops: 0`, the default) the
 *    forwarded headers are ignored entirely and only the socket address counts.
 *    Reading a spoofable header would let one attacker look like a million
 *    different callers, which is worse than no IP dimension at all.
 *  - Behind N trusted proxies, the client address is the Nth entry counted
 *    **from the right** of `X-Forwarded-For` — the rightmost entry was appended
 *    by our own edge and is the only one nobody outside can forge. Counting
 *    from the left takes whatever the caller prefixed.
 *
 * Atrium's deployment (init.md, issue #18) is one node behind one reverse proxy,
 * so `ATRIUM_TRUSTED_PROXY_HOPS=1` is the production setting and 0 is right for
 * `pnpm dev`, where Next is the edge.
 */

export interface ClientIpOptions {
  /**
   * How many proxies in front of this process are trusted to have appended to
   * `X-Forwarded-For`. 0 means "trust no header", which is the safe default.
   */
  trustProxyHops?: number;
  /** The socket's remote address, when the caller has one (the ws upgrade does). */
  socketAddress?: string | null | undefined;
  /**
   * Which headers carry the forwarded chain, most-trusted first. Matches the
   * list handed to Better Auth's `advanced.ipAddress.ipAddressHeaders`, so the
   * library's own limiter and ours agree about who is calling.
   */
  headerNames?: readonly string[];
}

/** The forwarded headers we read, in order. */
export const forwardedHeaderNames = ['x-forwarded-for', 'x-real-ip'] as const;

/** Reads `ATRIUM_TRUSTED_PROXY_HOPS`, clamped to something sane. */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ATRIUM_TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 8);
}

/**
 * The caller's address, or null when nothing trustworthy says.
 *
 * Null is a real answer and callers must handle it — a throttle that treats
 * "unknown" as a shared bucket is fine (everyone anonymous shares a limit), but
 * one that treats it as "no limit" is not.
 */
export function clientIp(headers: Headers, options: ClientIpOptions = {}): string | null {
  const hops = options.trustProxyHops ?? 0;
  const socket = normalise(options.socketAddress ?? null);

  if (hops <= 0) return socket;

  for (const name of options.headerNames ?? forwardedHeaderNames) {
    const value = headers.get(name);
    if (!value) continue;
    const chain = value
      .split(',')
      .map((entry) => normalise(entry))
      .filter((entry): entry is string => entry !== null);
    if (chain.length === 0) continue;

    // Count from the right: entry -1 was written by our own proxy, -2 by the
    // one in front of it, and so on. Anything further left is caller-supplied.
    const index = chain.length - hops;
    const candidate = chain[Math.max(index, 0)];
    if (candidate) return candidate;
  }

  return socket;
}

/** Trims, unwraps `[::1]:443`-style forms, and rejects empties. */
function normalise(value: string | null): string | null {
  if (!value) return null;
  let address = value.trim();
  if (!address) return null;

  // `::ffff:127.0.0.1` is the IPv4-mapped form Node reports on dual-stack
  // sockets; collapsing it keeps one caller from occupying two buckets.
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);

  // `[2001:db8::1]:1234` → `2001:db8::1`
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(address);
  if (bracketed?.[1]) return bracketed[1];

  // `203.0.113.5:1234` → `203.0.113.5` (never split a bare IPv6 address).
  if (address.includes(':') && !address.slice(address.indexOf(':') + 1).includes(':')) {
    const [host] = address.split(':');
    if (host) address = host;
  }

  return address || null;
}
