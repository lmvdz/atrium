/* ═══════════════════════════════════════════════════════════════════════════
 * THE YJS-BACKED CONVERSATION (#183 → #194 / P6F-1) — re-seating the swap seam's
 * SOURCE, now with RICH-TEXT MESSAGE BODIES.
 *
 * The prototype's `ConversationModel` (conversation-model.ts) is the shape the
 * conversation column renders through; its designed promise is that Phase 6
 * "replaces the substrate under the conversation with a Yjs/CRDT-backed live
 * document" and "THE COMPONENTS MUST NOT CHANGE when that happens."
 *
 * This file is that substrate. A `ConversationDoc` is a real `Y.Doc`. Two shares
 * live in it:
 *
 *   - the MESSAGE INDEX — a `Y.Array` of authority-stripped metadata elements
 *     (id/time/kind/who/turn/image), the converged, id-quarantined ORDER; and
 *   - the CONTENT — a `Y.XmlFragment` (the rented y-prosemirror shape) whose
 *     blocks each hold ONE `Y.XmlText` body. Each message's TEXT is now a live,
 *     in-place-mutable rich-text span, so two peers can co-edit a single body and
 *     converge, and the covenant reader (`CovenantDocReaderProd`, SL-2) can
 *     resolve a SUB-MESSAGE range against it.
 *
 * It produces a `ConversationModel` through the SAME `buildConversationModel` the
 * mock path uses, so the Yjs-backed model is byte-identical to the mock one for
 * the same messages (test/yjs-conversation.test.ts), and live when a transport is
 * joined (two clients converge — on an APPEND and now on an in-BODY edit).
 *
 * ## What we rent vs own
 *   - RENT: Yjs (the `Y.Array` + `Y.XmlText` CRDTs and their merge) — the
 *     `Y.XmlText` bodies ARE the y-prosemirror fragment shape (rich-text stack in
 *     `package.json`: `y-prosemirror` + `prosemirror-model`/`-state`). Electric
 *     Durable Streams (the wire, via `ConversationTransport`). No merge logic here.
 *   - OWN: this adapter — how a `ChatMsg` maps to (metadata element + rich-text
 *     body), how the shares project back to the model, and — the hard part — how
 *     every #183 security invariant is RE-ESTABLISHED on an in-place-mutable body.
 *
 * ## Re-establishing #183 on an in-place-mutable body (the P6F-1 delta)
 * A `Y.XmlText` mutates IN PLACE, so #183's "the FIRST array element for an id
 * wins; quarantine the rest" no longer covers the text: a peer can EDIT a trusted
 * seeded body directly, leaving the metadata element (and its id) untouched. So:
 *   - the TRUST FINGERPRINT now binds the FULL message INCLUDING its live body
 *     text ({@link ConversationDoc.model}'s `trusts`). A peer that mutates a
 *     seeded body changes the reconstructed content, the fingerprint stops
 *     matching, and the line DEMOTES to UNVERIFIED (`authorKind:'unknown'`) —
 *     fail-closed, never a forged authenticated line;
 *   - the CRDT still projects ZERO `✓` (`certifiedIds = NO_CERTIFICATION`);
 *   - the metadata channel is still an ALLOWLIST-stripped, id-quarantined,
 *     zod-validated `Y.Array`, so authority forgery / id-collision / hostile
 *     shapes are closed exactly as in #183;
 *   - a hostile Yjs value inside a body fails CLOSED AT THE READER (a throw ⇒
 *     DRIFT in `resolveCovenant`), never a false `✓`.
 *
 * The covenant ledger is NOT here. It stays the gated Postgres store, synced
 * read-only (#181) — a certified `✓` is never a value inside this Yjs doc.
 * ═════════════════════════════════════════════════════════════════════════ */

import { Doc as YDoc, XmlElement as YXmlElement, XmlText as YXmlText } from 'yjs';
import type { XmlFragment as YXmlFragment } from 'yjs';
import { z } from 'zod';
import type { ParticipantSummary } from '@/src/components/model';
import { buildConversationModel, type ConversationModel } from './conversation-model';
import type { ConversationTransport } from './conversation-transport';
import { conversationFor, participantsFor, sessionFor } from './seams';
import type { ChatMsg, Selection } from './types';

