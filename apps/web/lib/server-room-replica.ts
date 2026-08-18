import 'server-only';
import * as Y from 'yjs';
import type { ConversationTransport } from '@/app/prototype/conversation-transport';
import type { ChatMsg } from '@/app/prototype/types';
import { ConversationDoc } from '@/app/prototype/yjs-conversation';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER-AUTHORITATIVE YJS REPLICA (P6F-2 / #196, architecture piece R3).
 *
 * The room's live `Y.Doc` lives in every participant's BROWSER. The server's
 * certify path (`certify-anchor.ts`) and read authority (#191) must resolve and
 * capture against AUTHORITATIVE content — not the bytes a client happens to send
 * with its certify request. This module is that authority: a server-side,
 * caught-up Yjs replica of one room's conversation, wrapping a {@link
 * ConversationDoc} so it inherits P6F-1's every invariant for free (the metadata
 * ALLOWLIST-strip, the zod-validated + id-quarantined index, the identity-bound
 * genuine-seat resolution, and the fail-closed reader render). {@link
 * liveCovenantDoc} hands this replica's `Y.Doc` — and the `conversation-content`
 * share — to the reader.
 *
 * ## Two data paths, and why only ONE carries authorship
 *
 * A `ConversationDoc` (and thus this replica) converges by Yjs's own merge over
 * OPAQUE update bytes. That convergence is CONTENT-correct but AUTHORSHIP-blind:
 * a CRDT cannot say WHO wrote an item — the `client` field an item carries is
 * peer-craftable (a colliding or deliberately-low client id), byte-replay
 * re-plays another writer's exact ops, and CRDT position is whatever a peer
 * inserts at. P6F-1's gauntlet routed exactly this to P6F-2: "the CRDT layer
 * converges but cannot securely authenticate WHO authored content."
 *
 * So this replica separates the two, by SOURCE of the authorship signal:
 *
 *   - CONVERGENCE-ONLY — {@link connect} joins the replica to a live replication
 *     fabric for content alone; an item that arrives this way has
 *     `authenticatedAuthorOf === null` (unknown), fail-closed.
 *
 *   - AUTHORSHIP FROM DATA — {@link catchUp} folds one DURABLE-STREAM row and
 *     replays that row's PERSISTED writer stamp (E2's `writer_user_id` /
 *     `writer_kind`, migration 0054) into the ledger over the exact `(client, clock)`
 *     ranges the row's bytes declare (E3, #203). So a replica rebuilt after a cold
 *     restart recovers the ORIGINAL writers from the rows — a `system`/unstamped row
 *     (writer `null`) folds content WITHOUT authorship, fail-closed to unknown.
 *
 *   - AUTHORSHIP FROM A LIVE CONNECTION — {@link applyAuthenticatedUpdate} is the
 *     live write that binds an item to a writer. It applies an update that arrived
 *     over an AUTHENTICATED connection (the ws server's `AtriumSession`, adjacent to
 *     #187) and records, in a ledger keyed by the item's `(client, clock)`, WHICH
 *     authenticated writer's connection introduced it. Authorship of a message's
 *     content is then {@link authenticatedAuthorOf}: enumerate the CURRENT content
 *     items the reader renders inside the genuine body child ({@link
 *     ConversationDoc.genuineBodyContentItemIds}) and read the ledger over THOSE —
 *     not the body's container seat, which a peer can keep while replacing every
 *     character inside it. A mixed or unattributed body is unverified, never the
 *     victim.
 *
 * ## Why a peer cannot inherit another writer's authorship
 *
 * The ledger is keyed by WHO DELIVERED an item over an authenticated connection,
 * never by the `client` field the item claims:
 *
 *   - CRAFTED LOW CLIENT ID (to win the genuine-seat rule): the crafted item is
 *     NEW (a clock the doc has never integrated), so it is attributed to the
 *     peer's OWN authenticated identity when their connection delivers it. The
 *     peer can win the CRDT seat, but its author is the peer — never the identity
 *     it collided with. (And its content won't match the victim's trust
 *     fingerprint anyway.)
 *   - CLIENT-ID IMPERSONATION (send items claiming a victim's `client` number):
 *     those items carry clocks the victim never wrote; the ledger records them to
 *     the peer's connection. The `client` field decides nothing.
 *   - BYTE-REPLAY of a victim's exact update: Yjs DEDUPES it (same `(client,
 *     clock)` already integrated ⇒ no new items), so no re-attribution happens
 *     and the original writer's ledger entry stands untouched.
 *
 * The security property is: authorship follows the authenticated writer who
 * actually supplied the winning item, resolved server-side; it is never derived
 * from CRDT position, byte-replay, or a crafted client id.
 *
 * ## Infra guardrail (measured on #183)
 *
 * The production catch-up source is Electric / `@electric-sql/y-electric` over
 * durable Postgres logical-replication streams, which THIS SANDBOX CANNOT STAND
 * UP (electric-transport.ts states the exact gap). So the replica's catch-up seam
 * is built against the in-memory {@link ConversationTransport} (the
 * `InMemoryConversationHub`), the authenticated-write path is driven directly in
 * tests, and the production wiring is a NAMED follow-up (see the end of this
 * file). A working seam + a named gap beats a stalled lane.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * The AUTHENTICATED writer of a Yjs update — resolved from the authenticated
 * connection (the ws server's session, adjacent to #187), NEVER from anything the
 * update's bytes carry. This is the identity the ledger binds an item to.
 */
export interface WriterIdentity {
  readonly userId: string;
  readonly principalKind: 'human' | 'agent';
}

/**
 * The stream position a LIVE authenticated apply records its claims at. A live
 * apply ({@link ServerRoomReplica.applyAuthenticatedUpdate} /
 * {@link ServerRoomReplica.seedAuthored}) is in-memory content, not a durable
 * stream row, so it has no durable ordinal — and its items are always NEW clocks
 * that no durable row has declared yet (Yjs cannot integrate a colliding item), so
 * this value only ever loses a tie to a durable row that later re-declares the
 * SAME item with the SAME writer. `+Infinity` encodes exactly that ordering: the
 * durable stream is authoritative; a live in-memory attribution yields to a durable
 * row's stamp for the same `(client, clock)` (which is the same writer anyway).
 */
const LIVE_APPLY_POSITION = Number.POSITIVE_INFINITY;

/**
 * One attributed clock range for a client: `[from, to)` written by `writer`, as
 * declared by the durable row at stream position `streamPosition` (the row's
 * immutable `stream_seq`; lower = earlier). {@link WriterLedger.writerAt} resolves an
 * overlapping clock to the claim with the SMALLEST `streamPosition` — the earliest
 * genuine writer — so attribution is independent of the order rows are replayed in.
 */
interface AttributedRange {
  readonly from: number;
  readonly to: number;
  readonly writer: WriterIdentity;
  readonly streamPosition: number;
}

/**
 * The authenticated-writer ledger. It maps each Yjs item — identified by its
 * `(client, clock)` — to the authenticated writer whose connection first
 * introduced it. This is the un-forgeable core: the KEY is the CRDT item
 * identity, but the VALUE is decided by WHO delivered it over an authenticated
 * connection, so a crafted `client` field can never reassign an existing item's
 * author, and a new crafted item is attributed to its own deliverer.
 *
 * ## Earliest-stream-writer-wins — genuinely ORDER-INDEPENDENT for overlaps
 *
 * Each recorded range carries the STREAM POSITION of the durable row that declared
 * it (the row's immutable `stream_seq`, passed as the fold ordinal). When
 * two rows declare OVERLAPPING clocks of the same client — the reachable-in-theory
 * case where a full-state update re-contains another writer's structs alongside its
 * own new ones — {@link writerAt} resolves each clock to the writer of the range
 * with the SMALLEST stream position: the row that GENUINELY introduced the item,
 * which is the earliest one in the stream. Because that ordinal is INTRINSIC to the
 * row (not the replay order), replaying the rows in ANY order attributes the clock
 * to the same original writer. A re-consumed row (a duplicate stream read) is a
 * no-op at the replica level ({@link ServerRoomReplica.catchUp} dedupes by seq),
 * so the ledger never even sees the second read; the min-position rule is the
 * belt-and-suspenders that keeps a full-state re-declaration from re-homing an
 * already-attributed clock regardless.
 */
class WriterLedger {
  private readonly byClient = new Map<number, AttributedRange[]>();

  /**
   * Attribute the `[from, to)` clock range of `client` to `writer`, as declared by
   * the durable row at `streamPosition`. Overlaps are resolved at read time
   * ({@link writerAt}) by smallest stream position, so this simply records the claim
   * — it never trims against arrival order, which is what made the old fold
   * order-dependent.
   */
  record(
    client: number,
    from: number,
    to: number,
    writer: WriterIdentity,
    streamPosition: number,
  ): void {
    if (to <= from) return;
    const ranges = this.byClient.get(client) ?? [];
    ranges.push({ from, to, writer, streamPosition });
    this.byClient.set(client, ranges);
  }

  /**
   * The authenticated writer of the item at `(client, clock)`, or `null` if
   * unattributed. When more than one range covers the clock (overlapping
   * declarations), the EARLIEST-stream-position range wins — the genuine original
   * writer, independent of replay order.
   */
  writerAt(client: number, clock: number): WriterIdentity | null {
    const ranges = this.byClient.get(client);
    if (!ranges) return null;
    let best: AttributedRange | null = null;
    for (const r of ranges) {
      if (clock < r.from || clock >= r.to) continue;
      if (best === null || r.streamPosition < best.streamPosition) best = r;
    }
    return best?.writer ?? null;
  }
}

/**
 * A server-authoritative caught-up replica of ONE room's conversation. Wraps a
 * {@link ConversationDoc} (inheriting every P6F-1 invariant) and adds the
 * authenticated-writer binding P6F-2 owns.
 */
export class ServerRoomReplica {
  private readonly convo: ConversationDoc;
  private readonly ledger = new WriterLedger();
  /** Tags the replica's own authenticated applies so its `update` fan-out (if any) can tell them apart. */
  private readonly applyOrigin = Symbol('server-replica-authenticated-apply');

  /**
   * The DISTINCT durable-stream rows this replica has folded in, keyed by each
   * row's IMMUTABLE `stream_seq` (a per-room, gap-free, strictly-increasing bigint
   * minted at append time, migration 0055 — NEVER an array index or a count). A
   * SET, not a counter, on purpose (E3, #203): re-consuming a row — a duplicate
   * stream read, or the warm re-catch-up {@link RoomReplicaManager.acquire} runs on
   * every acquire — reuses its seq and folds as a no-op, and a row that was NEVER
   * applied (a poison row the fold quarantines) leaves its seq absent as a GAP.
   *
   * Because the key is a stable row identity rather than a positional index, a
   * REORDERED snapshot (a later-committed row whose in-flight txn stamped an earlier
   * `appended_at`) can no longer make a new row collide with an already-applied
   * row's ordinal: a seq belongs to exactly one row for the life of the room, so
   * that row is either folded (its seq present) or missing (its seq a gap). This is
   * the array-index collision the #203 gauntlet found, closed at the root.
   *
   * Moved ONLY by {@link catchUp} — the durable stream is the only thing that moves
   * a stream position; an in-process authenticated apply is content, not a consumed
   * stream row. Distinct from #209's CLIENT freshness witness (this proves the
   * SERVER replica is caught up to the stream, not that a client saw a fragment).
   */
  private readonly appliedRows = new Set<number>();

  /**
   * The highest CONTIGUOUS `stream_seq` folded — the largest `N` such that every
   * seq `1..N` is in {@link appliedRows}. This, not the set's size, is
   * {@link consumedStreamPosition}: a room's seqs are gap-free from 1 (migration
   * 0055), so a replica caught up to the head has folded every seq up to it with no
   * hole, and a MISSING row below the head (skipped/quarantined/reordered-away)
   * stalls this value below the head even if a LATER seq was folded — which the
   * set's size would falsely count. Advanced amortized-O(1) in {@link catchUp} as
   * each new seq closes the gap above it.
   */
  private contiguousHigh = 0;

  constructor(convo: ConversationDoc = new ConversationDoc()) {
    this.convo = convo;
  }

  /**
   * The durable-stream position this replica has consumed to — the highest
   * CONTIGUOUS `stream_seq` folded via {@link catchUp} (see {@link contiguousHigh}),
   * NEVER a row count. The freshness gate compares this against the stream head
   * (`max(stream_seq)`) captured at certify-request time and REFUSES to mint when
   * this trails it (fail-closed: never anchor content a lagging replica has not yet
   * caught up to). Keying on the highest contiguous seq — not the applied-set's
   * size — is what closes the #203 class: a row missing BELOW the head (skipped,
   * quarantined, or reordered away) leaves a gap that holds this value below the
   * head even if a later seq was folded, whereas a size count could reach the head
   * with a hole still open. See {@link appliedRows}.
   */
  consumedStreamPosition(): number {
    return this.contiguousHigh;
  }

  /** The wrapped conversation — its `bodyPath`, `messages`, `model`, `contentFragment`. */
  get conversation(): ConversationDoc {
    return this.convo;
  }

  /** The raw authoritative `Y.Doc` (guard callers prefer {@link authoritativeDoc}). */
  get doc(): Y.Doc {
    return this.convo.doc;
  }

  /**
   * The authoritative `Y.Doc` for {@link liveCovenantDoc}'s provider, or `null`
   * when there is nothing to vouch for — the replica is torn down OR the
   * `conversation-content` share is absent/empty. `null` fails the certify path
   * CLOSED (`derive_failed`) rather than certifying against an empty plant, which
   * is the whole point of the covenant. The reader ALSO fails closed on an empty
   * share via `conversationContentRoot`; returning `null` here is the earlier,
   * belt-and-suspenders guard the ticket asks for ("fail-closed if the room/share
   * is absent").
   */
  authoritativeDoc(): Y.Doc | null {
    if (this.convo.isDestroyed()) return null;
    return this.convo.contentFragment().length > 0 ? this.convo.doc : null;
  }

  /**
   * Seed the replica's authoritative content from a TRUSTED server-side source,
   * attributing every seeded item to `writer`. This is the server's own seat of
   * the initial conversation (the analogue of `ConversationDoc.seed`, which the
   * `/prototype` route uses locally) — in production the replica catches up from
   * the durable stream instead ({@link catchUp}); the durable stream's historical
   * authorship is a NAMED infra gap (see end of file).
   */
  seedAuthored(messages: readonly ChatMsg[], writer: WriterIdentity): this {
    this.attributeNewItems(writer, () => {
      this.convo.seed(messages);
    });
    return this;
  }

  /**
   * Apply a Yjs update that arrived over an AUTHENTICATED connection — the ONLY
   * write that binds authorship. `writer` is the authenticated connection's
   * identity (the ws server's `AtriumSession`, adjacent to #187), NOT anything the
   * update bytes carry. Every item this update newly integrates is attributed to
   * `writer` in the ledger. The content also converges (this IS an `applyUpdate`),
   * so this single call is both the authoritative CONTENT write and the AUTHORSHIP
   * record — exactly the shape a ws server needs: authenticate the frame, apply it
   * here, fan out to peers.
   */
  applyAuthenticatedUpdate(update: Uint8Array, writer: WriterIdentity): void {
    this.attributeNewItems(writer, () => {
      Y.applyUpdate(this.convo.doc, update, this.applyOrigin);
    });
  }

  /**
   * Fold ONE durable-stream row's update into the replica, replaying its PERSISTED
   * authorship (E3, #203 — the load-bearing property). This is the catch-up path
   * the {@link RoomReplicaManager} drives per `ydoc_updates` row during Electric
   * catch-up: the row's opaque `op` bytes converge the content AND its persisted
   * `writer_user_id`/`writer_kind` stamp (migration 0054) re-establishes authorship
   * — so after a COLD RESTART `authenticatedAuthorOf` returns the ORIGINAL writers
   * from DATA, never fail-closed-unknown. `writer === null` (a `system` row, or a
   * pre-0054 row that carries no author) folds content WITHOUT authorship, exactly
   * as before: those items read as unknown, fail-closed.
   *
   * `streamPosition` is the row's IMMUTABLE `stream_seq` — a per-room, gap-free,
   * strictly-increasing bigint minted at append time (migration 0055), supplied by
   * {@link RoomReplicaManager} as the fold ordinal. It is BOTH the row's dedupe
   * identity (a re-consumed row reuses its seq, so it never re-inflates the freshness
   * position or re-records the ledger) AND the tiebreak the ledger resolves
   * overlapping declarations by. Because the seq is a stable row identity rather than
   * a positional index, a reordered snapshot can never make a new row collide with an
   * already-applied row's ordinal (the #203 class). A row already folded is a no-op.
   *
   * ## RANGE-EXACT, and ORDER-INDEPENDENT — why it uses `parseUpdateMeta`, not the
   * state-vector delta {@link applyAuthenticatedUpdate} uses.
   *
   * The stamp must land on the `(client, clock)` ranges THIS row's op introduces,
   * and nothing else — an off-by-one would attribute a NEIGHBOR's item to the wrong
   * writer. `parseUpdateMeta(op)` reads the exact per-client `[from, to)` ranges the
   * op's own structs carry, INTRINSIC to the bytes: it does not depend on what is
   * already integrated, on whether this row's deps have arrived yet, or on the order
   * rows are replayed in. (The SV-delta the live path uses is right THERE — the
   * connection delivered exactly the newly-integrated items — but wrong here: a row
   * replayed before its causal dependency integrates NOTHING, so an after-minus-before
   * delta would be empty and the stamp would be lost, then mis-charged to whichever
   * later row happens to fill the gap.) Recording the op's declared ranges STAMPED
   * WITH THIS ROW'S STREAM POSITION means a replay in ANY order lands every stamp on
   * its own item, and — when a full-state row re-declares an EARLIER row's clocks —
   * {@link WriterLedger.writerAt}'s earliest-stream-position rule keeps the original
   * writer regardless of which row was replayed first.
   *
   * A PEER RACING APPENDS AROUND A RESTART cannot poison this: its live authenticated
   * writes land on NEW `(client, clock)` items under the peer's own clocks and its own
   * identity, and a durable row's earliest-position claim protects every clock a
   * replayed stamp already owns — a later declaration of an already-attributed clock
   * never re-homes it.
   */
  catchUp(update: Uint8Array, writer: WriterIdentity | null, streamPosition: number): void {
    // A row already folded (a duplicate stream read, or the warm re-catch-up on
    // acquire) is a no-op: its content is already integrated and its stamp already
    // recorded, and re-counting its seq would falsely advance the position.
    if (this.appliedRows.has(streamPosition)) return;

    // Parse the op's OWN declared ranges from the bytes — range-exact and
    // independent of whether this row's causal deps have arrived yet or of replay
    // order. `parseUpdateMeta` throws on garbage bytes (a poison row), which is the
    // quarantine trigger: it happens BEFORE any state change, so a poison row folds
    // nothing, records nothing, and leaves its seq a gap (fail-closed).
    const pending: Array<{ client: number; from: number; to: number }> = [];
    if (writer !== null) {
      const meta = Y.parseUpdateMeta(update);
      for (const [client, to] of meta.to) {
        const from = meta.from.get(client) ?? 0;
        if (to > from) pending.push({ client, from, to });
      }
    }

    // ATOMICITY (E3, #203 / B2). Integrate the content FIRST; only if `applyUpdate`
    // returns do we flush the ledger stamps and mark the seq consumed. A row that
    // parses but throws on integration therefore records NOTHING — no phantom ledger
    // entry, no consumed seq — so a re-acquire re-attempts it cleanly rather than
    // re-recording a stamp for content that never landed.
    Y.applyUpdate(this.convo.doc, update);

    if (writer !== null) {
      for (const { client, from, to } of pending) {
        this.ledger.record(client, from, to, writer, streamPosition);
      }
    }
    // One distinct durable-stream row consumed — record its seq and advance the
    // contiguous-prefix high-water mark past any gap this fold just closed (E3,
    // #203). Reached only after `applyUpdate` succeeded: a poison row's seq stays
    // absent, so the freshness position stays below the head (fail-closed).
    this.appliedRows.add(streamPosition);
    while (this.appliedRows.has(this.contiguousHigh + 1)) this.contiguousHigh += 1;
  }

  /**
   * Join the replica to a replication fabric (the in-memory hub in-sandbox,
   * Electric in production) for CONTENT convergence. Updates arriving this way are
   * unattributed — see {@link catchUp}. Returns the disposer.
   */
  connect(transport: ConversationTransport): () => void {
    return this.convo.connect(transport);
  }

  /**
   * The AUTHENTICATED author of a message's certified content, or `null`
   * (fail-closed ⇒ unknown/contested) when the body is unresolved, empty, carries
   * ANY unattributed content, or was co-written by MORE THAN ONE authenticated
   * writer.
   *
   * Authorship is derived from the authenticated writers of the CURRENT CONTENT the
   * reader renders — the text runs / embeds / marks INSIDE the genuine body child
   * ({@link ConversationDoc.genuineBodyContentItemIds}) — NOT from the body's
   * container seat. That distinction is the whole security property (P6F-2 HIGH):
   * a peer can catch up, DELETE a victim's text, and INSERT forged content INTO the
   * victim's OWN `Y.XmlText` container. The container item stays the victim's, but
   * every rendered character is now the peer's — carried by NEW content items under
   * the PEER's authenticated clocks. Reading the ledger over those content items
   * attributes the body to the PEER (the forger), never the victim:
   *
   *   - a body whose CURRENT content was all supplied by ONE authenticated writer ⇒
   *     that writer;
   *   - a body whose content a DIFFERENT authenticated writer edited/replaced ⇒ THAT
   *     writer (the forger authors its own forgery, never inherits the victim's);
   *   - a body MIXING two authenticated writers' content ⇒ `null` (contested,
   *     fail-closed — never silently one of them, never the victim);
   *   - a body with ANY content from unauthenticated `catchUp()` ⇒ `null` (unknown);
   *   - an unresolved or empty body ⇒ `null`.
   *
   * The item identity a content run carries is CONVERGENT, not an authorship proof
   * on its own — a crafted `client` decides nothing here, because the ledger is keyed
   * by WHICH authenticated connection DELIVERED the item, not by the item's `client`
   * field ({@link WriterLedger}).
   */
  authenticatedAuthorOf(messageId: string): WriterIdentity | null {
    const contentItems = this.convo.genuineBodyContentItemIds(messageId);
    if (contentItems === null || contentItems.length === 0) return null;
    let author: WriterIdentity | null = null;
    for (const item of contentItems) {
      const writer = this.ledger.writerAt(item.client, item.clock);
      if (writer === null) return null; // any unattributed run ⇒ unknown, fail-closed
      if (author === null) {
        author = writer;
      } else if (author.userId !== writer.userId || author.principalKind !== writer.principalKind) {
        return null; // content co-written by >1 authenticated writer ⇒ contested, fail-closed
      }
    }
    return author;
  }

  /** Tear the replica down (drops its doc; `authoritativeDoc` then fails closed). */
  destroy(): void {
    this.convo.destroy();
  }

  /**
   * Run `write` and attribute every Yjs item it newly integrates to `writer`. The
   * state-vector delta (per-client frontier before vs after) is EXACTLY the set of
   * items this write integrated, so each client's `[before, after)` clock range is
   * the new authored range. Pending items a gap leaves un-integrated are not
   * attributed until a later write fills the gap and integrates them — at which
   * point that write's writer gets them, which is the honest answer.
   */
  private attributeNewItems(writer: WriterIdentity, write: () => void): void {
    const doc = this.convo.doc;
    const before = Y.decodeStateVector(Y.encodeStateVector(doc));
    write();
    const after = Y.decodeStateVector(Y.encodeStateVector(doc));
    for (const [client, toClock] of after) {
      const fromClock = before.get(client) ?? 0;
      // A live apply has no durable ordinal — its items are new clocks no durable row
      // has declared, so it only ever loses a tie to a durable row that later
      // re-declares the SAME item with the SAME writer. See {@link LIVE_APPLY_POSITION}.
      if (toClock > fromClock) {
        this.ledger.record(client, fromClock, toClock, writer, LIVE_APPLY_POSITION);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ROOM → REPLICA REGISTRY. `liveCovenantDoc(roomId)` consults this to hand
// the certify path the authoritative doc for a room. In-process for the seam; the
// production topology (a shared long-lived replica the certify path can reach) is
// a NAMED infra gap below.
// ─────────────────────────────────────────────────────────────────────────────

const registry = new Map<string, ServerRoomReplica>();

/** Register (or replace) the authoritative replica for a room. */
export function registerServerReplica(roomId: string, replica: ServerRoomReplica): void {
  registry.set(roomId, replica);
}

/** The authoritative replica for a room, or `null` if none is live (fail-closed). */
export function serverReplicaFor(roomId: string): ServerRoomReplica | null {
  return registry.get(roomId) ?? null;
}

/** Drop a room's replica (e.g. on teardown). */
export function unregisterServerReplica(roomId: string): void {
  registry.delete(roomId);
}

/** Clear every registered replica — test isolation only. */
export function clearServerReplicas(): void {
  registry.clear();
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE PRODUCTION SERVER REPLICA — E3 (#203) retired the four named gaps this block
 * used to list. What each was, and where it now lives:
 *
 *  1. THE CATCH-UP SOURCE — was "converges only from a `ConversationTransport`".
 *     Now `RoomReplicaManager` ({@link ./room-replica-manager}) catches a replica
 *     up from the durable stream itself: a snapshot of the room's `ydoc_updates`
 *     rows in stream order (the Electric shape's rows), folded via {@link catchUp}.
 *     No in-process append feed — the row is the source of truth.
 *
 *  2. THE LIFECYCLE / INGRESS — `RoomReplicaManager` lazy-starts a replica on first
 *     need and idle-evicts it; eviction is FAIL-CLOSED ({@link serverReplicaFor}
 *     ⇒ `null` ⇒ the reader yields `~`, never a stale `✓`). The authenticated-write
 *     ingress ({@link applyAuthenticatedUpdate}) is still the ws server's job to
 *     wire (its writer comes from the connection's `AtriumSession`), but the door
 *     it writes THROUGH — the `ydoc_updates` append that stamps the writer — is E2
 *     (#202); the replica reads that stamp back on catch-up.
 *
 *  3. AUTHORSHIP ACROSS A COLD RESTART — RETIRED, the load-bearing property. E2
 *     (migration 0054) persists `writer_user_id`/`writer_kind` on every row; E3
 *     replays that stamp into the ledger, RANGE-EXACT, as {@link catchUp} folds each
 *     row (see that method). After a restart `authenticatedAuthorOf` returns the
 *     ORIGINAL writers from DATA — no longer fail-closed-to-unknown.
 *
 *  4. THE REGISTRY'S TOPOLOGY — the web process's replica IS its authority (NO RPC):
 *     the certify path lazy-starts and reads the SAME in-process replica through this
 *     registry, so there is no cross-process reach to broker. Two web processes each
 *     catch up independently from the shared durable stream and converge to identical
 *     content — the registry stays the per-process seam `liveCovenantDoc` reads.
 *
 * What remains genuinely infra-pending is the LIVE Electric subscription (streaming
 * new rows into a warm replica between catch-ups) and the ws authenticated-write
 * ingress — both need an Electric service / ws server the sandbox cannot stand up.
 * The catch-up + freshness + authorship-replay seam is complete and compose-tested.
 * ───────────────────────────────────────────────────────────────────────────── */
