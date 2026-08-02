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
 *    `apps/web/lib/env.ts`). Both gates check the **parsed** strategy, not the
 *    presence of the variable — round 3's server gate checked presence only, so
 *    `hops=lots` booted a production process whose parser had already degraded
 *    to `unconfigured`.
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
 * `docker-compose.yml` ships a reverse proxy in front of both processes and
 * `ATRIUM_TRUSTED_PROXY_HOPS=1`, because a deployment where the dimension is
 * inert is a deployment where it does not exist — see the compose header.
 *
 * ## The caller that has no socket to look at
 *
 * `socket` only produces an address for a caller that can supply one. The
 * WebSocket upgrade can (`request.socket.remoteAddress`). A Next.js Server
 * Action cannot: `headers()` is the whole request as far as it is concerned, and
 * Next sets `x-forwarded-for` from the peer address **only when the client sent
 * none** (`??=` in `base-server.js`). So a present header there is either the
 * peer address or entirely attacker-written, with no way to tell which — which
 * is why `socket` reads no headers at all rather than guessing.
 *
 * That leaves a null address on that path, and **null must never be read as
 * "allow"**. Round 3 shipped exactly that: compose set `hops=0`, `callerIp()`
 * returned null, and the per-address limiter skipped the caller entirely. The
 * answer is `unresolvedIpKey` below: an unresolvable caller is counted against
 * one shared bucket, so the dimension degrades from "per address" to "one global
 * cap" instead of degrading to nothing.
 *
 * ## Sharing the answer with Better Auth
 *
 * Better Auth resolves its own IP for its own limiter (`getIp` in
 * `@better-auth/core/utils/ip`). Two limiters that disagree about who is calling
 * are two limiters, so the strategy is handed to it as
 * `advanced.ipAddress.ipAddressHeaders` **and**
 * `advanced.ipAddress.trustedProxies` (`auth.ts`, `ipHeadersFor` /
 * `trustedProxiesFor`). When trusted proxy CIDRs are configured
 * (`ATRIUM_TRUSTED_PROXY_CIDRS`) this file uses the library's algorithm —
 * right-to-left until the first hop that is not a trusted proxy — rather than a
 * second one of its own, and `client-ip.test.ts` asserts the two agree on the
 * same chains.
 */

/** What is in front of this process, and therefore what may be believed. */
export type ProxyStrategy =
  /** Nobody said. No address is trustworthy; callers get null. */
  | { kind: 'unconfigured' }
  /** Nothing in front: the socket's peer address is the caller. */
  | { kind: 'socket' }
  /**
   * N trusted proxies in front, counted from the right of the chain.
   *
   * `trustedProxies`, when present, names those proxies by address or CIDR and
   * switches the read to Better Auth's own rule: walk the chain from the right
   * and take the first entry that is not one of them. It is strictly better
   * than a count — a proxy that fails to append cannot shift the index — and it
   * is what the library is given, so the two cannot diverge.
   */
  | { kind: 'forwarded'; hops: number; trustedProxies?: readonly string[] };

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

/**
 * The bucket every caller whose address could not be resolved shares.
 *
 * Not a bypass and not a per-caller counter: one bucket for everybody the
 * deployment cannot tell apart. A limiter that skipped them would be the
 * fail-open round 3's gauntlet found (`hops=0` + Server Actions ⇒ null ⇒
 * allowed); a limiter that invented an address for them would be the forged
 * dimension this file refuses. Counting them together is the third answer: the
 * cap is real, it is global, and the way to get a per-address cap back is to put
 * a proxy in front and say so with `ATRIUM_TRUSTED_PROXY_HOPS`.
 */
export const unresolvedIpKey = 'ip:unresolved';

/** The most hops we will believe. Past this, the value is a typo, not a topology. */
const maxHops = 8;

/**
 * Read `ATRIUM_TRUSTED_PROXY_HOPS` (and `ATRIUM_TRUSTED_PROXY_CIDRS`) into a
 * strategy.
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

  const trustedProxies = parseTrustedProxies(env.ATRIUM_TRUSTED_PROXY_CIDRS);
  return {
    kind: 'forwarded',
    hops: Math.min(parsed, maxHops),
    ...(trustedProxies.length > 0 ? { trustedProxies } : {}),
  };
}

/**
 * The proxy addresses/CIDRs, comma separated, with unparseable entries dropped.
 *
 * Dropping rather than throwing matches Better Auth, which warns and ignores an
 * invalid entry. Dropping *all* of them leaves the list empty, which falls back
 * to the hop count — coarser, never laxer.
 */
export function parseTrustedProxies(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && parseCidr(entry) !== null);
}

/** True when this process has been told what is in front of it. */
export function hasProxyStrategy(env: NodeJS.ProcessEnv = process.env): boolean {
  return trustedProxyStrategy(env).kind !== 'unconfigured';
}

/**
 * The caller's address, or null when nothing trustworthy says.
 *
 * Null is a real answer and callers must handle it — but only one way: as a
 * shared bucket (`unresolvedIpKey`), never as "no limit". See the note at the
 * top of the file.
 */
