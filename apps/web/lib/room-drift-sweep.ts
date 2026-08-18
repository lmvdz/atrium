import 'server-only';
import type { CovenantReadAuthority, CovenantReadStatus } from '@atrium/core';
import type * as Y from 'yjs';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DRIFT-ON-UPDATE SCHEDULER (E7, #199 / P6F-5) — DETECT, server-side.
 *
 * This is what makes a human `✓` auto-STALE the instant an agent-peer edits the
 * certified content. It runs on the E3 SERVER REPLICA ({@link
 * ./server-room-replica}.ServerRoomReplica) — the caught-up `Y.Doc` that already
 * integrates EVERY Yjs update for the room — NOT on a client `LiveRoomSession`
 * (that render surface is E4's). The fail-closed server sweep is the robust path
 * and does not depend on any client doc.
 *
 * ## What it does, on ANY content update
 *
 * The replica's `Y.Doc` fires `update` for every op it integrates — a live
 * authenticated write, a durable-stream catch-up, a merged peer delta. On EACH,
 * for EVERY certified object in the room, the sweep:
 *
 *   1. `authority.invalidate(objectId)` — SYNCHRONOUS. Drops the cached verdict
 *      and bumps the object's generation, so a read in the SAME tick already sees
 *      `~` (the read authority returns `unresolved` for a dropped entry) and any
 *      in-flight resolve that predates this edit can no longer repopulate a stale
 *      `✓` (the generation guard). This is the SL-4 `invalidate` hook the read
 *      authority's docblock names "#182's drift-on-update calls".
 *   2. `authority.resolve(objectId)` — ASYNC. Re-resolves the anchor's span
 *      against the now-edited live doc and caches the definitive verdict.
 *
 * ## Span precision comes from the DIGEST re-resolution, not from edit filtering
 *
 * The sweep is DELIBERATELY COARSE: it invalidates and re-resolves EVERY certified
 * span on EVERY update, never trying to guess which spans an edit touched. That is
 * the FAIL-CLOSED direction (the charter's #182 rule): over-invalidating merely
 * forces a harmless re-resolve that lands back on `✓`, whereas under-invalidating
 * (missing an edit that DID move a span) would leave a stale `✓` — a false pass.
 * The precision — `✓` STAYS for an out-of-range edit, flips to `~` for an in-range
 * one — is decided ENTIRELY by the span-scoped digest re-resolution the authority
 * runs against the anchor's relative-position span (`resolveCovenant`):
 *
 *   - an edit OUTSIDE a certified span (a different message, or the same body past
 *     the span's boundary) re-renders the anchored `[start, end)` window
 *     BYTE-IDENTICALLY ⇒ the rendered digest is unchanged ⇒ the resolve settles
 *     back to `ok` ⇒ the human's `✓` STAYS (a transient `~` during the sweep is the
 *     safe fail-closed flicker, then it settles green);
 *   - an edit INSIDE a certified span moves the rendered digest ⇒ the resolve
 *     settles to `drift` ⇒ `~`.
 *
 * So a single out-of-range edit can never STORM every span into `~`: each span's
 * own digest is the arbiter, and only the touched span's digest actually moves.
 *
 * ## THE LOAD-BEARING COVENANT INVARIANT — the machine only ever drafts `~`
 *
 * The machine NEVER certifies. This module has NO write path to `covenant_anchors`
 * (the human-`✓` ledger, gated by `certifyObjectSpan`, `certifier_kind='human'`):
 * it only reads verdicts through the {@link CovenantReadAuthority}. A stale
 * transition is recorded as a {@link MachineStaleDraft}, whose `kind` is the LITERAL
 * `'~'` — there is no `'✓'` variant, so "the machine drafts `~`, never `✓`" is a
 * COMPILE-TIME refusal, not a convention. A `✓` is only ever the human's STANDING
 * anchor resolving `ok` again (content returned to the certified bytes, or a human
 * re-certify wrote a fresh anchor); the sweep never mints one, and no sweep /
 * re-resolve / race can turn a `~` into a `✓` on its own.
 *
 * ## Production ingress is a NAMED infra gap, exactly as E3's
 *
 * The SEAM is complete: the sweep subscribes to the replica's `Y.Doc` and re-runs
 * DETECT on every integrated update. What feeds the replica LIVE between catch-ups
 * — the Electric subscription / the ws authenticated-write ingress — is the SAME
 * infra the sandbox cannot stand up that E3 already named (see the end of
 * `server-room-replica.ts`). In the compose-backed acceptance test the replica is
 * driven directly (a peer delta applied via `applyAuthenticatedUpdate`); in
 * production the same `update` event fires from the live feed. A working seam + a
 * named gap beats a stalled lane.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * A MACHINE-drafted stale reading — the record E7 writes to the in-process verdict
 * ledger when the sweep finds a certified span has drifted. Its `kind` is the
 * literal `'~'` and nothing else: the machine drafts `~`, it NEVER certifies `✓`
 * (the covenant's load-bearing invariant), and there is deliberately no `'✓'`
 * variant of this type for a sweep to reach for.
 *
 * This is NOT a persisted verdict row — that durable projection is E6's
 * verdict-sync table, out of E7's scope. It is the in-process record the DETECT
 * sweep maintains alongside the read authority's cache, so a caller (and the
 * acceptance test) can observe the stale transition and assert it is `~`.
 */
export interface MachineStaleDraft {
  readonly objectId: string;
  /** ALWAYS `'~'`. There is no `'✓'` variant — the machine never certifies. */
  readonly kind: '~';
  /** When the sweep first observed this object as drifted (ISO-8601, server clock). */
  readonly at: string;
}

export interface RoomDriftSweepOptions {
  /**
   * The room's authoritative live `Y.Doc` — the E3 server replica's doc, which
   * integrates every update. The sweep subscribes to its `update` event. Use
   * `replica.doc`; a torn-down replica should have its sweep {@link
   * RoomDriftSweep.stop}ped rather than its doc left subscribed.
   */
  readonly doc: Y.Doc;
  /**
   * The room's covenant read authority — the ONE fail-closed seam that decides
   * `✓`/`~` for an object (`resolve`/`read`/`invalidate`). The sweep drives its
   * `invalidate` on every update and re-resolves; when this authority is built
   * drift-swept (its `failClosedWithoutFreshness` cleared — see
   * `serverCovenantReadAuthority`), a cached `ok` that survives an invalidate-covered
   * window is proven fresh, which is exactly what THIS sweep guarantees.
   */
  readonly authority: CovenantReadAuthority;
  /**
   * The room's currently-certified object ids — the objects that HAVE a live
   * covenant anchor. Called fresh on every sweep (a caller may add/remove certified
   * objects between updates: a human certify adds one, a re-certify replaces one).
   * The sweep re-resolves ALL of them on every update (coarse, fail-closed).
   */
  readonly certifiedObjectIds: () => Iterable<string>;
  /** The server clock stamped on a stale draft. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
}

/**
 * Subscribe a room's DETECT sweep to its server replica's Yjs updates. Construct,
 * {@link start}, and — on replica teardown — {@link stop}. Idempotent on both.
 */
export class RoomDriftSweep {
  private readonly doc: Y.Doc;
  private readonly authority: CovenantReadAuthority;
  private readonly certifiedObjectIds: () => Iterable<string>;
  private readonly now: () => string;

  /** The in-process stale-draft ledger: object → its machine `~` draft. */
  private readonly drafts = new Map<string, MachineStaleDraft>();
  /** In-flight re-resolves, so {@link settled} can await the sweep going quiet. */
  private readonly pending = new Set<Promise<void>>();
  /** Bound so `off` removes exactly what `on` added. `null` when stopped. */
  private handler: ((update: Uint8Array, origin: unknown) => void) | null = null;

  constructor(options: RoomDriftSweepOptions) {
    this.doc = options.doc;
    this.authority = options.authority;
    this.certifiedObjectIds = options.certifiedObjectIds;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Begin sweeping: re-run DETECT on every update the replica's doc integrates. */
  start(): void {
    if (this.handler !== null) return; // already subscribed — idempotent
    const handler = (_update: Uint8Array, _origin: unknown): void => this.sweep();
    this.handler = handler;
    this.doc.on('update', handler);
  }

  /** Stop sweeping (replica teardown). Idempotent; leaves the drafts ledger intact. */
  stop(): void {
    if (this.handler === null) return;
    this.doc.off('update', this.handler);
    this.handler = null;
  }

  /**
   * Run ONE sweep NOW, without waiting for an `update` event — the production
   * wiring calls this once after `start()` to seed the current verdicts, and a
   * test calls it to force a deterministic pass. Returns nothing; use {@link
   * settled} to await the async re-resolves it kicks.
   */
  sweepNow(): void {
    this.sweep();
  }

  /**
   * The machine's current stale drafts — one `~` per drifted certified object. A
   * snapshot copy, so a caller iterating it is not disturbed by a concurrent sweep.
   * Every entry's `kind` is `'~'` by construction (there is no `'✓'` variant).
   */
  staleDrafts(): ReadonlyMap<string, MachineStaleDraft> {
    return new Map(this.drafts);
  }

  /** The machine's stale draft for one object, or `undefined` if it reads fresh/`✓`. */
  staleDraftFor(objectId: string): MachineStaleDraft | undefined {
    return this.drafts.get(objectId);
  }

  /**
   * Await the sweep going quiet — every re-resolve kicked so far (and any a still-
   * running resolve kicks) has settled and updated the drafts ledger. For the
   * acceptance test's "within one render tick" assertion after an edit. Loops
   * because a resolve can complete while another update's resolves are still in
   * flight; when no promises remain, the verdicts are current.
   */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /**
   * ONE sweep pass: invalidate + re-resolve every certified object. The invalidate
   * is synchronous (so a read in this tick already sees `~`); the resolve is async
   * and its settled verdict updates the stale-draft ledger — `drift` records a `~`,
   * `ok` clears it (the human's `✓` resolves again; the machine did not mint it).
   */
  private sweep(): void {
    for (const objectId of this.certifiedObjectIds()) {
      // (1) SYNCHRONOUS invalidate — coarse and fail-closed. Drops the cached
      // verdict and bumps the generation, so the same-tick read is `~` and a
      // pre-edit in-flight resolve cannot recache a stale `✓`.
      this.authority.invalidate(objectId);
      // (2) ASYNC span-scoped re-resolve — the digest decides `✓`-stays vs `~`.
      // `resolve` is itself fail-closed (a throw/`null`/missing anchor ⇒ `drift`),
      // so this never rejects; the `.catch` is belt-and-suspenders.
      const p = this.authority
        .resolve(objectId)
        .then((result) => this.recordVerdict(objectId, result.covenantStatus))
        .catch(() => {
          // A rejection is "could not resolve" ⇒ fail-closed to `~`, never a `✓`.
          this.recordVerdict(objectId, 'drift');
        })
        .finally(() => {
          this.pending.delete(p);
        });
      this.pending.add(p);
    }
  }

  /**
   * Fold one re-resolve's verdict into the stale-draft ledger. `ok` (the human's
   * `✓` still resolves) CLEARS any draft — the machine never records a `✓`, it just
   * drops its stale reading. Anything else (`drift`/`unresolved`) is a machine `~`
   * draft. The `at` stamp is preserved across repeated drift observations so it
   * marks the TRANSITION instant, not the latest sweep.
   */
  private recordVerdict(objectId: string, status: CovenantReadStatus): void {
    if (status === 'ok') {
      this.drafts.delete(objectId);
      return;
    }
    if (!this.drafts.has(objectId)) {
      this.drafts.set(objectId, { objectId, kind: '~', at: this.now() });
    }
  }
}
