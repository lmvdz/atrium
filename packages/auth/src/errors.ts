/**
 * Describing a value nobody vetted, without the description becoming the fault.
 *
 * ## Why this is a module and not three lines in a `catch`
 *
 * This is the second appearance of one class in two rounds.
 *
 * Round 7 wrote `new Error(String(error))` at the call site of a crash guard,
 * one line upstream of the `try` that existed to protect it. Round 8 moved that
 * normalization inside the guard and made every conversion attempted rather than
 * assumed — and the round-8 delta then found the *same shape* two files away, in
 * the realtime sweep: `(error as Error).message` read while building log fields,
 * before the failure counter was incremented. A rejection carrying
 * `get message() { throw }` threw there, the sweep's bookkeeping never ran, and
 * every later interval started over with `sweepFailures === 0` — so a removed,
 * silent socket kept receiving presence with no bound at all.
 *
 * Both times the defect was not in the code that *handles* the failure. It was
 * in the code that *describes* it, which every reviewer reads as inert. So the
 * description lives here, once, and the rule that goes with it is stated once:
 *
 * > **Formatting an unknown value is executing code that value controls.**
 * > Anything a guarantee depends on — a counter, a latch, a back-off, an exit
 * > code, a fail-closed `return null` — happens *before* the value is described,
 * > and the description itself is total.
 *
 * ## What "total" means here, precisely
 *
 * Nothing exported below has any path that throws, and none has a path that
 * returns a non-string where a string is promised. That is a stronger claim than
 * "it is wrapped in try/catch", because the interesting throws are not where
 * they look:
 *
 *  - `String(x)` calls `toString` / `Symbol.toPrimitive`. `Object.create(null)`
 *    has neither; a hostile `Symbol.toPrimitive` throws whatever it likes.
 *  - `x instanceof Error` runs the `getPrototypeOf` trap on a Proxy, which can
 *    throw before the comparison happens.
 *  - `error.message` and `error.stack` are getters on several implementations,
 *    and a getter is arbitrary code.
 *
 * Every one of those is therefore attempted inside its own `try` rather than
 * assumed, and each has a fallback that reads no property of the value at all.
 */

/**
 * The logger shape this module can guard. Deliberately the narrow one: only the
 * error channel, because the error channel is where unvetted values arrive.
 */
export interface GuardableErrorLogger {
  error: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * Emit one error log, and never let the logging become the failure.
 *
 * The fields arrive as a thunk rather than a value so that *building* them is
 * inside the guard too. That is not decoration: the fields are usually where an
 * `Error` this process did not create gets its properties read, and `stack` in
 * particular is a getter on some implementations. A logger that throws — a
 * transport with a closed socket, a serializer that chokes on a circular
 * `cause` — is the last thing that may take a path down.
 *
 * Nothing is re-reported from the `catch`: reporting it would use the same
 * logger. Dropped deliberately, which is not the same as dropped by omission.
 */
export type GuardedErrorLog = (message: string, fields: () => Record<string, unknown>) => void;

/** Wrap a logger so neither building the fields nor emitting them can throw. */
export function guardedErrorLog(logger: GuardableErrorLogger): GuardedErrorLog {
  return (message, fields) => {
    try {
      logger.error(message, fields());
    } catch {
      // Intentionally empty; see above.
    }
  };
}

/**
 * Describe an unknown value as a string, and never throw doing it.
 *
 * Called from post-commit paths, from failure counters, and from process-level
 * last-resort handlers, so "never" is the requirement rather than the aspiration.
 * See the module header for which conversions are the dangerous ones.
 */
export function describeUnknown(value: unknown): string {
  try {
    if (value instanceof Error) return value.message;
  } catch {
    // A hostile prototype chain or a throwing `message` getter. Fall through to
    // the string conversion, which is guarded in its turn.
  }
  try {
    return String(value);
  } catch {
    // `Object.create(null)`, a throwing `Symbol.toPrimitive`, a Proxy.
  }
  return '<a rejection value that cannot be converted to a string>';
}

/**
 * Normalize anything a port rejected with into an `Error`, totally.
 *
 * Total is the whole requirement. The code that formats an error on a
 * post-commit path is as much a part of that path as the code that reports it.
 */
export function toReportableError(value: unknown): Error {
  try {
    if (value instanceof Error) return value;
  } catch {
    // See `describeUnknown`.
  }
  return new Error(describeUnknown(value));
}
