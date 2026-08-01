import { describe, expect, it, vi } from 'vitest';
import { describeUnknown, guardedErrorLog, toReportableError } from '../src/errors.js';

/**
 * The one primitive the round-9 class fix rests on, tested directly.
 *
 * Five call sites across two packages now depend on `describeUnknown` being
 * total and on `guardedErrorLog` swallowing everything a logger can do. Each of
 * those sites has its own test asserting its own guarantee — the sweep's counter
 * advancing, the resolver's `return null`, the invitation's `APIError` — and
 * every one of them proves the property *through* several layers of server.
 *
 * That is the right way round for the guarantees. It is the wrong way round for
 * the helper: a defect here shows up as five confusing failures somewhere else,
 * and a *gap* here shows up as nothing at all. So the helper is pinned by value
 * against each hostile shape, one assertion per shape, with nothing else in the
 * frame.
 *
 * Catches: `undescribable-describer` in `scripts/mutation-ledger.mjs` — the
 * pre-round-9 `(value as Error).message ?? String(value)` — which fails most of
 * the cases below directly rather than through a timeout five files away.
 */

/** Reading `message` is the trap. The round-8-delta shape. */
function throwingMessageGetter(): unknown {
  return {
    get message(): string {
      throw new Error('reading this is itself a failure');
    },
  };
}

/** No `toString`, no `Symbol.toPrimitive`, no prototype at all. */
function nullPrototype(): unknown {
  return Object.create(null) as unknown;
}

/** Converting it to a primitive is the thing that throws. */
function hostilePrimitive(): unknown {
  return {
    [Symbol.toPrimitive]() {
      throw new Error('conversion refused');
    },
  };
}

/** Even `instanceof` runs code here, before any comparison happens. */
function hostilePrototypeChain(): unknown {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('no prototype for you');
      },
      get() {
        throw new Error('and no properties either');
      },
    },
  );
}

const hostileShapes = [
  ['an object whose message getter throws', throwingMessageGetter],
  ['a prototype-less object', nullPrototype],
  ['an object whose Symbol.toPrimitive throws', hostilePrimitive],
  ['a proxy that throws from getPrototypeOf and get', hostilePrototypeChain],
] as const;

describe('describeUnknown', () => {
  for (const [shape, make] of hostileShapes) {
    it(`returns a string for ${shape}`, () => {
      const described = describeUnknown(make());
      expect(typeof described).toBe('string');
      expect(described.length).toBeGreaterThan(0);
    });
  }

  it('uses the message of an ordinary Error, so the log still says something useful', () => {
    // The totality must not be bought by describing everything as "unknown" —
    // a describer that always returned a placeholder would pass every test
    // above and make every log in the repository useless.
    expect(describeUnknown(new Error('database is on fire'))).toBe('database is on fire');
  });

  it('describes ordinary primitives the way anyone would expect', () => {
    expect(describeUnknown('plain string')).toBe('plain string');
    expect(describeUnknown(42)).toBe('42');
    expect(describeUnknown(null)).toBe('null');
    expect(describeUnknown(undefined)).toBe('undefined');
  });
});

describe('toReportableError', () => {
  it('passes an Error through unchanged, identity included', () => {
    // Identity matters: the cleanup reporter hands this to an operator seam,
    // and a wrapped copy loses the `cause` chain and the original stack.
    const original = new Error('database is on fire');
    expect(toReportableError(original)).toBe(original);
  });

  for (const [shape, make] of hostileShapes) {
    it(`returns a real Error with a real message for ${shape}`, () => {
      const reportable = toReportableError(make());
      expect(reportable).toBeInstanceOf(Error);
      expect(typeof reportable.message).toBe('string');
      expect(reportable.message.length).toBeGreaterThan(0);
    });
  }
});

describe('guardedErrorLog', () => {
  it('emits the message and the fields when nothing is wrong', () => {
    // The control. A guard that swallowed everything would pass both tests
    // below and log nothing for the rest of the repository's life.
    const error = vi.fn();
    guardedErrorLog({ error })('something happened', () => ({ connectionId: 'c-1' }));
    expect(error).toHaveBeenCalledWith('something happened', { connectionId: 'c-1' });
  });

  it('swallows a logger that throws', () => {
    const log = guardedErrorLog({
      error: () => {
        throw new Error('log transport is gone');
      },
    });
    expect(() => log('something happened', () => ({}))).not.toThrow();
  });

  it('swallows a field builder that throws, which is why fields are a thunk', () => {
    /**
     * The half that is easy to lose. If the fields were a value rather than a
     * thunk, they would be built at the *call site* — outside the guard — and
     * the guard would protect the logger while the thing that feeds it stayed
     * exposed. That is the identical mistake round 7 made one line upstream of
     * its own crash guard, and round 8 made again in the sweep's log fields.
     */
    const error = vi.fn();
    const log = guardedErrorLog({ error });
    expect(() =>
      log('something happened', () => {
        throw new Error('building the fields failed');
      }),
    ).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
});
