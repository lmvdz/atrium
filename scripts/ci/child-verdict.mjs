/**
 * Did that child process disagree with us, or did something happen to it?
 *
 * ── THE DEFECT (#40 round 5) ────────────────────────────────────────────────
 * `deploy-mutation-ledger.mjs` runs every stage of the real deploy job under a
 * 420-second timeout and wrapped the call in an `attempt()` that caught the
 * throw, returned `{ok: false}`, and never looked at *why*. The ledger reads
 * `!ok` as "this stage went red", so a stage that ran a few seconds over the
 * limit — or a `bash` that was not on PATH, or a node process the kernel killed
 * for memory — was written down as **CAUGHT**: an assertion credited with a
 * verdict it never reached. The ledger's own version of the defect it exists to
 * find.
 *
 * It lives in its own file so that `gate-selftest.mjs` can hand it each shape
 * without importing the ledger, which does its whole run at module scope.
 */

/**
 * Why this `execFileSync` failure is not the child's verdict, or undefined if
 * it is.
 *
 * Which field carries which is measured rather than remembered — the obvious
 * guess is wrong. On node v24.5.0:
 *
 *     node -e 'process.exit(7)'          status=7     signal=null    code=undefined
 *     …, timeout: 200 (a 5s child)       status=null  signal=SIGTERM code=ETIMEDOUT
 *     a binary that does not exist       status=null  signal=null    code=ENOENT
 *     bash -c 'kill -9 $$'               status=null  signal=SIGKILL code=undefined
 *
 * `error.killed` is `undefined` in all four — it is not the timeout flag it
 * reads like, and a fix written from its name would have been another silent
 * pass. So the timeout is recognised by `ETIMEDOUT` (with `killed` kept as a
 * second spelling, since it is documented and costs a comparison), and the
 * general shape by "no numeric status". A child that exited by itself has a
 * numeric `status`, and that number is the verdict whatever it is.
 *
 * @param {object} error the throw from `execFileSync`
 * @param {number} timeoutMs the limit the caller imposed, for the message
 * @returns {string|undefined}
 */
export function notAVerdict(error, timeoutMs) {
  if (error?.code === 'ETIMEDOUT' || error?.killed === true) {
    return `it was killed by this ledger's own ${Math.round(timeoutMs / 1000)}s timeout rather than exiting on its own, so nothing here observed a verdict`;
  }
  if (error?.signal != null) {
    return `it was killed by ${error.signal} rather than exiting on its own (an out-of-memory kill looks exactly like this), so its exit status is the kernel's rather than the assertion's`;
  }
  if (typeof error?.status !== 'number') {
    return `it never started: ${error?.code ?? 'no exit status was produced'}. A command that could not be run has not disagreed with anything`;
  }
  return undefined;
}