export function clientIp(headers: Headers, options: ClientIpOptions = {}): string | null {
  const strategy = options.strategy ?? { kind: 'unconfigured' };
  const socket = normalise(options.socketAddress ?? null);

  if (strategy.kind === 'unconfigured') return null;
  if (strategy.kind === 'socket') return socket;

  for (const name of options.headerNames ?? forwardedHeaderNames) {
    const value = headers.get(name);
    if (!value) continue;

    const found =
      strategy.trustedProxies && strategy.trustedProxies.length > 0
        ? firstUntrustedHop(value, strategy.trustedProxies)
        : nthFromTheRight(value, strategy.hops);
    if (found) return found;

    /**
     * A header that is present and unreadable stops the search rather than
     * falling through to the next one. The chain being unreadable — too short
     * for the hop count, or every hop a trusted proxy — means this deployment's
     * description of itself does not match what arrived, and the *next* header
     * is a strictly less trustworthy way to answer the same question.
     */
    break;
  }

  return socket;
}

/**
 * Count from the right: entry -1 was written by our own proxy, -2 by the one in
 * front of it, and so on. Anything further left is caller-supplied.
 *
 * A chain **shorter** than the configured hop count is not a chain we can read.
 * Round 2 clamped the index to 0 and took the leftmost entry, which is precisely
 * the caller-supplied one: a client sending a single-entry header to a `hops=1`
 * deployment whose proxy did not in fact append got to name its own address.
 * Now that case reads as unreadable — an absent dimension rather than a forged
 * one.
 */
function nthFromTheRight(value: string, hops: number): string | null {
  const chain = value
    .split(',')
    .map((entry) => normalise(entry))
    .filter((entry): entry is string => entry !== null);
  if (chain.length === 0) return null;

  const index = chain.length - hops;
  if (index < 0) return null;
  return chain[index] ?? null;
}

/**
 * Better Auth's rule, run on our side of the fence.
 *
 * Walk the chain from the right; every entry that is one of the configured
 * proxies is ours and is skipped; the first entry that is not is the caller. An
 * entry that is not a readable address at all aborts the whole header — a chain
 * we cannot parse is not a chain we can count from. Every hop being a trusted
 * proxy means the caller never appears in it, which is also unreadable.
 *
 * Kept deliberately identical to `getIPFromHeader` in
 * `@better-auth/core/utils/ip`, because the point of configuring
 * `trustedProxies` at all is that the library's limiter and this one bucket a
 * caller the same way. `client-ip.test.ts` asserts the agreement against the
 * library's own function rather than against this comment.
 */
function firstUntrustedHop(value: string, trustedProxies: readonly string[]): string | null {
  const chain = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (chain.length === 0) return null;

  const networks = trustedProxies
    .map(parseCidr)
    .filter((network): network is Cidr => network !== null);
  if (networks.length === 0) return null;

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index];
    const bytes = entry ? ipToBytes(entry) : null;
    if (!entry || !bytes) return null;
    if (networks.some((network) => withinCidr(bytes, network))) continue;
    return normalise(entry);
  }
  return null;
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

interface Cidr {
  bytes: Uint8Array;
  prefix: number;
}

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An address as raw bytes — 4 for IPv4, 16 for IPv6 — or null if unreadable. */
function ipToBytes(value: string): Uint8Array | null {
  const address = value.startsWith('[') ? (normalise(value) ?? value) : value;

  const v4 = ipv4Pattern.exec(address);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return Uint8Array.from(octets);
  }

  // IPv4-mapped IPv6 collapses to its IPv4 form, so one caller is one bucket.
  if (address.toLowerCase().startsWith('::ffff:')) {
    const mapped = ipToBytes(address.slice('::ffff:'.length));
    if (mapped?.length === 4) return mapped;
  }

  return ipv6ToBytes(address);
}

function ipv6ToBytes(address: string): Uint8Array | null {
  if (!address.includes(':')) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] ?? '';
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const parsed = Number.parseInt(group, 16);
    bytes[index * 2] = (parsed >> 8) & 0xff;
    bytes[index * 2 + 1] = parsed & 0xff;
  }
  return bytes;
}

/** `203.0.113.0/24`, `10.0.0.1`, `fd00::/8`. Null when it is none of those. */
function parseCidr(value: string): Cidr | null {
  const slash = value.lastIndexOf('/');
  const bytes = ipToBytes(slash === -1 ? value : value.slice(0, slash));
  if (!bytes) return null;

  const maxBits = bytes.length * 8;
  if (slash === -1) return { bytes, prefix: maxBits };

  const suffix = value.slice(slash + 1);
  if (!/^\d+$/.test(suffix)) return null;
  const prefix = Number(suffix);
  return prefix <= maxBits ? { bytes, prefix } : null;
}

function withinCidr(address: Uint8Array, network: Cidr): boolean {
  if (address.length !== network.bytes.length) return false;
  let remaining = network.prefix;
  for (let index = 0; index < address.length && remaining > 0; index += 1) {
    const take = remaining >= 8 ? 8 : remaining;
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if (((address[index] ?? 0) & mask) !== ((network.bytes[index] ?? 0) & mask)) return false;
    remaining -= 8;
  }
  return true;
}
