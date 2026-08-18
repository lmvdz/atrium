/* ═══════════════════════════════════════════════════════════════════════════
 * THE CLIENT DISPLAY FRESHNESS GATE (#220 / T6 — the stale-`✓` window closer).
 *
 * A covenant verdict on the `covenant_status` Electric shape is computed by the server
 * against the content the server replica had caught up to. The client's own live `Y.Doc`
 * can be AHEAD of that — a local edit not yet PUT + swept, or a remote peer edit that
 * converged to the client before the server re-verdicted it — so a live `✓` could stand
 * over already-edited text for the sub-second window before the poke → sweep → projection
 * round-trips. That window is a real stale-`✓` (the gauntlet's MEDIUM).
 *
 * This gate closes it on the CLIENT, fail-closed: it binds each folded verdict to the body
 * text the client DISPLAYED at fold time, and a `✓` is served ONLY while the text displayed
 * NOW is byte-identical to that captured text. The instant an edit changes the displayed
 * text — before any new verdict — the gate withholds `✓` (`~`); it restores `✓` only once a
 * FRESH verdict re-snapshots the current text and (elsewhere) still resolves `ok`.
 *
 *   - `onRender(verdictToken, messages)` re-snapshots the per-message displayed text WHEN
 *     the verdict token changes (a new `covenant_status` delta / liveness tick gives a new
 *     resolver identity); on an unchanged token it leaves the snapshot intact, so a render
 *     caused by a CONTENT edit alone does NOT refresh the baseline.
 *   - `fresh(id, currentText)` is the gate: the text shown now must equal the text captured
 *     at the last verdict. An id with no captured verdict reads `false` (fail-closed).
 *
 * This is the SCOPED client gate; the DURABLE content-freshness witness (a verdict proving
 * WHICH content version it saw) is tracked separately as #209 / #211. Referenced, not
 * duplicated here.
 * ═════════════════════════════════════════════════════════════════════════ */

/** A message as the gate reads it — an id and the plaintext body currently displayed. */
export interface FreshnessMessage {
  readonly id: string;
  readonly text?: string;
}

/** A sentinel distinct from every real verdict token, so the FIRST render snapshots. */
const NO_TOKEN: unique symbol = Symbol('display-freshness/no-token');

export class DisplayFreshnessGate {
  /** id → the displayed body text captured at the last verdict fold. */
  private sig = new Map<string, string>();
  /** The verdict token the current snapshot was taken at (a resolver identity). */
  private lastToken: unknown = NO_TOKEN;

  /**
   * Re-snapshot the displayed text per message WHEN `verdictToken` changes (a new
   * `covenant_status` delta), else leave the snapshot intact. Called every render; only a
   * render whose token DIFFERS from the last one refreshes the baseline, so a content edit
   * (same token) leaves the pre-edit sig standing — which is what withholds `✓` until a
   * genuinely newer verdict arrives.
   */
  onRender(verdictToken: unknown, messages: Iterable<FreshnessMessage>): void {
    if (this.lastToken === verdictToken) return;
    this.lastToken = verdictToken;
    const next = new Map<string, string>();
    for (const message of messages) next.set(message.id, message.text ?? '');
    this.sig = next;
  }

  /**
   * Whether a `✓` may be shown for `id`: the body displayed NOW (`currentText`) must be
   * byte-identical to the body captured at the last verdict fold. An id with no captured
   * verdict — a brand-new line, or one whose text changed since the last fold — reads
   * `false` (fail-closed): no `✓` over content newer than the verdict.
   */
  fresh(id: string, currentText: string): boolean {
    return this.sig.get(id) === currentText;
  }
}
