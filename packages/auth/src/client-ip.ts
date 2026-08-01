/**
 * Where a request came from, for rate limiting.
 *
 * This is a *trust* question before it is a parsing question. `X-Forwarded-For`
 * is a header, and a header is whatever the client typed unless something in
 * front of us rewrote it. There are exactly three honest answers, and round 2
 * collapsed two of them into one:
 *
 *  - **`unconfigured`** — nobody has said what is in front of this process, so
 *    there is no address we can believe. `clientIp` returns null and the IP
 *    dimension is genuinely absent. This is a state to *leave*, not to run in:
 *    a process with a listening port must not be in it in production, and both
 *    entrypoints refuse to start that way (`apps/server/src/env.ts`,
 *    `apps/web/lib/env.ts`).
 *  - **`socket`** (`ATRIUM_TRUSTED_PROXY_HOPS=0`) — nothing is in front of this
 *    process, so the socket's peer address *is* the caller. Forwarded headers
 *    are ignored entirely: reading a spoofable header would let one attacker
 *    look like a million different callers, which is worse than no dimension.
 *    Round 2 read this as "dimension disabled", which is what left the compose
 *    deployment with a limiter counting nothing.
 *  - **`forwarded`** (`ATRIUM_TRUSTED_PROXY_HOPS=N`, N ≥ 1) — behind N trusted
 *    proxies, the caller is the Nth entry counted **from the right** of
 *    `X-Forwarded-For`. The rightmost entry was appended by our own edge and is
 *    the only one nobody outside can forge; counting from the left takes
 *    whatever the caller prefixed.
 *
 * Atrium's deployment (init.md, issue #18) is one node. With a reverse proxy in
 * front — which is also how TLS gets terminated — that is `hops=1`; with the
 * ports published directly, as `docker-compose.yml` does out of the box, it is
 * `hops=0`.
 *
 * ## The caller that has no socket to look at
 *
 * `socket` only produces an address for a caller that can supply one. The
 * WebSocket upgrade can (`request.socket.remoteAddress`). A Next.js Server
 * Action cannot: `headers()` is the whole request as far as it is concerned, and
 * Next sets `x-forwarded-for` from the peer address **only when the client sent
 * none** (`??=` in `base-server.js`). So a present header there is either the
 * peer address or entirely attacker-written, with no way to tell which — which
 * is why `socket` reads no headers at all rather than guessing. On that path the
 * dimension is inert until a proxy is put in front and `hops` says so, and
 * `apps/web` says that out loud at startup instead of leaving it as a footnote.
 */

/** What is in front of this process, and therefore what may be believed. */
export type ProxyStrategy =
  /** Nobody said. No address is trustworthy; callers get null. */
  | { kind: 'unconfigured' }
  /** Nothing in front: the socket's peer address is the caller. */
  | { kind: 'socket' }
  /** N trusted proxies in front, counted from the right of the chain. */
  | { kind: 'forwarded'; hops: number };

export interface ClientIpOptions {
  /** What may be believed. Defaults to `unconfigured`, which believes nothing. */
  strategy?: ProxyStrategy;
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

/** The most hops we will believe. Past this, the value is a typo, not a topology. */
const maxHops = 8;

/**
 * Read `ATRIUM_TRUSTED_PROXY_HOPS` into a strategy.
 *
 * Unset, blank, or unparseable is `unconfigured` — deliberately *not* the same
 * as `0`. "Nobody said" and "I said there is no proxy" are different claims, and
 * only the second one is a configuration. A negative number is a typo for a
 * count and is treated as nobody having said anything, which is the state that
 * refuses to boot in production rather than the one that quietly works.
 */
export function trustedProxyStrategy(env: NodeJS.ProcessEnv = process.env): ProxyStrategy {
  const raw = env.ATRIUM_TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return { kind: 'unconfigured' };

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw || parsed < 0) {
    return { kind: 'unconfigured' };
  }
  if (parsed === 0) return { kind: 'socket' };
  return { kind: 'forwarded', hops: Math.min(parsed, maxHops) };
}

/** True when this process has been told what is in front of it. */
export function hasProxyStrategy(env: NodeJS.ProcessEnv = process.env): boolean {
  return trustedProxyStrategy(env).kind !== 'unconfigured';
}

/**
 * The caller's address, or null when nothing trustworthy says.
 *
 * Null is a real answer and callers must handle it — a throttle that treats
 * "unknown" as a shared bucket is fine (everyone anonymous shares a limit), but
 * one that treats it as "no limit" is not.
 */
export function clientIp(headers: Headers, options: ClientIpOptions = {}): string | null {
  const strategy = options.strategy ?? { kind: 'unconfigured' };
  const socket = normalise(options.socketAddress ?? null);

  if (strategy.kind === 'unconfigured') return null;
  if (strategy.kind === 'socket') return socket;

  for (const name of options.headerNames ?? forwardedHeaderNames) {
    const value = headers.get(name);
    if (!value) continue;
    const chain = value
      .split(',')
      .map((entry) => normalise(entry))
      .filter((entry): entry is string => entry !== null);
    if (chain.length === 0) continue;

    /**
     * Count from the right: entry -1 was written by our own proxy, -2 by the
     * one in front of it, and so on. Anything further left is caller-supplied.
     *
     * A chain **shorter** than the configured hop count is not a chain we can
     * read. Round 2 clamped the index to 0 and took the leftmost entry, which is
     * precisely the caller-supplied one: a client sending a single-entry header
     * to a `hops=1` deployment whose proxy did not in fact append got to name
     * its own address. Now that case falls back to the socket, and to null if
     * there is no socket — an absent dimension rather than a forged one.
     */
    const index = chain.length - strategy.hops;
    if (index < 0) break;
    const candidate = chain[index];
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