/** The Yjs array key the message-INDEX metadata lives under, within the doc. */
const MESSAGES_KEY = 'messages';

/** The named CONTENT SHARE — the `Y.XmlFragment` holding every message's
 *  rich-text body. Each child is a `<message mid=…>` block wrapping one
 *  `Y.XmlText`, the in-place-mutable span two peers co-edit and the covenant
 *  reader (SL-2) resolves against. This is the "named content share" #194 asks
 *  for; the reader is pointed at it via {@link conversationContentRoot}. */
const CONTENT_KEY = 'conversation-content';

/** The block element name for one message body under the content fragment. */
const BODY_BLOCK = 'message';
/** The attribute correlating a body block to its message id (id-quarantine: the
 *  FIRST block for an id wins, mirroring the metadata array's first-wins). */
const MID_ATTR = 'mid';

/** The empty certification authority — the CRDT path NEVER sources a `✓` (#183
 *  round-3, held on the #194 shape). Certification is #181's gated read, bound
 *  to #180's anchor. */
const NO_CERTIFICATION: ReadonlySet<string> = new Set();

/**
 * A conversation as a live Yjs document. Wraps a `Y.Doc` carrying two shares: a
 * `Y.Array` message index (converged order + authority-stripped metadata) and a
 * `Y.XmlFragment` of rich-text bodies. Everything the surface reads comes out
 * through {@link model}; everything a peer writes goes in through {@link append}.
 * Merging and ordering are Yjs's — this class only maps between `ChatMsg` and the
 * durable shape, and re-establishes #183's invariants on it.
 */
export class ConversationDoc {
  readonly doc: YDoc;

  /**
   * SEEDED SETTLEMENT CLAIMS (#183 round-3 — `✓` is no longer sourced here).
   * Which SEEDED ids reported a settlement, keyed by id, held OUTSIDE the `Y.Doc`.
   * A seeded settlement projects `~` (SYSTEM_SETTLED — the machine's own "this
   * settled", not a human-certified `✓`), and only for a TRUSTED seeded line. A
   * peer append can never populate it (only {@link seed} does).
   */
  private readonly settledIds = new Set<string>();

  /**
   * THE TRUST FINGERPRINTS (#183 round-2, EXTENDED for #194's mutable bodies).
   * id → the canonical fingerprint of a seeded message's FULL content, INCLUDING
   * its body text ({@link encodeMessage}), held OUTSIDE the `Y.Doc`. A message
   * projects authenticated who/kind only if its RECONSTRUCTED content (metadata +
   * live body text) still matches the fingerprint recorded at {@link seed}.
   *
   * The extension over #183: because a `Y.XmlText` body mutates in place, the
   * fingerprint must cover the body — otherwise a peer editing a seeded body would
   * keep the trusted line's authenticated provenance while replacing its words. By
   * binding trust to the live body text, an in-place edit of a trusted body fails
   * the match and demotes to UNVERIFIED (fail-closed). Nothing that arrives over
   * the wire is in this map, so on a live (unseeded) doc EVERYTHING is unverified
   * until #181's gated read supplies the real envelope. (Certification is separate
   * and never sourced here — see {@link model}: the CRDT grants no `✓`.)
   */
  private readonly trustedFingerprints = new Map<string, string>();

  constructor(doc: YDoc = new YDoc()) {
    this.doc = doc;
  }

  private get array() {
    return this.doc.getArray<string>(MESSAGES_KEY);
  }

  /** The content share — the `Y.XmlFragment` of rich-text body blocks. */
  contentFragment(): YXmlFragment {
    return this.doc.getXmlFragment(CONTENT_KEY);
  }

