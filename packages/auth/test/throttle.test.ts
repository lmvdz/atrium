import { describe, expect, it } from 'vitest';
import { createThrottle } from '../src/throttle.js';

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
