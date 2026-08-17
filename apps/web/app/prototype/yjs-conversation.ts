/* ═══════════════════════════════════════════════════════════════════════════
 * THE YJS-BACKED CONVERSATION (#183) — re-seating the swap seam's SOURCE.
 *
 * The prototype's `ConversationModel` (conversation-model.ts) is the shape the
 * conversation column renders through; its designed promise is that Phase 6
 * "replaces the substrate under the conversation with a Yjs/CRDT-backed live
 * document" and "THE COMPONENTS MUST NOT CHANGE when that happens."
 *
 * This file is that substrate. A `ConversationDoc` is a real `Y.Doc` whose
 * messages live in a `Y.Array` — the rented CRDT. It produces a
 * `ConversationModel` through the SAME `buildConversationModel` the mock path
 * uses, so the Yjs-backed model is byte-identical to the mock one for the same
 * messages (test/yjs-conversation.test.ts), and live when a transport is joined
 * (two clients converge). The source is the only thing that changed.
 *
 * ## What we rent vs own
 *   - RENT: Yjs (the `Y.Array` CRDT + its merge) and Electric Durable Streams
 *     (the wire, via `ConversationTransport`). No merge logic is written here.
 *   - OWN: this adapter — how a `ChatMsg` maps to a durable array element, and
 *     how the array projects back to the model the surface consumes.
 *
 * ## Message granularity
 * Each `ChatMsg` is one atomic element in the `Y.Array` (stored as a canonical
 * JSON string so the round-trip is lossless and each message merges as a whole).
 * Concurrent appends from two peers converge to one deterministically-ordered
 * feed — Yjs's guarantee, not ours. Sub-message co-editing (a `Y.Text` per body
 * span, for cursor-anywhere annotation) is a later refinement (#184/#185); the
 * #183 acceptance is message-level convergence, which this delivers.
 *
 * The covenant ledger is NOT here. It stays the gated Postgres store, synced
 * read-only (#181) — a certified `✓` is never a value inside this Yjs doc.
 * ═════════════════════════════════════════════════════════════════════════ */

import { Doc as YDoc } from 'yjs';
import type { ParticipantSummary } from '@/src/components/model';
import { buildConversationModel, type ConversationModel } from './conversation-model';
import type { ConversationTransport } from './conversation-transport';
import { conversationFor, participantsFor, sessionFor } from './seams';
import type { ChatMsg, Selection } from './types';

/** The Yjs array key the conversation's messages live under, within the doc. */
const MESSAGES_KEY = 'messages';

/**
 * A conversation as a live Yjs document. Wraps a `Y.Doc`; its `Y.Array` of
 * messages is the CRDT that converges across peers. Everything the surface reads
 * comes out through {@link model}; everything a peer writes goes in through
 * {@link append}. Merging and ordering are Yjs's — this class only maps between
 * `ChatMsg` and the durable array element.
 */
export class ConversationDoc {
  readonly doc: YDoc;

  constructor(doc: YDoc = new YDoc()) {
    this.doc = doc;
  }

  private get array() {
    return this.doc.getArray<string>(MESSAGES_KEY);
  }

  /**
   * Seed the doc with an initial conversation. A no-op if the doc already
   * carries messages (e.g. it was caught up from a durable stream first), so a
   * client that connects before seeding never doubles the history.
   */
  seed(messages: readonly ChatMsg[]): this {
    if (this.array.length > 0) return this;
    this.doc.transact(() => {
      this.array.push(messages.map((message) => encodeMessage(message)));
    });
    return this;
  }

  /** Append one message as an atomic, mergeable array element. */
  append(message: ChatMsg): this {
    this.doc.transact(() => {
      this.array.push([encodeMessage(message)]);
    });
    return this;
  }

  /** The current messages, in the doc's converged order. */
  messages(): ChatMsg[] {
    return this.array.toArray().map((element) => decodeMessage(element));
  }

  /**
   * Project the doc to the `ConversationModel` the surface renders — the SAME
   * transform the mock path uses. `room` and `participants` are the selection's
   * projection (the covenant/registry concerns that are not conversation content
   * and so are not in the doc); the messages come live from the CRDT.
   */
  model(room: string, participants: readonly ParticipantSummary[]): ConversationModel {
    return buildConversationModel(this.messages(), room, participants);
  }

  /**
   * Subscribe to convergence: `listener` fires whenever the doc's messages
   * change, whether from a local `append` or a remote update arriving over a
   * transport. Returns an unsubscribe.
   */
  onChange(listener: () => void): () => void {
    const handler = () => listener();
    this.array.observeDeep(handler);
    return () => this.array.unobserveDeep(handler);
  }

  /** Join this doc to a replication fabric (in-memory hub, or Electric). */
  connect(transport: ConversationTransport): () => void {
    return transport.connect(this.doc);
  }

  destroy(): void {
    this.doc.destroy();
  }
}

/**
 * A `ConversationDoc` seeded from the selection's mock conversation — the
 * drop-in the surface can render off TODAY, on the fixture route, with no
 * Electric infrastructure. Its `model(...)` output equals `conversationModel`'s
 * for the same selection (proven in the test), so wiring the feed through it
 * changes the substrate without changing a pixel. In production the same doc is
 * caught up from Electric instead of seeded from the mock.
 */
export function conversationDocFor(selection: Selection): ConversationDoc {
  return new ConversationDoc().seed(conversationFor(selection));
}

/** The `room` a selection's conversation belongs to — the model's room field. */
export function roomFor(selection: Selection): string {
  return sessionFor(selection).agent.room;
}

/** The participants a selection's conversation carries — the model's roster. */
export function participantsForSelection(selection: Selection): readonly ParticipantSummary[] {
  return participantsFor(selection);
}

/**
 * Project a `ConversationDoc` to the surface's model for a given selection. The
 * room and roster come from the selection seam; the messages come live from the
 * doc. This is the exact call the feed makes.
 */
export function conversationModelFromDoc(
  doc: ConversationDoc,
  selection: Selection,
): ConversationModel {
  return doc.model(roomFor(selection), participantsForSelection(selection));
}

/* ── the durable element codec ─────────────────────────────────────────────
   A message is stored as a canonical JSON string: `JSON.stringify` drops
   `undefined` fields (so the round-trip carries exactly the defined shape the
   builder reads) and gives each message a single opaque array element that Yjs
   merges as a whole. This is the ONLY place `ChatMsg` meets the substrate. */

function encodeMessage(message: ChatMsg): string {
  return JSON.stringify(message);
}

function decodeMessage(element: string): ChatMsg {
  return JSON.parse(element) as ChatMsg;
}
