import { describe, expect, it } from 'vitest';
import { unresolvedIpKey } from '../src/client-ip.js';
import { attemptWithIp, createThrottle } from '../src/throttle.js';

function clock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe('createThrottle', () => {
  it('allows up to the limit and then refuses', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 3, windowMs: 60_000, now: time.now });

    expect(throttle.attempt('ada@example.com')).toBe(true);
    expect(throttle.attempt('ada@example.com')).toBe(true);
    expect(throttle.attempt('ada@example.com')).toBe(true);
    expect(throttle.attempt('ada@example.com')).toBe(false);
  });

  it('counts each key separately', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, now: time.now });

    expect(throttle.attempt('ada@example.com')).toBe(true);
    expect(throttle.attempt('grace@example.com')).toBe(true);
    expect(throttle.attempt('ada@example.com')).toBe(false);
  });

  it('lets the window slide', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 2, windowMs: 60_000, now: time.now });

    expect(throttle.attempt('ada')).toBe(true);
    time.advance(30_000);
    expect(throttle.attempt('ada')).toBe(true);

    // The first attempt has now aged out, so there is room for another — the
    // window slides rather than resetting on a fixed tick.
    time.advance(31_000);
    expect(throttle.attempt('ada')).toBe(true);
    expect(throttle.attempt('ada')).toBe(false);
  });

  it('keeps refusing a caller who keeps hammering', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 1, windowMs: 10_000, now: time.now });

    expect(throttle.attempt('ada')).toBe(true);
    for (let i = 0; i < 20; i += 1) {
      time.advance(400);
      expect(throttle.attempt('ada')).toBe(false);
    }
    // Only after a full quiet window does it open again.
    time.advance(10_001);
    expect(throttle.attempt('ada')).toBe(true);
  });

  it('forgets a key on request, so a success clears a typo', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, now: time.now });

    expect(throttle.attempt('ada')).toBe(true);
    expect(throttle.attempt('ada')).toBe(false);
    throttle.reset('ada');
    expect(throttle.attempt('ada')).toBe(true);
  });

  it('cannot be grown without bound by inventing keys', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 5, windowMs: 60_000, now: time.now, maxKeys: 10 });

    for (let i = 0; i < 500; i += 1) throttle.attempt(`attacker-${i}`);
    expect(throttle.size).toBeLessThanOrEqual(10);
  });

  it('evicts the least recently seen unprotected key, not the most', () => {
    const time = clock();
    const throttle = createThrottle({
      limit: 1,
      windowMs: 60_000,
      now: time.now,
      maxKeys: 2,
      // Nothing is protected here, so this is plain LRU.
      protectAfter: 99,
    });

    throttle.attempt('a');
    throttle.attempt('b');
    // Touching "a" makes "b" the stale one.
    throttle.attempt('a');
    throttle.attempt('c');

    expect(throttle.attempt('a')).toBe(false);
    expect(throttle.attempt('b')).toBe(true);
  });
});

describe('eviction cannot be used to clear somebody else’s counter', () => {
  it('keeps a blocked key while there is any unblocked key to drop instead', () => {
    const time = clock();
    // Round 1's throttle was plain LRU: flood it with fresh keys and the entry
    // holding a victim's failed attempts aged out, handing the attacker a clean
    // counter for free. The victim's entry is now protected.
    const throttle = createThrottle({ limit: 3, windowMs: 60_000, now: time.now, maxKeys: 8 });

    expect(throttle.attempt('victim@example.com')).toBe(true);
    expect(throttle.attempt('victim@example.com')).toBe(true);
    expect(throttle.attempt('victim@example.com')).toBe(true);
    expect(throttle.attempt('victim@example.com')).toBe(false);

    for (let i = 0; i < 2000; i += 1) throttle.attempt(`flood-${i}`);

    expect(throttle.size).toBeLessThanOrEqual(8);
    expect(throttle.attempt('victim@example.com')).toBe(false);
  });

  it('still honours the memory bound when every entry is protected', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, now: time.now, maxKeys: 5 });

    // Two attempts each: the first allowed, the second refused and protective.
    for (let i = 0; i < 50; i += 1) {
      throttle.attempt(`blocked-${i}`);
      throttle.attempt(`blocked-${i}`);
    }
    expect(throttle.size).toBeLessThanOrEqual(5);
  });

  it('unprotects a key once its window has gone quiet', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 2, windowMs: 10_000, now: time.now, maxKeys: 1 });

    throttle.attempt('old');
    throttle.attempt('old');
    // "old" is at its limit and therefore protected...
    throttle.attempt('new');
    expect(throttle.size).toBe(1);

    // ...until its attempts age out, at which point it is ordinary again.
    time.advance(11_000);
    throttle.attempt('newer');
    expect(throttle.size).toBe(1);
  });
});

