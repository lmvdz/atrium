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

/**
 * A real `Error` whose `message` is not a string.
 *
 * **The round-9 delta's shape, and the reason this file grew a type assertion.**
 * `Error.prototype.message` is a plain writable property and `message` can be
 * redefined as a getter, so nothing stops one carrying a Symbol. Round 9
 * returned `value.message` directly: no throw, and `describeUnknown` — whose own
 * header promises a string — handed back a Symbol. A `.slice()` or a `.length`
 * one frame later would have thrown on a post-commit path, which is precisely
 * the class this module exists to close, arriving through the module that closes
 * it.
 *
 * `instanceof Error` is genuinely true here; this is not a decoy object.
 */
function errorWithMessage(message: unknown): unknown {
  const error = new Error('placeholder');
  Object.defineProperty(error, 'message', {
    get: () => message,
    configurable: true,
  });
  return error;
}

/** An `Error` whose `message` cannot be converted to a string either. */
function errorWithUndescribableMessage(): unknown {
  return errorWithMessage(
    Object.defineProperty(Object.create(null) as object, Symbol.toPrimitive, {
      value() {
        throw new Error('this message refuses conversion');
      },
    }),
  );
}

/**
 * A Proxy that *passes* `instanceof Error` and throws on every property read.
 *
 * The complement of `hostilePrototypeChain`, which fails `instanceof`: this one
 * takes the early return in both exported functions, so it is the shape that
 * proves the early returns are guarded rather than merely reachable.
 */
function proxiedError(): unknown {
  return new Proxy(new Error('never read'), {
    get() {
      throw new Error('no properties for you');
    },
  });
}

const hostileShapes = [
  ['an object whose message getter throws', throwingMessageGetter],
  ['a prototype-less object', nullPrototype],
  ['an object whose Symbol.toPrimitive throws', hostilePrimitive],
  ['a proxy that throws from getPrototypeOf and get', hostilePrototypeChain],
  ['a proxy that is an Error and throws from get', proxiedError],
  ['an Error whose message is a Symbol', () => errorWithMessage(Symbol('boom'))],
  ['an Error whose message is a number', () => errorWithMessage(42)],
  ['an Error whose message is null', () => errorWithMessage(null)],
  ['an Error whose message is an object', () => errorWithMessage({ nested: true })],
  ['an Error whose message cannot be converted', errorWithUndescribableMessage],
] as const;

describe('describeUnknown', () => {
  for (const [shape, make] of hostileShapes) {
    it(`returns a string for ${shape}`, () => {
      const described = describeUnknown(make());
      expect(typeof described).toBe('string');
      expect(described.length).toBeGreaterThan(0);
    });
  }

  /**
   * **The type, not the absence of a throw.**
   *
   * Round 9's `errors.test.ts` asserted `typeof === 'string'` and had no case
   * where the answer could be anything else — every shape it tested either threw
   * on the way to `message` or was not an `Error` at all, so the assertion was
   * pinned by the guard rather than by the coercion. These are the cases that
   * distinguish them: `describeUnknown` reaches the `instanceof Error` early
   * return, reads a `message` that is there and is not a string, and must still
   * come back with one.
   *
   * Each asserts the returned *type* and then that the return is not the raw
   * `message` by identity, rather than pinning a value: the defect was never a
   * wrong value — a Symbol message has no one right rendering — it was a wrong
   * type coming out of a function whose signature forbids one.
   *
   * Catches: `undescribable-describer` and `describer-returns-raw-message` in
   * `scripts/mutation-ledger.mjs`; the second is round 9's `return value.message`
   * exactly, and it fails only these.
   */
  const nonStringMessages: [string, unknown][] = [
    ['a Symbol', Symbol('boom')],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { nested: true }],
    ['an array', ['a', 'b']],
    ['a bigint', 10n],
    ['a function', () => 'not a message'],
  ];

  for (const [shape, message] of nonStringMessages) {
    it(`returns a string, not ${shape}, for an Error carrying ${shape} as its message`, () => {
      const described: unknown = describeUnknown(errorWithMessage(message));
      expect(typeof described).toBe('string');
      // The returned value is never the raw `message`, which is the whole
      // defect: `Object.is` rather than `toBe`, so a Symbol compares by identity
      // rather than being converted for the comparison.
      expect(Object.is(described, message)).toBe(false);
    });
  }

  it('describes a non-string message rather than discarding it', () => {
    // Totality must not be bought by a placeholder — the same argument the
    // ordinary-Error test below makes, for the coerced path.
    expect(describeUnknown(errorWithMessage(42))).toBe('42');
    expect(describeUnknown(errorWithMessage(Symbol('boom')))).toBe('Symbol(boom)');
  });

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
    it(`returns something that is an Error for ${shape}`, () => {
      // Split from the message assertion below on purpose: the two early returns
      // promise different things, and round 9's single loop hid that.
      expect(toReportableError(make())).toBeInstanceOf(Error);
    });
  }

  /**
   * **The early-return audit, which is the half round 9 did not do.**
   *
   * `toReportableError` has two returns and they carry different promises, so
   * asserting one thing about both is how a violation hides:
   *
   *  - the **constructed** return promises a real `Error` with a string message,
   *    because it builds one out of `describeUnknown`, which is now total in
   *    type as well as in throwing. Every shape that fails `instanceof` takes
   *    it.
   *  - the **pass-through** return promises identity and nothing more. It hands
   *    back the caller's own object because the cleanup reporter gives it to an
   *    operator seam, and a wrapped copy loses the `cause` chain and the
   *    original stack. That is a deliberate trade, and its consequence is that
   *    `.message` on the result is whatever the caller put there — so the
   *    reading of it must be guarded at the *use* site, which is what
   *    `org.ts`'s `logSafely` thunk does.
   *
   * Writing "returns a real Error with a real message" over both, as round 9
   * did, states a guarantee the pass-through does not make. These assert each
   * one separately, which is the same correction this round made to the boundary
   * checker's header: a claim is only worth having if its limits are true.
   */
  /** Shapes that fail `instanceof Error`, so the constructed return runs. */
  const constructed: [string, () => unknown][] = [
    ['an object whose message getter throws', throwingMessageGetter],
    ['a prototype-less object', nullPrototype],
    ['an object whose Symbol.toPrimitive throws', hostilePrimitive],
    ['a proxy that throws from getPrototypeOf and get', hostilePrototypeChain],
  ];

  /** Shapes that pass it, so the identity return runs. */
  const passedThrough: [string, () => unknown][] = [
    ['an Error whose message is a Symbol', () => errorWithMessage(Symbol('boom'))],
    ['an Error whose message cannot be converted', errorWithUndescribableMessage],
    ['a proxy that is an Error and throws from get', proxiedError],
  ];

  for (const [shape, make] of constructed) {
    it(`builds an Error with a string message for ${shape}`, () => {
      const reportable = toReportableError(make());
      const message: unknown = reportable.message;
      expect(typeof message).toBe('string');
      expect((message as string).length).toBeGreaterThan(0);
    });
  }

  for (const [shape, make] of passedThrough) {
    it(`hands back ${shape} unchanged, and describing it is still a string`, () => {
      const original = make();
      expect(toReportableError(original)).toBe(original);
      // The guarantee that survives the pass-through, and the one every call
      // site actually relies on: whatever came back, the describer turns it into
      // a string without throwing.
      const described: unknown = describeUnknown(toReportableError(original));
      expect(typeof described).toBe('string');
      expect((described as string).length).toBeGreaterThan(0);
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