  /**
   * Seed the doc with an initial conversation. A no-op if the doc already
   * carries messages (e.g. it was caught up from a durable stream first), so a
   * client that connects before seeding never doubles the history.
   *
   * The fixture is a TRUSTED local source (the `/prototype` design route, not a
   * peer over the wire), so its FULL-CONTENT fingerprints (authenticated who/kind,
   * body text included) and settlement claims are recorded beside the doc. A
   * seeded settlement projects `~`, never `✓`. The durable payload itself carries
   * zero authority ({@link encodeDurable} strips it) and its text lives in a
   * rich-text body, never in the metadata channel.
   */
  seed(messages: readonly ChatMsg[]): this {
    if (this.array.length > 0) return this;
    for (const message of messages) {
      // Record the TRUSTED full-content fingerprint for EVERY seeded message (its
      // who/kind + body text project authentically only while unchanged), and note
      // which seeded lines reported a settlement (they project `~`, never `✓`).
      this.trustedFingerprints.set(message.id, encodeMessage(message));
      if (message.certified === true) this.settledIds.add(message.id);
    }
    this.doc.transact(() => {
      for (const message of messages) this.insert(message);
    });
    return this;
  }

  /**
   * Append one message. This is the PEER-WRITABLE path: whatever authority field
   * the caller sets is STRIPPED by {@link encodeDurable} and nothing about it is
   * recorded into the trust maps, so an appended line — local or arriving over a
   * transport — can never forge a `✓` or authenticated who/kind. Its body text is
   * a rich-text span like any other. Certification only ever comes from #181's
   * gated read.
   */
  append(message: ChatMsg): this {
    this.doc.transact(() => this.insert(message));
    return this;
  }

  /**
   * Write one message into the two shares (inside a transaction). The metadata
   * element (authority-stripped) goes onto the message index; the text, if any,
   * becomes a rich-text body block under the content fragment. A message with no
   * text (a turn/image shell) seats NO body — so it round-trips with no `text`
   * field, keeping the byte-identical projection for the static fixtures.
   */
  private insert(message: ChatMsg): void {
    this.array.push([encodeDurable(message)]);
    if (typeof message.text === 'string') this.seatBody(message.id, message.text);
  }

  /**
   * Seat a rich-text body for a message id, unless one already exists (id-quarantine:
   * the FIRST body block for an id wins, so a peer re-using a seeded id cannot
   * replace the trusted body by seating a second block — it is ignored by
   * {@link bodyBlockFor}). The block is `<message mid=id> Y.XmlText </message>` — the
   * rented y-prosemirror shape the SL-2 reader resolves against.
   */
  private seatBody(id: string, text: string): void {
    if (this.bodyBlockFor(id)) return;
    const frag = this.contentFragment();
    const block = new YXmlElement(BODY_BLOCK);
    const xtext = new YXmlText();
    frag.insert(frag.length, [block]);
    block.setAttribute(MID_ATTR, id);
    block.insert(0, [xtext]);
    if (text.length > 0) xtext.insert(0, text);
  }

  /** The FIRST content block whose `mid` matches `id` (first-wins id-quarantine). */
  private bodyBlockFor(id: string): YXmlElement | null {
    for (const child of this.contentFragment().toArray()) {
      if (child instanceof YXmlElement && child.getAttribute(MID_ATTR) === id) return child;
    }
    return null;
  }

  /**
   * The live `Y.XmlText` body of a message, or `null` if it has none. This is the
   * in-place-mutable rich-text span a peer co-edits and the covenant reader
   * resolves a sub-range against.
   */
  body(id: string): YXmlText | null {
    const block = this.bodyBlockFor(id);
    if (!block) return null;
    const child = block.get(0);
    return child instanceof YXmlText ? child : null;
  }