describe('several dimensions at once', () => {
  it('refuses when any one key is over the limit', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 2, windowMs: 60_000, now: time.now });

    expect(throttle.attemptAll(['email:ada', 'ip:203.0.113.5'])).toBe(true);
    expect(throttle.attemptAll(['email:ada', 'ip:203.0.113.5'])).toBe(true);
    // The email key is spent; a different address from the same IP is still
    // refused because the IP key counted every one of those attempts too.
    expect(throttle.attemptAll(['email:grace', 'ip:203.0.113.5'])).toBe(false);
  });

  it('records every dimension even when an earlier one already refused', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, now: time.now });

    expect(throttle.attemptAll(['email:ada', 'ip:1.2.3.4'])).toBe(true);
    // Without this, tripping the cheap key first would shield the expensive one.
    expect(throttle.attemptAll(['email:ada', 'ip:5.6.7.8'])).toBe(false);
    expect(throttle.attempt('ip:5.6.7.8')).toBe(false);
  });

  it('ignores empty dimensions rather than bucketing them together', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, now: time.now });

    expect(throttle.attemptAll(['email:ada', null, undefined, ''])).toBe(true);
    expect(throttle.size).toBe(1);
  });

  it('clears every dimension on success', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, now: time.now });

    throttle.attemptAll(['email:ada', 'ip:1.2.3.4']);
    throttle.resetAll(['email:ada', 'ip:1.2.3.4']);
    expect(throttle.size).toBe(0);
  });
});

/**
 * Blocking finding 2, half two: what an unresolvable caller costs.
 *
 * Round 3's Server Action read `const byIp = ip === null ? true : …`. Under the
 * deployment it shipped — `ATRIUM_TRUSTED_PROXY_HOPS=0`, where a Next Server
 * Action has no peer address to see — that is *every* caller, so the IP
 * dimension was not absent, it was a pass. Both critics found it, from opposite
 * ends.
 *
 * The decision lives in this package rather than in the `'use server'` module
 * precisely so these assertions can exist at all.
 */
describe('attemptWithIp — a caller nobody can place is counted, not excused', () => {
  const pair = (limit: number) => ({
    byKey: createThrottle({ limit, windowMs: 60_000 }),
    byIp: createThrottle({ limit, windowMs: 60_000 }),
  });

  /**
   * Catches: reintroducing `ip === null ? true : …` in `attemptWithIp` (or in
   * `apps/web/app/(auth)/actions.ts`'s `allow`). With that, an unresolvable
   * caller never touches the address counter and the third attempt succeeds.
   */
  it('shares one bucket rather than skipping the dimension', () => {
    const limiters = pair(2);
    expect(attemptWithIp(limiters, 'email:ada', null)).toBe(true);
    expect(attemptWithIp(limiters, 'email:grace', null)).toBe(true);
    // Two different addresses would each have their own counter. Two callers
    // nobody can tell apart share one, and it is now spent.
    expect(attemptWithIp(limiters, 'email:hopper', null)).toBe(false);
  });

  it('leaves a caller it *can* place with a counter of their own', () => {
    const limiters = pair(1);
    expect(attemptWithIp(limiters, 'email:ada', null)).toBe(true);
    expect(attemptWithIp(limiters, 'email:grace', null)).toBe(false);
    // …and the shared bucket being spent does not spend anybody else's.
    expect(attemptWithIp(limiters, 'email:hopper', '203.0.113.5')).toBe(true);
  });

  it('records the address dimension even when the key dimension already refused', () => {
    // Catches: short-circuiting (`byKey && limiters.byIp.attempt(...)`), which
    // would let a caller dodge the address counter by burning the cheaper one.
    const limiters = pair(1);
    expect(attemptWithIp(limiters, 'email:ada', '203.0.113.5')).toBe(true);
    expect(attemptWithIp(limiters, 'email:ada', '198.51.100.7')).toBe(false);
    // The second address was counted, despite the email having already refused.
    expect(attemptWithIp(limiters, 'email:grace', '198.51.100.7')).toBe(false);
  });

  it('buckets an unresolvable caller under a key no address can collide with', () => {
    // Catches: changing `unresolvedIpKey` to something an X-Forwarded-For could
    // contain, which would let a caller choose the global bucket — or poison it.
    expect(unresolvedIpKey).toContain(':');
    const limiters = pair(1);
    expect(attemptWithIp(limiters, 'k', null)).toBe(true);
    expect(attemptWithIp(limiters, 'k2', '203.0.113.5')).toBe(true);
  });
});
