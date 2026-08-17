/* ═══════════════════════════════════════════════════════════════════════════
 * THE CONVERSATION TRANSPORT SEAM (#183) — the one boundary we OWN, the CRDT we
 * RENT.
 *
 * ## What we rent vs what we own
 *
 * We RENT Yjs. A `ConversationDoc` (yjs-conversation.ts) is a `Y.Doc`; its
 * messages live in a `Y.Array`. Concurrent inserts from two peers converge by
 * Yjs's own algorithm — WE NEVER WRITE MERGE LOGIC. The moment this file starts
 * comparing versions, ordering operations, or reconciling state, it has begun
 * rebuilding DeltaDB, which is the explicit Phase-6 anti-goal (map #162). It does
 * none of that.
 *
 * We OWN this seam: a transport moves OPAQUE Yjs update bytes between a local
 * `Y.Doc` and the durable stream, and nothing else. `Y.encodeStateAsUpdate` /
 * `Y.applyUpdate` are the only Yjs calls it makes, and it treats their payload as
 * a sealed envelope. Two implementations satisfy it:
 *
 *   - `InMemoryConversationHub` (this file) — an in-process relay. It is the
 *     PROOF harness: two docs joined to one hub converge live, with zero network
 *     and zero infrastructure. This is what the two-client convergence test runs
 *     against, per the #183 infra guardrail (Electric's durable stream needs a
 *     Postgres logical-replication service we cannot stand up in the sandbox).
 *
 *   - `ElectricConversationTransport` (electric-transport.ts) — the PRODUCTION
 *     relay, backed by `@electric-sql/y-electric`'s `ElectricProvider` over
 *     Electric Durable Streams. Same seam, same opaque bytes; the only difference
 *     is the wire. It is import-guarded behind a config object so the sandbox
 *     (which has no Electric service) never constructs it.
 *
 * The covenant ledger is NOT in the Yjs doc and NOT on this transport — it stays
 * the gated Postgres store, synced read-only elsewhere (#181). This seam carries
 * conversation content only.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { Doc as YDoc } from 'yjs';
import { applyUpdate, encodeStateAsUpdate } from 'yjs';

/**
 * The transport contract. An implementation joins a `Y.Doc` to some replication
 * fabric: it ships the doc's local updates outward and applies inbound updates
 * back into the doc. It returns a disposer that detaches the doc.
 *
 * The contract is deliberately tiny — one method, one disposer — because every
 * byte of CRDT intelligence lives in Yjs, not here. An implementation that needs
 * more than "relay these opaque updates" is doing the substrate's job.
 */
export interface ConversationTransport {
  /**
   * Attach `doc` to the fabric. After this call the doc's updates are shipped
   * outward and remote updates are applied inward until the returned disposer is
   * invoked. Implementations MUST treat every update payload as opaque bytes.
   */
  connect(doc: YDoc): () => void;
}

/**
 * An in-process replication hub — the rented-substrate PROOF, standing in for
 * Electric's durable stream with no network and no Postgres.
 *
 * Every doc that {@link join}s the hub is brought up to the hub's current state
 * and thereafter receives every other member's updates. The hub holds a single
 * merged `Y.Doc` as the shared "server" state, exactly as Electric's durable
 * stream holds the merged document server-side: a joiner is caught up from it,
 * and each local update is folded into it and fanned out. All merging is Yjs's;
 * the hub only routes `encodeStateAsUpdate`/`applyUpdate` byte payloads.
 */
export class InMemoryConversationHub {
  private readonly members = new Set<YDoc>();
  private readonly origins = new WeakMap<YDoc, symbol>();

  constructor(private readonly server: YDoc) {}

  /**
   * A transport bound to this hub. One hub models one durable stream (one room);
   * every doc connected through it shares that stream.
   */
  transport(): ConversationTransport {
    return { connect: (doc) => this.join(doc) };
  }

  private join(doc: YDoc): () => void {
    // A per-doc origin tag so a doc never re-applies the update it just emitted
    // (Yjs tags every transaction with the origin passed to `applyUpdate`).
    const origin = Symbol('conversation-transport');
    this.origins.set(doc, origin);

    // Catch the joiner up to the shared stream, and seed the stream with
    // anything the joiner already holds — both directions, both opaque updates.
    applyUpdate(doc, encodeStateAsUpdate(this.server), origin);
    applyUpdate(this.server, encodeStateAsUpdate(doc));

    const onUpdate = (update: Uint8Array, updateOrigin: unknown) => {
      // Ignore echoes of updates WE just applied to this doc.
      if (updateOrigin === origin) return;
      // Fold the local update into the shared stream and fan it out to peers.
      applyUpdate(this.server, update);
      for (const peer of this.members) {
        if (peer === doc) continue;
        applyUpdate(peer, update, this.origins.get(peer));
      }
    };

    doc.on('update', onUpdate);
    this.members.add(doc);

    return () => {
      doc.off('update', onUpdate);
      this.members.delete(doc);
    };
  }
}
