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

  it('evicts the least recently seen key, not the most', () => {
    const time = clock();
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, now: time.now, maxKeys: 2 });

    throttle.attempt('a');
    throttle.attempt('b');
    // Touching "a" makes "b" the stale one.
    throttle.attempt('a');
    throttle.attempt('c');

    expect(throttle.attempt('a')).toBe(false);
    expect(throttle.attempt('b')).toBe(true);
  });
});