  /**
   * The reader path (`[blockIndex, 0]`) from the content fragment to a message's
   * `Y.XmlText` body, for `CovenantDocReaderProd`'s capture. `null` if the message
   * has no body. Computed live, so it is stable across the converged block order.
   */
  bodyPath(id: string): number[] | null {
    const children = this.contentFragment().toArray();
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child instanceof YXmlElement && child.getAttribute(MID_ATTR) === id) return [i, 0];
    }
    return null;
  }

  /**
   * The current messages, in the index's converged order (never carrying
   * authority). Every metadata element is VALIDATED and QUARANTINED: a peer-inserted
   * raw object, malformed JSON, a shape-invalid element, or one with an EMPTY id is
   * dropped, never thrown on (#183 round-2 + round-3) — so a hostile write cannot
   * crash the projection and converge that crash to every client.
   *
   * ID UNIQUENESS IS ENFORCED HERE (#183 round-3, defect b). The FIRST element for
   * an id wins; every later element re-using that id is QUARANTINED, so the
   * projection sees at most one message per id. Each surviving message's TEXT is
   * read LIVE from its rich-text body ({@link body}) — the single source of truth
   * for body content, so a peer cannot smuggle competing text through the metadata
   * channel (the schema strips it) and a body edit is genuinely reflected.
   */
  messages(): ChatMsg[] {
    const out: ChatMsg[] = [];
    const seen = new Set<string>();
    for (const element of this.array.toArray()) {
      const meta = decodeElement(element);
      if (meta === null) continue;
      if (seen.has(meta.id)) continue; // a colliding id: quarantine the later element
      seen.add(meta.id);
      const bodyText = this.bodyText(meta.id);
      out.push(bodyText === null ? meta : { ...meta, text: bodyText });
    }
    return out;
  }

  /** The plain text of a message's rich-text body, or `null` if it has none. */
  private bodyText(id: string): string | null {
    const body = this.body(id);
    if (!body) return null;
    let text = '';
    for (const op of body.toDelta() as Array<{ insert?: unknown }>) {
      if (typeof op.insert === 'string') text += op.insert;
    }
    return text;
  }

  /** Whether this doc is torn down — guards the hook against reusing a dead instance. */
  isDestroyed(): boolean {
    return this.doc.isDestroyed;
  }

  /**
   * Project the doc to the `ConversationModel` the surface renders — the SAME
   * transform the mock path uses. `room` and `participants` are the selection's
   * projection (covenant/registry concerns not in the doc); the messages come live
   * from the two shares.
   *
   * NO `✓` IS EVER SOURCED FROM THE CRDT PATH (#183 round-3). `certifiedIds` is
   * empty here on purpose: certification is #181's gated read, bound to #180's
   * server-minted anchor, never anything the peer-writable doc can derive. A
   * seeded settlement line projects `~` ({@link settledIds}); a human-certified `✓`
   * is not.
   */
  model(room: string, participants: readonly ParticipantSummary[]): ConversationModel {
    return buildConversationModel(this.messages(), room, participants, {
      // A message keeps its authenticated who/kind only if its RECONSTRUCTED content
      // — metadata AND live body text — still matches the trusted seed fingerprint.
      // A peer append, a wire arrival, OR an in-place edit of a seeded body all fail
      // this match and project as UNVERIFIED (`authorKind:'unknown'`). The message
      // handed to `trusts` already carries the live body text (see {@link messages}).
      trusts: (message) => this.trustedFingerprints.get(message.id) === encodeMessage(message),
      // The CRDT NEVER grants a `✓`. Certification is #181's; the doc cannot mint it.
      certifiedIds: NO_CERTIFICATION,
      // A trusted seeded settlement projects `~` (self-reported), never `✓`.
      settledIds: this.settledIds,
    });
  }

  /**
   * Subscribe to convergence: `listener` fires whenever the doc's messages OR any
   * rich-text body change — a local `append`, an in-body edit, or a remote update
   * arriving over a transport. Returns an unsubscribe.
   */
  onChange(listener: () => void): () => void {
    const handler = () => listener();
    this.array.observeDeep(handler);
    this.contentFragment().observeDeep(handler);
    return () => {
      this.array.unobserveDeep(handler);
      this.contentFragment().unobserveDeep(handler);
    };
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
 * A `RootResolver` (SL-2's `ReaderOptions.resolveRoot`) pointing at a
 * `ConversationDoc`'s content share. The covenant reader resolves a certified
 * span's body FROM here, so a body mutation is genuinely seen; an absent/empty
 * share fails CLOSED (`null` ⇒ DRIFT, no anchor over an empty plant). The
 * production resolver WIRING (which share, which body, for which object) is P6F-4;
 * this is the seam it binds to.
 */
export function conversationContentRoot(doc: YDoc): YXmlFragment | null {
  const frag = doc.getXmlFragment(CONTENT_KEY);
  return frag.length > 0 ? frag : null;
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

/* ── the durable codec ──────────────────────────────────────────────────────
   A message's METADATA is stored as a canonical JSON string of its
   CONVERSATION-CONTENT fields — MINUS `text`, which now lives in a rich-text body.
   This is an ALLOWLIST, not a denylist (#183 F1): the durable payload is built by
   picking the known content fields, so any authority / epistemic / settlement
   field — `certified` today, anything added tomorrow — is structurally absent from
   the peer-writable doc and cannot be forged over the wire.

   Why allowlist and not `delete message.certified`: a denylist fails open the
   moment a second authority field is added and nobody remembers to add it here;
   an allowlist fails closed — a new field is absent from the wire until it is
   deliberately added to `DURABLE_FIELDS`, which is a diff a reviewer sees. */

/** The metadata fields carried on the message INDEX (text is a rich-text body,
 *  NOT a durable metadata field — moving it to `Y.XmlText` is the #194 delta). */
const DURABLE_FIELDS = ['id', 'time', 'kind', 'who', 'turn', 'image'] as const;

/** The metadata projection of a `ChatMsg` — carries zero authority, no text. */
type DurableMessage = Pick<ChatMsg, (typeof DURABLE_FIELDS)[number]>;

/** Encode a message's authority-stripped, text-free METADATA for the index. */
function encodeDurable(message: ChatMsg): string {
  const durable: DurableMessage = { id: message.id, time: message.time, kind: message.kind };
  for (const field of DURABLE_FIELDS) {
    const value = message[field];
    if (value !== undefined) (durable as Record<string, unknown>)[field] = value;
  }
  return JSON.stringify(durable);
}

/* ── the FULL-content fingerprint (trust) ────────────────────────────────────
   The trust fingerprint binds a seeded message's authenticated who/kind to its
   ENTIRE content, INCLUDING its body text — the #194 extension of #183's
   content-fingerprint that closes the in-place-mutable-body hole. It is computed
   over the SAME allowlist plus `text`, so a body edit (or any metadata change)
   moves the fingerprint and demotes the line to UNVERIFIED. This is used ONLY for
   the trust map ({@link ConversationDoc.model}); the durable index element never
   carries `text`. */
const FINGERPRINT_FIELDS = [...DURABLE_FIELDS, 'text'] as const;

function encodeMessage(message: ChatMsg): string {
  const durable: Record<string, unknown> = {
    id: message.id,
    time: message.time,
    kind: message.kind,
  };
  for (const field of FINGERPRINT_FIELDS) {
    const value = message[field];
    if (value !== undefined) durable[field] = value;
  }
  return JSON.stringify(durable);
}

/* ── the decode validator (#183 round-2 — closes the executed DoS) ───────────
   Every metadata element is validated through zod over the SAME allowlist
   `encodeDurable` writes. `kind` must be a real `ChatKind`; `id`/`time` are
   required; the structured `turn`/`image` shapes pass through losslessly. `text`
   is DELIBERATELY ABSENT from the schema (it lives in a rich-text body, not the
   index), so a peer that smuggles a `text` key onto a metadata element has it
   STRIPPED — the body is the single source of truth for message text. An element
   that fails is QUARANTINED (decode returns `null`), never thrown on. */
const DURABLE_MESSAGE_SCHEMA = z.object({
  // A NON-EMPTY id is mandatory (#183 round-3, defect a). `z.string()` alone admits
  // `""`, and an empty-id message flows into `messageEntry`→`quotationFrom` (null)
  // and throws "page-authored … has no body of its own" — a peer-triggered crash on
  // every replica. An empty id is a shape violation: quarantine it at decode.
  id: z.string().min(1),
  time: z.string(),
  kind: z.enum(['system', 'agent', 'human']),
  who: z.string().optional(),
  // `turn` / `image` are structured content shells: validate that each is an object
  // and preserve every nested key verbatim (a lossless round-trip).
  turn: z.looseObject({}).optional(),
  image: z.looseObject({}).optional(),
});

/**
 * Decode one durable metadata element to a `ChatMsg` (WITHOUT text — that is read
 * live from the body), or `null` if it is not a valid content message. Accepts a
 * hostile input of any type: a non-string (a raw peer object) is validated as-is;
 * a string is `JSON.parse`d first (malformed JSON ⇒ `null`). Unknown top-level
 * keys (a forged `certified`, a smuggled `text`) are stripped by the schema.
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
