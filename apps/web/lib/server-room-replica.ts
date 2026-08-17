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
 * So this replica separates the two:
 *
 *   - CONVERGENCE — {@link connect} joins the replica to the durable stream /
 *     in-memory hub, and {@link catchUp} folds a whole-doc update in. Both move
 *     content and NOTHING about authorship: an item that arrives this way has
 *     `authenticatedAuthorOf === null` (unknown), fail-closed.
 *
 *   - AUTHORSHIP — {@link applyAuthenticatedUpdate} is the ONLY write that binds
 *     an item to a writer. It applies an update that arrived over an
 *     AUTHENTICATED connection (the ws server's `AtriumSession`, adjacent to
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

/** One attributed clock range for a client: `[from, to)` written by `writer`. */
interface AttributedRange {
  readonly from: number;
  readonly to: number;
  readonly writer: WriterIdentity;
}

/**
 * The authenticated-writer ledger. It maps each Yjs item — identified by its
 * `(client, clock)` — to the authenticated writer whose connection first
 * introduced it. This is the un-forgeable core: the KEY is the CRDT item
 * identity, but the VALUE is decided by WHO delivered it over an authenticated
 * connection, so a crafted `client` field can never reassign an existing item's
 * author, and a new crafted item is attributed to its own deliverer.
 *
 * First-writer-wins per `(client, clock)`: once an item is attributed, a later
 * apply of the SAME item (a replay) does not overwrite it — Yjs would dedupe the
 * item anyway, but the ledger is explicit so a re-recorded range cannot silently
 * re-home an already-authored item.
 */
class WriterLedger {
  private readonly byClient = new Map<number, AttributedRange[]>();

  /** Attribute the newly-integrated `[from, to)` clock range of `client` to `writer`. */
  record(client: number, from: number, to: number, writer: WriterIdentity): void {
    if (to <= from) return;
    const ranges = this.byClient.get(client) ?? [];
    // First-writer-wins: only attribute the sub-range not already claimed. Yjs
    // integrates each item exactly once, so in practice `from` is the previous
    // frontier and no overlap exists — but clamp defensively so a replay or an
    // out-of-order fill can never re-home an already-attributed clock.
    let start = from;
    for (const r of ranges) {
      if (r.to <= start || r.from >= to) continue;
      // Overlap — skip the already-claimed slice.
      if (r.from <= start) start = Math.max(start, r.to);
    }
    if (start < to) ranges.push({ from: start, to, writer });
    this.byClient.set(client, ranges);
  }

  /** The authenticated writer of the item at `(client, clock)`, or `null` if unattributed. */
  writerAt(client: number, clock: number): WriterIdentity | null {
    const ranges = this.byClient.get(client);
    if (!ranges) return null;
    for (const r of ranges) {
      if (clock >= r.from && clock < r.to) return r.writer;
    }
    return null;
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

  constructor(convo: ConversationDoc = new ConversationDoc()) {
    this.convo = convo;
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
   * Fold a whole-doc / catch-up update into the replica WITHOUT authorship. This
   * is the convergence-only path — a catch-up from the durable stream's history
   * whose per-item authenticated writer this process did not itself observe. Items
   * it integrates are UNATTRIBUTED (`authenticatedAuthorOf === null` ⇒ unknown),
   * fail-closed, until an authenticated write re-establishes authorship. Kept
   * distinct from {@link applyAuthenticatedUpdate} on purpose: convergence is not
   * authorship, and conflating them is the exact hole P6F-1 routed here.
   */
  catchUp(update: Uint8Array): void {
    Y.applyUpdate(this.convo.doc, update);
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
      if (toClock > fromClock) this.ledger.record(client, fromClock, toClock, writer);
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
 * NAMED INFRA GAP — what the PRODUCTION server replica needs beyond this seam.
 *
 *  1. THE CATCH-UP SOURCE. This replica converges from a `ConversationTransport`.
 *     In production that is `electricConversationTransport(config)` over Electric
 *     Durable Streams, which needs (electric-transport.ts, verbatim): an Electric
 *     sync service in front of Postgres with `wal_level = logical`; the
 *     `ydoc_updates` / `ydoc_awareness` bytea tables; and a write endpoint that
 *     appends `op` rows. None stands up in-sandbox — hence the in-memory hub here.
 *
 *  2. THE AUTHENTICATED-WRITE INGRESS. `applyAuthenticatedUpdate(update, writer)`
 *     is driven directly in tests. In production the writer comes from the ws
 *     server's AUTHENTICATED connection (`AtriumSession`, ws-presence-server.ts /
 *     #187): a client's Yjs update arrives as an authenticated frame, the server
 *     resolves `writer = { userId, principalKind }` from the connection's session,
 *     calls this method, and fans the update out to peers. Wiring that frame into
 *     `ws-presence-server.ts`'s command path is the follow-up; the binding it
 *     needs is exactly this method's signature.
 *
 *  3. HISTORICAL AUTHORSHIP ACROSS A SERVER RESTART. The ledger is in-process, so
 *     a replica caught up from the durable stream after a restart sees content but
 *     not the per-item authenticated writer that produced it (⇒ {@link catchUp}
 *     attributes nothing; those items read as unknown, fail-closed). To make
 *     authorship survive a restart, the authenticated writer must be PERSISTED
 *     alongside each durable update (a signed authorship envelope, or an
 *     append-time `writer` column keyed to the update's item ranges) and replayed
 *     into the ledger on catch-up. Fail-closed-to-unknown is the safe interim: it
 *     never mis-attributes, it only declines to vouch.
 *
 *  4. THE REGISTRY'S TOPOLOGY. `registry` is per-process. The certify Server
 *     Action (`apps/web`) and the replica-maintaining ws server (`apps/server`)
 *     are separate processes in the shipped topology, so in production the action
 *     must reach the replica the ws server maintains — co-locate them in one
 *     process, or expose an internal authoritative-read RPC the action calls. The
 *     registry is the seam that swap slots into without touching `liveCovenantDoc`.
 * ───────────────────────────────────────────────────────────────────────────── */
