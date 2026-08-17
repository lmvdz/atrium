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
import { z } from 'zod';
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

  /**
   * THE NON-CRDT AUTHORITY SOURCE (#183 F1). Which message ids carry a certified
   * `✓`, keyed by id — held OUTSIDE the `Y.Doc`, so it never rides the
   * peer-writable wire and a peer can never forge a settlement. A message that is
   * not in this set projects `~`/routine, never `✓`. It is populated ONLY from a
   * trusted local source ({@link seed} on the fixture route, or #181's gated read
   * authority in production), never from an inbound CRDT update. Until #181 lands
   * the production default is empty — every live line is `~` until a gated door
   * says otherwise, which is the covenant-correct default.
   */
  private readonly certifiedIds = new Set<string>();

  /**
   * THE TRUST FINGERPRINTS (#183 round-2 — closes the executed id-collision
   * forgery). Round 1 keyed `✓` by message id alone, so a peer could append a
   * message with a SEEDED id (or delete the original and keep forged content
   * under it) and inherit the trusted line's `✓`/provenance. This binds trust to
   * the CONTENT of each SEEDED message — id → its canonical durable payload —
   * held OUTSIDE the `Y.Doc`. A message projects authenticated who/kind/`✓` only
   * if its content fingerprint matches the trusted one recorded at {@link seed};
   * a forgery under a colliding id has different content, so it fails the match
   * and projects as UNVERIFIED (`authorKind:'unknown'`, no `✓`). Nothing that
   * arrives over the wire is in this map, so on a live (unseeded) doc EVERYTHING
   * is unverified until #181's gated read supplies the real envelope.
   */
  private readonly trustedFingerprints = new Map<string, string>();

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
   *
   * The fixture is a TRUSTED local source (the `/prototype` design route, not a
   * peer over the wire), so its `certified` fields are recorded into the non-CRDT
   * {@link certifiedIds} authority — this is the ONE place a `✓` originates on the
   * fixture route. The durable payload itself still carries zero authority
   * ({@link encodeMessage} strips it): the authority lives beside the doc, never
   * inside it.
   */
  seed(messages: readonly ChatMsg[]): this {
    if (this.array.length > 0) return this;
    for (const message of messages) {
      // Record the trusted CONTENT fingerprint for EVERY seeded message (so its
      // who/kind project authentically), and the certified ids for the `✓`. Both
      // are keyed to the exact trusted content, so a later peer append under a
      // colliding id cannot inherit either — its fingerprint will not match.
      this.trustedFingerprints.set(message.id, encodeMessage(message));
      if (message.certified === true) this.certifiedIds.add(message.id);
    }
    this.doc.transact(() => {
      this.array.push(messages.map((message) => encodeMessage(message)));
    });
    return this;
  }

  /**
   * Append one message as an atomic, mergeable array element. This is the
   * PEER-WRITABLE path: whatever authority field the caller sets is STRIPPED by
   * {@link encodeMessage} and is NOT recorded into {@link certifiedIds}, so an
   * appended line — local or arriving over a transport — can never forge a `✓`.
   * Certification only ever comes from the gated non-CRDT source.
   */
  append(message: ChatMsg): this {
    this.doc.transact(() => {
      this.array.push([encodeMessage(message)]);
    });
    return this;
  }

  /**
   * The current messages, in the doc's converged order (never carrying
   * authority). Every element is VALIDATED and QUARANTINED (#183 round-2): a
   * peer-inserted raw object, malformed JSON, or a shape-invalid element is
   * dropped, never thrown on — so a hostile write cannot crash `messages()` (and
   * therefore the projection) and converge that crash to every client.
   */
  messages(): ChatMsg[] {
    const out: ChatMsg[] = [];
    for (const element of this.array.toArray()) {
      const message = decodeElement(element);
      if (message !== null) out.push(message);
    }
    return out;
  }

  /** Whether this doc is torn down — guards the hook against reusing a dead instance. */
  isDestroyed(): boolean {
    return this.doc.isDestroyed;
  }

  /**
   * Project the doc to the `ConversationModel` the surface renders — the SAME
   * transform the mock path uses. `room` and `participants` are the selection's
   * projection (the covenant/registry concerns that are not conversation content
   * and so are not in the doc); the messages come live from the CRDT; the `✓`/`~`
   * glyph comes from the non-CRDT {@link certifiedIds} authority, NEVER the doc.
   */
  model(room: string, participants: readonly ParticipantSummary[]): ConversationModel {
    return buildConversationModel(this.messages(), room, participants, {
      // A message is TRUSTED only if its content fingerprint matches the one
      // recorded from a trusted {@link seed}. Anything appended locally or arriving
      // over a transport — including a forgery under a seeded id — fails this match
      // and projects as UNVERIFIED (`authorKind:'unknown'`, no `✓`). The `✓`
      // authority stays keyed by id, but is only ever CONSULTED for a trusted
      // message, so a peer-keyed id can never source one (#183 round-2, #162).
      trusts: (message) => this.trustedFingerprints.get(message.id) === encodeMessage(message),
      certifiedIds: this.certifiedIds,
    });
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
   A message is stored as a canonical JSON string of its CONVERSATION-CONTENT
   fields ONLY. This is an ALLOWLIST, not a denylist (#183 F1): the durable
   payload is built by picking the known content fields, so any authority /
   epistemic / settlement field — `certified` today, anything added tomorrow — is
   structurally absent from the peer-writable doc and cannot be forged over the
   wire. `JSON.stringify` drops `undefined` fields, so the round-trip carries
   exactly the defined content shape the builder reads. This is the ONLY place
   `ChatMsg` meets the substrate.

   Why allowlist and not `delete message.certified`: a denylist fails open the
   moment a second authority field is added and nobody remembers to add it here;
   an allowlist fails closed — a new field is absent from the wire until it is
   deliberately added to `DURABLE_FIELDS`, which is a diff a reviewer sees. */

/** The conversation-content fields that are allowed onto the peer-writable doc.
 *  `reply` was dropped in #183 round-2: it was durable but NEVER projected (the
 *  feed reads `turn.conclusion.reply`, a nested field, not a top-level one), so
 *  it was an ornamental durable field — off the wire now, no reader lost. */
const DURABLE_FIELDS = ['id', 'time', 'kind', 'who', 'text', 'turn', 'image'] as const;

/** The content-only projection of a `ChatMsg` — carries zero authority state. */
type DurableMessage = Pick<ChatMsg, (typeof DURABLE_FIELDS)[number]>;

function encodeMessage(message: ChatMsg): string {
  const durable: DurableMessage = { id: message.id, time: message.time, kind: message.kind };
  for (const field of DURABLE_FIELDS) {
    const value = message[field];
    if (value !== undefined) (durable as Record<string, unknown>)[field] = value;
  }
  return JSON.stringify(durable);
}

/* ── the decode validator (#183 round-2 — closes the executed DoS) ───────────
   Round 1 decoded with `JSON.parse(...) as ChatMsg` and NO validation: a peer
   could insert a raw object (crashing `JSON.parse`) or a shape-invalid element,
   and `messages()` threw — a crash that converged to every client (a DoS). This
   validates every element through zod, over the SAME allowlist `encodeMessage`
   writes, so it ALSO closes the asymmetric-decode residual (a raw object smuggled
   past the codec has its non-content keys — `certified` and anything else — strip-
   ped by the schema). `kind` must be a real `ChatKind`; `id`/`time` are required;
   the structured `turn`/`image` shapes pass through losslessly (they are design-
   shell content, only rendered for TRUSTED messages). An element that fails is
   QUARANTINED (decode returns `null`), never thrown on. */
const DURABLE_MESSAGE_SCHEMA = z.object({
  id: z.string(),
  time: z.string(),
  kind: z.enum(['system', 'agent', 'human']),
  who: z.string().optional(),
  text: z.string().optional(),
  // `turn` / `image` are structured content shells: validate that each is an
  // object and preserve every nested key verbatim (a lossless round-trip), rather
  // than re-deriving a deep schema the fixture would have to track field-for-field.
  turn: z.looseObject({}).optional(),
  image: z.looseObject({}).optional(),
});

/**
 * Decode one durable array element to a `ChatMsg`, or `null` if it is not a valid
 * content message. Accepts a hostile input of any type: a non-string (a raw peer
 * object) is validated as-is; a string is `JSON.parse`d first (malformed JSON ⇒
 * `null`). Unknown top-level keys (e.g. a forged `certified`) are stripped by the
 * schema, so the decode side enforces the same content allowlist as encode.
 */
function decodeElement(element: unknown): ChatMsg | null {
  let raw: unknown = element;
  if (typeof element === 'string') {
    try {
      raw = JSON.parse(element);
    } catch {
      return null;
    }
  }
  const parsed = DURABLE_MESSAGE_SCHEMA.safeParse(raw);
  return parsed.success ? (parsed.data as ChatMsg) : null;
}
