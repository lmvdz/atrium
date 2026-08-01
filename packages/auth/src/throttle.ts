/**
 * A small in-process rate limiter.
 *
 * Better Auth rate-limits its *HTTP* endpoints. Atrium's sign-in, sign-up and
 * resend flows are Server Actions that call `auth.api.*` directly, which is the
 * right way to do them — no token near the browser, works without JavaScript —
 * but it means those calls never pass through that middleware. Without something
 * here, an unauthenticated form post could brute-force a password or mail-bomb
 * an address as fast as the network allows.
 *
 * ## Scope, stated plainly
 *
 * In process, and deliberately so: init.md and issue #18 budget exactly one
 * application server, so a Map is the whole distributed system. Two honest
 * consequences follow and neither is a bug:
 *
 *  - **A restart resets every counter.** An attacker who can make the process
 *    restart can clear the limits. On a single-node deploy that is the same
 *    attacker who can take the service down, so it buys them nothing new.
 *  - **A second web process would double every limit.** The moment issue #18's
 *    deployment stops being one node, this must move to Postgres or Redis. The
 *    interface below is narrow on purpose so the swap is local to this file.
 *
 * The HTTP surface is covered separately: Better Auth's own `rateLimit` config
 * is pinned in `auth.ts`, and `mounted.ts` refuses to expose the endpoints that
 * would otherwise be an unthrottled way round this file.
 */

import { unresolvedIpKey } from './client-ip.js';

export interface ThrottleOptions {
  /** Attempts allowed inside the window. */
  limit: number;
  windowMs: number;
  /** Injected for tests; production reads the real clock. */
  now?: () => number;
  /**
   * How many distinct keys to track before evicting. A bound matters: the key
   * is derived from attacker-controlled input, and somebody choosing a fresh
   * one each time must not be able to grow this without limit.
   */
  maxKeys?: number;
  /**
   * How many recorded attempts inside the window make an entry *protected* from
   * eviction. Defaults to `limit`, i.e. an entry that is currently over its
   * limit.
   *
   * This exists because plain LRU eviction is itself an attack: flood the map
   * with junk keys and the entry recording somebody's twenty failed passwords
   * ages out, handing the attacker a fresh counter. Protected entries are
   * evicted only when there is nothing else left to evict, so restoring a
   * blocked key costs the attacker `maxKeys` protected entries of their own —
   * each of which is a key they are themselves blocked on.
   */
  protectAfter?: number;
}

export interface Throttle {
  /** Records an attempt. False means the caller is over the limit. */
  attempt: (key: string) => boolean;
  /** Records attempts on several keys at once; false if *any* is over. */
  attemptAll: (keys: readonly (string | null | undefined)[]) => boolean;
  /** Forgets a key — call it after a success, so a typo is not held against you. */
  reset: (key: string) => void;
  /** Forgets several keys. Mirrors `attemptAll`. */
  resetAll: (keys: readonly (string | null | undefined)[]) => void;
  readonly size: number;
}

/**
 * One attempt, recorded against a named key **and** against the caller's
 * address. False means refused.
 *
 * This lives here rather than in the Server Action that calls it because of what
 * round 3's gauntlet found in that Server Action: `const byIp = ip === null ?
 * true : ipLimiters[kind].attempt(ip)`. A null address — which is every caller
 * on the Server Action path under `ATRIUM_TRUSTED_PROXY_HOPS=0`, i.e. every
 * caller in the deployment round 3 shipped — was not merely unmeasured, it was
 * *allowed*. The IP dimension was a pass.
 *
 * A rate limiter has three honest answers to "who is this?", not two: this
 * caller, that caller, and one I cannot tell apart from the others. The third
 * one is a bucket (`unresolvedIpKey`), which is what Better Auth's own limiter
 * does with the same question (`NO_TRUSTED_IP_KEY`), so the two degrade the same
 * way. Coarse, global, and never a bypass.
 *
 * Both counters are always recorded, even when the first already refuses:
 * otherwise tripping the cheap dimension would shield the expensive one.
 */
export function attemptWithIp(
  limiters: { byKey: Throttle; byIp: Throttle },
  key: string,
  ip: string | null,
): boolean {
  const byKey = limiters.byKey.attempt(key);
  const byIp = limiters.byIp.attempt(ip ?? unresolvedIpKey);
  return byKey && byIp;
}

export function createThrottle(options: ThrottleOptions): Throttle {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const protectAfter = options.protectAfter ?? limit;
  // Insertion order is eviction order, and re-inserting on every attempt keeps
  // it least-recently-used rather than least-recently-created.
  const hits = new Map<string, number[]>();

  function record(key: string): boolean {
    const at = now();
    const cutoff = at - windowMs;

    const previous = (hits.get(key) ?? []).filter((time) => time > cutoff);
    hits.delete(key);

    let allowed = true;
    if (previous.length >= limit) {
      // A refused attempt still counts. Otherwise a caller could hold the
      // window open at exactly the limit forever and get a free attempt the
      // instant the oldest one aged out; recording refusals means the door
      // only reopens after a genuinely quiet window.
      hits.set(key, [...previous.slice(1), at]);
      allowed = false;
    } else {
      hits.set(key, [...previous, at]);
    }

    evict(at);
    return allowed;
  }

  return {
    attempt: record,

    attemptAll(keys) {
      // Every dimension is recorded even when an earlier one already refused:
      // a caller must not be able to dodge the IP counter by first tripping the
      // email counter. `reduce` rather than `every`, which short-circuits.
      return keys
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
        .reduce((allowed, key) => record(key) && allowed, true);
    },

    reset(key) {
      hits.delete(key);
    },

    resetAll(keys) {
      for (const key of keys) if (key) hits.delete(key);
    },

    get size() {
      return hits.size;
    },
  };

  function evict(at: number): void {
    const cutoff = at - windowMs;
    while (hits.size > maxKeys) {
      const victim = leastValuableKey(cutoff);
      if (victim === null) return;
      hits.delete(victim);
    }
  }

  /**
   * The oldest *unprotected* key, or — if every key is protected — the oldest
   * key of any kind, because the memory bound is not negotiable.
   */
  function leastValuableKey(cutoff: number): string | null {
    let oldestOverall: string | null = null;
    for (const [key, times] of hits) {
      if (oldestOverall === null) oldestOverall = key;
      const recent = times.filter((time) => time > cutoff).length;
      if (recent < protectAfter) return key;
    }
    return oldestOverall;
  }
}
