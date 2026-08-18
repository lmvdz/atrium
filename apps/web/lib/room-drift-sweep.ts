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
 * ## WIRED into the production replica lifecycle (E7, #199 Fix 2)
 *
 * DETECT is now LIVE in production, not only in the test. {@link
 * import('./room-replica-manager').RoomReplicaManager} starts a sweep per replica on
 * `acquire` (seeding verdicts with one {@link sweepNow}) and stops it on evict; the
 * server read path ({@link import('./room-covenant-reads').roomCovenantReads})
 * consumes {@link staleObjectIds} so a span the live sweep marks `~` is forced `~` in
 * the returned glyph map. The swept set is the AUTHORITATIVE `covenant_anchors`
 * ({@link RoomDriftSweepOptions.loadCertifiedObjectIds}), never a caller allowlist.
 *
 * What still feeds the replica LIVE between catch-ups — the Electric subscription /
 * the ws authenticated-write ingress — is the SAME infra the sandbox cannot stand up
 * that E3 already named (see the end of `server-room-replica.ts`). In the compose-
 * backed acceptance test the replica is driven directly (a peer delta via
 * `applyAuthenticatedUpdate`); in production the same `update` event fires from the
 * live feed. The client render (E4), the read-only verdict SYNC to clients (E6) and
 * the client freshness witness (#209) build on top of this server-side DETECT later.
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
   * `invalidate` on every update and re-resolves against it; on {@link stop} it
   * `invalidateAll`s so a torn-down sweep leaves no stale cached `ok`. (Production
   * binds the web authority, whose `liveFreshness` port decides read() freshness on
   * its own — E7 #199 Fix 4 removed the dead `markSweepLive` trust-gate.)
   */
  readonly authority: CovenantReadAuthority;
  /**
   * Load the room's AUTHORITATIVE certified-object set (E7, #199 Fix 1) — every
   * `object_id` that HAS a live covenant anchor, read straight from the ledger
   * (`listCovenantAnchorObjectIds`), NOT a caller-passed allowlist. This closes the
   * false-`✓` hole: a caller list that under-supplied one id would leave that span
   * NEVER swept and a stale `✓` over it undetected, whereas the ledger names every
   * certified span by construction. Called (async) on every sweep so a human certify /
   * re-certify between updates is picked up; the sweep over-covers rather than under-
   * covers (the fail-closed direction — an extra id merely re-resolves back to `ok`).
   *
   * The async result seeds an in-process SNAPSHOT ({@link knownCertified}) the sweep
   * re-resolves SYNCHRONOUSLY on the next update, so a same-tick read still sees `~`
   * without waiting on the ledger; the async refresh only ADDS newly-certified ids the
   * synchronous pass could not yet know (never removes coverage mid-tick).
   */
  readonly loadCertifiedObjectIds: () => Promise<Iterable<string>>;
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
  private readonly loadCertifiedObjectIds: () => Promise<Iterable<string>>;
  private readonly now: () => string;

  /** The in-process stale-draft ledger: object → its (frozen) machine `~` draft. */
  private readonly drafts = new Map<string, MachineStaleDraft>();
  /** In-flight re-resolves + ledger refreshes, so {@link settled} can await the sweep quiet. */
  private readonly pending = new Set<Promise<void>>();
  /**
   * The last AUTHORITATIVE certified-object snapshot (E7, #199 Fix 1). Seeded from the
   * ledger by the async refresh and re-resolved SYNCHRONOUSLY on the next update, so a
   * same-tick read sees `~` without awaiting the ledger.
   */
  private knownCertified = new Set<string>();
  /**
   * Monotone REFRESH epoch (E7, #199 Fix 1). Each async `loadCertifiedObjectIds`
   * refresh captures the value of {@link refreshCounter} at kick time; its result is
   * ADOPTED into {@link knownCertified} (and its stale-draft pruning applied) only if
   * that epoch is still the latest to have completed ({@link appliedRefreshEpoch}). A
   * stale/older refresh completing AFTER a newer one is DROPPED — it can never overwrite
   * a newer certified set or momentarily empty it while anchors exist. This is the SL-4
   * generation guard applied to the ledger refresh itself, not just per-object resolves.
   */
  private refreshCounter = 0;
  /** The highest refresh epoch whose result has been adopted (see {@link refreshCounter}). */
  private appliedRefreshEpoch = 0;
  /**
   * Objects the sweep has POSITIVELY confirmed swept-clean (E7, #199 Fix 3): a re-resolve
   * settled `ok` under the current generation and no later edit has re-opened the verdict.
   * The read-path overlay ({@link staleObjectIds} is its `~` counterpart) consumes this to
   * be FAIL-CLOSED until the sweep has spoken: a certified span NOT in this set (nor in
   * {@link drafts}) has no settled sweep verdict, so the overlay withholds `ok`. Cleared
   * for an object the instant it is (re-)swept — its verdict is unknown until the resolve
   * settles again — so the pre-settle window can never serve a stale `ok`.
   */
  private readonly sweptClean = new Set<string>();
  /**
   * Per-object SWEEP generation (E7, #199 Fix 5). Bumped every time an object is
   * (re-)swept; a resolve captures the generation at kick time and only folds its
   * verdict if it is still current — so a superseded compute (a late `unresolved`/
   * `drift` from a dropped resolve) can never rewrite the draft after a newer sweep's
   * `ok` already cleared it.
   */
  private readonly draftGeneration = new Map<string, number>();
  /** Bound so `off` removes exactly what `on` added. `null` when stopped. */
  private handler: ((update: Uint8Array, origin: unknown) => void) | null = null;

  constructor(options: RoomDriftSweepOptions) {
    this.doc = options.doc;
    this.authority = options.authority;
    this.loadCertifiedObjectIds = options.loadCertifiedObjectIds;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Begin sweeping: re-run DETECT on every update the replica's doc integrates. Idempotent.
   */
  start(): void {
    if (this.handler !== null) return; // already subscribed — idempotent
    const handler = (_update: Uint8Array, _origin: unknown): void => this.sweep();
    this.handler = handler;
    this.doc.on('update', handler);
  }

  /**
   * Stop sweeping (replica teardown / eviction). Idempotent. FAIL-CLOSED (E7, #199):
   * a stopped sweep must never leave a stale cached `ok` behind, so this INVALIDATES
   * every currently-cached object ({@link CovenantReadAuthority.invalidateAll} — drops
   * what is cached and bumps generations so a resolve kicked before the stop cannot
   * recache an `ok` after it). Combined with the PRODUCTION teardown — the replica
   * manager unregisters the doc provider (`serverReplicaFor → null`) so the read path's
   * fresh per-request resolve yields `~` — an evicted room can serve no stale `✓`.
   *
   * (E7, #199 Fix 4: this no longer calls a `markSweepLive(false)` "re-fail-close" —
   * that trust-gate was DEAD on the production wiring, since production binds the web
   * authority whose `liveFreshness` port decides freshness on its own. The real
   * teardown fail-close is `invalidateAll` + provider→null + fresh-resolve-per-request.)
   * The drafts / swept-clean ledgers are left intact (the fail-closed direction — a
   * recorded `~` stays `~`, and the swept-clean set only ever WITHHELD `ok`).
   */
  stop(): void {
    if (this.handler === null) return;
    this.doc.off('update', this.handler);
    this.handler = null;
    // Clear the cache so no stopped sweep leaves a stale cached `ok`.
    this.authority.invalidateAll();
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
   * The set of object ids the sweep currently reads as drifted (`~`) — the drafts'
   * keys, snapshot-copied. The SERVER READ PATH consumes this (E7, #199 Fix 2): an
   * object the live sweep has marked `~` is forced `~` in the returned glyph map, so
   * the sweep's push-based DETECT reaches the glyphs, not only the pull-based
   * re-resolve. Fail-closed: it can only ever force an `ok` down to `~`.
   */
  staleObjectIds(): ReadonlySet<string> {
    return new Set(this.drafts.keys());
  }

  /**
   * The set of certified objects the sweep has POSITIVELY confirmed swept-clean (E7,
   * #199 Fix 3) — a snapshot copy. The read path consumes this to be FAIL-CLOSED until
   * the sweep has spoken: an object whose fresh resolve says `ok` but that is NOT in this
   * set has no settled sweep verdict yet (a freshly-certified anchor, or one re-opened by
   * an edit whose re-resolve has not settled), so the overlay WITHHOLDS `ok` and reads
   * `~`. Only a positively-swept-clean span is served `ok`; the overlay never mints one.
   */
  sweptObjectIds(): ReadonlySet<string> {
    return new Set(this.sweptClean);
  }

  /**
   * SEED a freshly-certified anchor into the sweep NOW (E7, #199 Fix 2), synchronously,
   * so its FIRST in-span edit is caught. `knownCertified` starts empty and only grows via
   * the async ledger refresh; a human certify is not itself a Yjs `update`, so without
   * this a new anchor would not be in the synchronous sweep pass until a refresh landed —
   * its first edit could read a stale `ok`. The certify path calls this on a successful
   * mint: the id joins {@link knownCertified} and is swept at once (invalidate + kick a
   * re-resolve), so the next update's synchronous pass already covers it and the read-path
   * overlay is fail-closed for it until its verdict settles. Idempotent for a known id
   * (a re-sweep is harmless — it over-covers, the fail-closed direction).
   */
  noteCertified(objectId: string): void {
    this.knownCertified.add(objectId);
    this.sweepObject(objectId);
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
   * ONE sweep pass. TWO phases (E7, #199 Fix 1):
   *
   *   (A) SYNCHRONOUS over the last authoritative snapshot ({@link knownCertified}):
   *       invalidate + kick a re-resolve for every KNOWN certified object. The
   *       invalidate is synchronous, so a read in THIS tick already sees `~` and a
   *       pre-edit in-flight resolve cannot recache a stale `✓`.
   *   (B) ASYNC authoritative REFRESH from the ledger: load every currently-certified
   *       object id and sweep any the snapshot did not yet know (a certify/re-certify
   *       between updates), then adopt the refreshed set as the snapshot. This is what
   *       makes the swept set the AUTHORITATIVE `covenant_anchors`, never a caller
   *       allowlist an omitted id could slip through.
   */
  private sweep(): void {
    // (A) Synchronous pass over the known-certified snapshot — within-tick fail-closed.
    for (const objectId of this.knownCertified) this.sweepObject(objectId);

    // (B) Async authoritative refresh; tracked in `pending` so `settled()` awaits it
    // (and the resolves it kicks). Fail-closed on a ledger throw: keep the current
    // snapshot (its objects were already swept synchronously in (A)).
    //
    // EPOCH GUARD (E7, #199 Fix 1): stamp this refresh with a monotone epoch and ADOPT
    // its result only if it is still the latest to complete. Without this, an older
    // `loadCertifiedObjectIds` result completing AFTER a newer one would overwrite
    // `knownCertified` with a stale (possibly empty, or smaller) set AND prune the
    // stale-draft/generation entries the newer snapshot added — so the next sweep would
    // invalidate nothing and a real drift would go undetected. Latest-epoch-wins: a
    // stale/older refresh is dropped, never overwrites a newer set or empties it.
    const epoch = ++this.refreshCounter;
    const refresh: Promise<void> = this.loadCertifiedObjectIds()
      .then((ids) => {
        const authoritative = new Set(ids);
        // Sweep any newly-certified id the synchronous pass could not yet know. Harmless
        // and epoch-independent (a re-resolve over-covers), so it runs regardless of the
        // guard below — the guard protects only the SET ADOPTION + draft pruning.
        for (const objectId of authoritative) {
          if (!this.knownCertified.has(objectId)) this.sweepObject(objectId);
        }
        // A stale/older refresh must not roll the certified set (or its drafts) backwards.
        if (epoch <= this.appliedRefreshEpoch) return;
        this.appliedRefreshEpoch = epoch;
        // Drop drafts/generations/swept-clean for objects no longer certified (anchor
        // removed or replaced) — a `~` (or a swept-clean `ok`) over an object with no
        // live `✓` is meaningless.
        for (const objectId of this.knownCertified) {
          if (!authoritative.has(objectId)) {
            this.drafts.delete(objectId);
            this.draftGeneration.delete(objectId);
            this.sweptClean.delete(objectId);
          }
        }
        this.knownCertified = authoritative;
      })
      .catch(() => {
        // Ledger unreachable ⇒ keep the snapshot (already swept in (A)); over-cover,
        // never under-cover.
      })
      .finally(() => {
        this.pending.delete(refresh);
      });
    this.pending.add(refresh);
  }

  /**
   * Invalidate + re-resolve ONE certified object under a fresh sweep generation. The
   * invalidate is synchronous (same-tick `~`); the resolve is async and its settled
   * verdict is folded under the captured generation (Fix 5), so a superseded compute
   * cannot rewrite a newer verdict. `resolve` is itself fail-closed (a throw / `null`
   * / missing anchor ⇒ `drift`), so this never rejects; the `.catch` is belt-and-suspenders.
   */
  private sweepObject(objectId: string): void {
    // Bump the sweep generation BEFORE the async resolve captures it, so any earlier
    // in-flight resolve for this object is now superseded and its late verdict dropped.
    const generation = (this.draftGeneration.get(objectId) ?? 0) + 1;
    this.draftGeneration.set(objectId, generation);
    // The object's verdict is now UNKNOWN until this re-resolve settles (E7, #199 Fix 3):
    // drop any prior swept-clean confirmation so the read-path overlay is fail-closed for
    // it during the pre-settle window — it cannot serve a stale `ok` while the resolve
    // that would confirm freshness is still in flight.
    this.sweptClean.delete(objectId);
    this.authority.invalidate(objectId);
    const p: Promise<void> = this.authority
      .resolve(objectId)
      .then((result) => this.recordVerdict(objectId, result.covenantStatus, generation))
      .catch(() => {
        // A rejection is "could not resolve" ⇒ fail-closed to `~`, never a `✓`.
        this.recordVerdict(objectId, 'drift', generation);
      })
      .finally(() => {
        this.pending.delete(p);
      });
    this.pending.add(p);
  }

  /**
   * Fold one re-resolve's verdict into the stale-draft ledger, GENERATION-GUARDED
   * (E7, #199 Fix 5). A verdict from a SUPERSEDED compute — one whose sweep
   * generation a later sweep has already advanced — is DROPPED, so a late
   * `unresolved`/`drift` cannot rewrite the draft after a newer sweep's `ok` cleared
   * it (or vice-versa). For the current generation: `ok` (the human's `✓` still
   * resolves) CLEARS any draft — the machine never records a `✓`, it just drops its
   * stale reading. Anything else (`drift`/`unresolved`) is a machine `~` draft,
   * FROZEN (Fix 4) so no cast/JS consumer can flip its `kind` to `'✓'` at runtime.
   * The `at` stamp is preserved across repeated drift observations so it marks the
   * TRANSITION instant, not the latest sweep.
   */
  private recordVerdict(objectId: string, status: CovenantReadStatus, generation: number): void {
    // Generation guard: only the LATEST sweep's resolve for this object may fold.
    if ((this.draftGeneration.get(objectId) ?? 0) !== generation) return;
    if (status === 'ok') {
      this.drafts.delete(objectId);
      // POSITIVELY confirm swept-clean (E7, #199 Fix 3): the read-path overlay may now
      // serve this object's `ok`. Only reached under the current generation, so a late
      // verdict from a superseded compute can never re-confirm a since-edited object.
      this.sweptClean.add(objectId);
      return;
    }
    // A definitive `drift`/`unresolved`: it is NOT swept-clean (already dropped in
    // sweepObject, kept dropped here for a resolve that folds without a prior sweepObject).
    this.sweptClean.delete(objectId);
    if (!this.drafts.has(objectId)) {
      // FROZEN at creation (Fix 4): the exposed draft is immutable at runtime, not
      // only `readonly` at compile time — there is no `'✓'` variant to reach for.
      this.drafts.set(objectId, Object.freeze({ objectId, kind: '~', at: this.now() }));
    }
  }
}
