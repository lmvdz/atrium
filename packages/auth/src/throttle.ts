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
 * In process, and deliberately so: init.md budgets exactly one application
 * server, so a Map is the whole distributed system. If Atrium ever runs more than
 * one web process this must move to Postgres or Redis — the interface is narrow
 * enough that the swap is local to this file.
 */

export interface ThrottleOptions {
  /** Attempts allowed inside the window. */
  limit: number;
  windowMs: number;
  /** Injected for tests; production reads the real clock. */
  now?: () => number;
  /**
   * How many distinct keys to track before evicting the least recently seen.
   * A bound matters: the key is usually an email address, and an attacker
   * choosing a fresh one each time must not be able to grow this without limit.
   */
  maxKeys?: number;
}

export interface Throttle {
  /** Records an attempt. False means the caller is over the limit. */
  attempt: (key: string) => boolean;
  /** Forgets a key — call it after a success, so a typo is not held against you. */
  reset: (key: string) => void;
  readonly size: number;
}

export function createThrottle(options: ThrottleOptions): Throttle {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  // Insertion order is eviction order, and re-inserting on every attempt keeps
  // it least-recently-used rather than least-recently-created.
  const hits = new Map<string, number[]>();

  return {
    attempt(key) {
      const at = now();
      const cutoff = at - windowMs;

      const previous = (hits.get(key) ?? []).filter((time) => time > cutoff);
      hits.delete(key);

      if (previous.length >= limit) {
        // A refused attempt still counts. Otherwise a caller could hold the
        // window open at exactly the limit forever and get a free attempt the
        // instant the oldest one aged out; recording refusals means the door
        // only reopens after a genuinely quiet window.
        hits.set(key, [...previous.slice(1), at]);
        evict();
        return false;
      }

      hits.set(key, [...previous, at]);
      evict();
      return true;
    },

    reset(key) {
      hits.delete(key);
    },

    get size() {
      return hits.size;
    },
  };

  function evict(): void {
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next();
      if (oldest.done) return;
      hits.delete(oldest.value);
    }
  }
}
