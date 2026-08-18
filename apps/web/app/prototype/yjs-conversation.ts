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

import type { Array as YArray, XmlFragment as YXmlFragment } from 'yjs';
import {
  createAbsolutePositionFromRelativePosition,
  decodeRelativePosition,
  Doc as YDoc,
  XmlElement as YXmlElement,
  XmlText as YXmlText,
} from 'yjs';
import { z } from 'zod';
import { CovenantDocReaderProd } from '@/lib/covenant-reader';
import type { ParticipantSummary } from '@/src/components/model';
import { buildConversationModel, type ConversationModel } from './conversation-model';
import type { ConversationTransport } from './conversation-transport';
import type { ChatMsg } from './types';

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
   * id → the canonical fingerprint of a seeded message's FULL content ({@link
   * ConversationDoc.trustFingerprint}), held OUTSIDE the `Y.Doc`. A message projects
   * authenticated who/kind only if its RECONSTRUCTED content — metadata + the FULL
   * RENDERED body + the body's CRDT item identity — still matches the fingerprint
   * recorded at {@link seed}.
   *
   * The extension over #183: because a `Y.XmlText` body mutates in place, the fingerprint
   * must cover the body's RENDERED content (not just plaintext — the codex-gauntlet HIGH:
   * marks, embeds, and body attrs are meaning-bearing and a plaintext fingerprint saw
   * none of them) AND its item identity (so a delete-all + reinsert of identical plaintext
   * also demotes). Any such edit of a trusted body fails the match and demotes to
   * UNVERIFIED (fail-closed). Nothing that arrives over the wire is in this map, so on a
   * live (unseeded) doc EVERYTHING is unverified until #181's gated read supplies the real
   * envelope. (Certification is separate and never sourced here — see {@link model}.)
   */
  private readonly trustedFingerprints = new Map<string, string>();

  /* GENUINE-SEAT RESOLUTION IS A DETERMINISTIC FUNCTION OF SHARED CRDT STATE (P6F-1
   * round-2 fix — the CRDT-correctness closer). There is NO wrapper-local memory of
   * "which block/element this instance seated": the round-1 fix kept that provenance in
   * per-instance Maps, so the seating instance resolved by identity while a late joiner /
   * remote-only client / two merged offline clients resolved by document order — a
   * DIVERGENCE (replicas project different models from the same shared state), which a
   * CRDT must never do (executed: a colliding body+index at position 0 hid the genuine
   * body on a late joiner only; two offline seats of one id merged to divergent models).
   *
   * Instead, for a given message id the GENUINE seat is defined, identically on every
   * replica, as the block ({@link genuineBodyBlock}) / index element ({@link messages})
   * with the EARLIEST Yjs item identity (`client:clock`, {@link itemIdLess}) among those
   * carrying that id. Yjs item ids are globally unique and preserved across sync, so this
   * min is the SAME on every replica — a late joiner, a remote-only client, and two
   * merged offline clients all project the identical model. It also defeats the positional
   * "insert a colliding block at position 0" hide, since a later insert has a later clock,
   * not an earlier document position.
   *
   * SECURITY SCOPE — CONVERGENT, NOT SECURE. A peer with CRDT write access cannot be
   * *cryptographically* prevented from crafting a colliding seat with an earlier item id
   * (a lower `client`); the earliest-item-id winner is therefore a CONVERGENCE rule, not
   * an authorship proof. When the winner is a forgery its content no longer matches the
   * trusted seed fingerprint, so authorship FAILS CLOSED to unverified (never a forged
   * authenticated line). SECURE authorship authentication — binding each update to its
   * authenticated writer — is the AUTHENTICATED TRANSPORT's job, P6F-2 (#196). This layer
   * owns CONVERGENCE + item-identity binding + honest fail-closed; it does NOT own crypto.
   */

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
    // Seat the two shares FIRST, so the trusted fingerprint below is taken over the
    // LIVE seeded body (its rendered content + item identity), not a plaintext copy.
    this.doc.transact(() => {
      for (const message of messages) this.insert(message);
    });
    for (const message of messages) {
      // Record the TRUSTED full-content fingerprint for EVERY seeded message — its
      // who/kind + the FULL RENDERED body (marks/embeds/attrs) + the body's CRDT item
      // identity project authentically only while unchanged — and note which seeded
      // lines reported a settlement (they project `~`, never `✓`).
      this.trustedFingerprints.set(message.id, this.trustFingerprint(message));
      if (message.certified === true) this.settledIds.add(message.id);
    }
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
    const meta = encodeDurable(message);
    this.array.push([meta]);
    // No wrapper-local "genuine metadata" is recorded: {@link messages} resolves the
    // genuine index element from shared CRDT state (earliest item identity), identically
    // on every replica, so a peer's colliding element cannot hide it by winning array
    // order AND a late joiner resolves the same element the seeder does.
    if (typeof message.text === 'string') this.seatBody(message.id, message.text);
  }

  /**
   * Seat a rich-text body for a message id, unless a body block for it is ALREADY visible
   * in the shared content share (don't seat a duplicate). The genuine seat is NOT recorded
   * in wrapper-local memory: {@link genuineBodyBlock} resolves it from shared CRDT state
   * (the earliest item identity among blocks carrying the id), identically on every
   * replica — so a peer re-using a seeded id cannot replace or HIDE the trusted body by
   * seating a second block at document position 0 (the P6F-1 MEDIUM), AND a late joiner
   * resolves the same block the seeder does (the CRDT-correctness closer). The block is
   * `<message mid=id> Y.XmlText </message>` — the y-prosemirror shape the SL-2 reader
   * resolves against.
   */
  private seatBody(id: string, text: string): void {
    if (this.bodyBlockFor(id) !== null) return; // a body for this id already exists (shared state)
    const frag = this.contentFragment();
    const block = new YXmlElement(BODY_BLOCK);
    const xtext = new YXmlText();
    frag.insert(frag.length, [block]);
    block.setAttribute(MID_ATTR, id);
    block.insert(0, [xtext]);
    if (text.length > 0) xtext.insert(0, text);
  }

  /**
   * The GENUINE content block for `id` and its live index, or `null` if none. Resolution
   * is a DETERMINISTIC FUNCTION OF SHARED CRDT STATE: among every block carrying `mid=id`,
   * the one with the EARLIEST Yjs item identity ({@link nodeItemId} / {@link itemIdLess})
   * wins. Because Yjs item ids are globally unique and preserved across sync, every replica
   * — the seeder, a late joiner, a remote-only client, two merged offline clients — picks
   * the SAME block and projects the SAME content (convergence). It also defeats the
   * positional hide: a colliding `mid` block inserted at document position 0 has a LATER
   * clock than the genuine seat, so it does not win. A forged block that DOES win (an
   * earlier item id a peer could craft) carries content that fails the trust fingerprint,
   * so authorship fails closed — the convergent-but-not-secure boundary (auth is P6F-2).
   */
  private genuineBodyBlock(id: string): { block: YXmlElement; index: number } | null {
    let best: { block: YXmlElement; index: number; id: ItemId | null } | null = null;
    const children = this.contentFragment().toArray();
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!(child instanceof YXmlElement) || child.getAttribute(MID_ATTR) !== id) continue;
      const iid = nodeItemId(child);
      if (best === null || itemIdLess(iid, best.id)) best = { block: child, index: i, id: iid };
    }
    return best === null ? null : { block: best.block, index: best.index };
  }

  /** The GENUINE content block whose `mid` matches `id` (identity-bound first-wins). */
  private bodyBlockFor(id: string): YXmlElement | null {
    return this.genuineBodyBlock(id)?.block ?? null;
  }

  /**
   * The GENUINE `Y.XmlText` child of a body block and its live child index, or `null` if the
   * block carries no text child. This is the LAST resolution level, and — like the outer
   * block/index — a DETERMINISTIC FUNCTION OF SHARED CRDT STATE: among every `Y.XmlText`
   * child of the block, the one with the EARLIEST Yjs item identity ({@link nodeItemId} /
   * {@link itemIdLess}) wins. Because Yjs item ids are globally unique and preserved across
   * sync, every replica — the seeder, a late joiner, a remote-only client, two merged offline
   * clients — picks the SAME child and projects the SAME body content (convergence).
   *
   * This closes the P6F-1 round-3 MEDIUM (content-hiding): a peer that inserts an imposter
   * `Y.XmlText` at CHILD index 0 INSIDE the genuine (identity-resolved) block pushes the
   * genuine child to index 1, so a positional `block.get(0)` / hardcoded child index 0 would
   * make ALL replicas project the imposter. The imposter's insert has a LATER clock than the
   * genuine seat, so it does not win here. Below this level lies only the chosen `Y.XmlText`,
   * whose content the covenant reader digests — no further positional resolution remains.
   */
  private genuineBodyChild(block: YXmlElement): { text: YXmlText; childIndex: number } | null {
    let best: { text: YXmlText; childIndex: number; id: ItemId | null } | null = null;
    const children = block.toArray();
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!(child instanceof YXmlText)) continue;
      const iid = nodeItemId(child);
      if (best === null || itemIdLess(iid, best.id)) best = { text: child, childIndex: i, id: iid };
    }
    return best === null ? null : { text: best.text, childIndex: best.childIndex };
  }

  /**
   * The live `Y.XmlText` body of a message, or `null` if it has none. This is the
   * in-place-mutable rich-text span a peer co-edits and the covenant reader
   * resolves a sub-range against.
   *
   * The genuine child is resolved by SHARED ITEM IDENTITY, not by position ({@link
   * genuineBodyChild} — NOT `block.get(0)`): a peer that inserts an imposter
   * `Y.XmlText` at CHILD index 0 INSIDE the genuine block (the P6F-1 round-3 MEDIUM)
   * pushes the genuine child to index 1, so a positional `get(0)` would surface — and
   * every replica would converge on — attacker-selected content (content-hiding).
   * Binding to the earliest child item identity makes every replica pick the SAME
   * genuine child and a later-inserted imposter (higher clock) cannot take its place;
   * an absent genuine child fails CLOSED (`null` ⇒ the message projects no trusted body).
   */
  body(id: string): YXmlText | null {
    const block = this.bodyBlockFor(id);
    if (!block) return null;
    return this.genuineBodyChild(block)?.text ?? null;
  }

  /**
   * The reader path (`[blockIndex, childIndex]`) from the content fragment to a
   * message's genuine `Y.XmlText` body, for `CovenantDocReaderProd`'s capture. `null`
   * if the message has no body. BOTH indices are identity-resolved from shared CRDT
   * state ({@link genuineBodyBlock} for the block, {@link genuineBodyChild} for the
   * child) — NOT a hardcoded child index 0 — so the reader captures the SAME genuine
   * child every replica projects, even when an imposter child sits at position 0.
   */
  bodyPath(id: string): number[] | null {
    const genuine = this.genuineBodyBlock(id);
    if (!genuine) return null;
    const child = this.genuineBodyChild(genuine.block);
    return child ? [genuine.index, child.childIndex] : null;
  }

  /**
   * The Yjs item identity (`{client, clock}`) backing the GENUINE body child — the
   * `Y.XmlText` the covenant reader digests — for a message id, or `null` if the
   * message has no resolvable body. This is the CONTENT SEAT: the single item whose
   * authenticated-writer attribution decides authorship of the certified content
   * (P6F-2, #196). It is resolved by the SAME earliest-item-identity rule as
   * {@link body} / {@link bodyPath} ({@link genuineBodyBlock} then
   * {@link genuineBodyChild}), so every replica names the SAME seat and a
   * later-inserted imposter (higher clock) can never take its place.
   *
   * NOTE ON THE SECURITY BOUNDARY — this returns the CRDT item identity, which is
   * CONVERGENT, not an authorship proof: the `client` field is peer-craftable. It is
   * NOT the authorship answer on its own. The authenticated-writer binding lives one
   * layer up ({@link ServerRoomReplica.authenticatedAuthorOf} in
   * `lib/server-room-replica.ts`), which looks this seat up in a ledger keyed by
   * WHICH authenticated connection first introduced the item — so a crafted `client`
   * cannot inherit another writer's authorship. This method only NAMES the seat; it
   * does not vouch for who authored it.
   */
  genuineBodySeat(id: string): { client: number; clock: number } | null {
    const block = this.bodyBlockFor(id);
    if (!block) return null;
    const child = this.genuineBodyChild(block);
    if (!child) return null;
    const iid = nodeItemId(child.text);
    return iid ? { client: iid.client, clock: iid.clock } : null;
  }

  /**
   * THE DISPLAY↔SIGN IDENTITY BINDING (#220 / T6 F1 — the covenant-soundness closer).
   *
   * A covenant `✓` for `objectId` renders over the body the CLIENT DISPLAYS for that
   * message — `body(objectId)`, resolved by the mutable `mid` attribute. The anchor,
   * however, SIGNED a specific `Y.XmlText` addressed by FROZEN relative positions, which
   * follow the CRDT item identity and NEVER the `mid`. Those two resolutions can be made
   * to name DIFFERENT `Y.XmlText`s by any member with ydoc write access: append a hostile
   * block with `mid=objectId`, retarget the genuine block's `mid` away, and `body(objectId)`
   * now returns the hostile text while the anchor still resolves the untouched genuine
   * span — a `✓` painted over content the human never signed (the CRITICAL forge F1).
   *
   * This method is the invariant the resolve path enforces before it may serve `ok`: the
   * `Y.XmlText` the anchor's relative positions resolve to MUST be the EXACT SAME item
   * (`===`, same doc) that `body(objectId)` — the displayed body — resolves to. A `mid`
   * remap that diverts the display to a different (or absent) `Y.XmlText` makes these
   * diverge, so the resolve fails CLOSED to drift (`~`) rather than vouching for content
   * the human never signed. It compares OBJECT IDENTITY on this doc, which is exact: the
   * signed item and the displayed item are the same JS object iff they are the same CRDT
   * item. An unresolvable anchor or an absent display body both fail closed (`false`).
   */
  displayBindsAnchor(objectId: string, anchor: { readonly relStart: string }): boolean {
    const signed = this.resolveAnchorBody(anchor.relStart);
    if (signed === null) return false;
    const displayed = this.body(objectId);
    if (displayed === null) return false;
    return signed === displayed;
  }

  /**
   * THE CERTIFY-TIME OBJECT↔BODYPATH BINDING (#220 / T6 F2 — the cross-certify closer).
   *
   * `certifyYjsSpanAction` receives a client `objectId` (the id the glyph is keyed by, so
   * the `✓` paints on `body(objectId)`) and a client `bodyPath` (the `Y.XmlText` the anchor
   * signs), INDEPENDENTLY. Nothing else checks that they name the same message, so a caller
   * can certify `objectId=A` while signing message M's body: the anchor is minted over M's
   * content but the `✓` paints on A's line (the HIGH forge F2).
   *
   * This binds them: the `Y.XmlText` at `bodyPath` MUST be the EXACT SAME item (`===`) that
   * `body(objectId)` — the displayed body for the id the glyph is keyed by — resolves to. So
   * the anchor can only ever be signed over the very body its `✓` will display, and a
   * certify pointed at one object id while signing another block's content fails CLOSED. An
   * absent body at either resolution fails closed (`false`).
   */
  bodyPathNamesDisplayBody(objectId: string, path: number[]): boolean {
    const atPath = this.xmlTextAtPath(path);
    if (atPath === null) return false;
    const displayed = this.body(objectId);
    if (displayed === null) return false;
    return atPath === displayed;
  }

  /**
   * Resolve an anchor's encoded relative start position to the live `Y.XmlText` body it
   * addresses on THIS doc, or `null` if it does not resolve to a live `Y.XmlText` (a GC'd
   * / deleted / foreign-shape position fails closed). This is the SAME resolution the SL-2
   * reader performs in `buildResolve`; kept here so the display↔sign identity check owns
   * both halves — the `mid`-resolved display and the relative-position-resolved signature —
   * in one place, against one doc.
   */
  private resolveAnchorBody(relStart: string): YXmlText | null {
    let abs: ReturnType<typeof createAbsolutePositionFromRelativePosition>;
    try {
      const rel = decodeRelativePosition(base64ToBytes(relStart));
      abs = createAbsolutePositionFromRelativePosition(rel, this.doc);
    } catch {
      return null; // malformed / undecodable position ⇒ fail closed
    }
    if (!abs) return null;
    return abs.type instanceof YXmlText ? abs.type : null;
  }

  /**
   * The `Y.XmlText` reached by following a `[blockIndex, childIndex, …]` path of child
   * indices from the content fragment, or `null` if the path does not land on a live
   * `Y.XmlText`. Mirrors the SL-2 reader's `bodyAtPath` over the conversation content
   * share — POSITIONAL, exactly as `certifyYjsSpanAction`'s reader captures against — so
   * the F2 check compares the very body the anchor will be signed over.
   */
  private xmlTextAtPath(path: number[]): YXmlText | null {
    let node: YXmlFragment | YXmlElement | YXmlText | null = this.contentFragment();
    for (const idx of path) {
      if (!node || node instanceof YXmlText) return null;
      const child: unknown = node.get(idx);
      if (child instanceof YXmlElement || child instanceof YXmlText) node = child;
      else return null;
    }
    return node instanceof YXmlText ? node : null;
  }

  /**
   * The Yjs item identities backing the CURRENT (non-deleted) content runs of a
   * message's GENUINE body child — the text runs, embeds, and inline-format markers
   * the covenant reader actually renders and digests — or `null` if the message has
   * no resolvable body. An empty body yields `[]`.
   *
   * WHY THIS EXISTS, SEPARATELY FROM {@link genuineBodySeat} (P6F-2 authorship HIGH).
   * `genuineBodySeat` names the item of the `Y.XmlText` CONTAINER. That container's
   * item identity is STABLE under an in-place edit: a peer can catch up, DELETE
   * every character the original writer inserted, and INSERT its own content INTO the
   * SAME container — the rendered text is now the peer's, but the container item is
   * still the original writer's. Attributing authorship from the container therefore
   * lets a peer's forged content INHERIT the victim's authorship. The content is
   * carried by the container's CHILD ITEMS (each `insert` is one Yjs item with its
   * own `{client, clock}`), and a peer's in-place edit produces NEW child items under
   * the peer's clocks while the victim's are tombstoned. So authorship must be derived
   * from these content items — the ones the reader renders — not the container. The
   * caller ({@link ServerRoomReplica.authenticatedAuthorOf}) reads each item's
   * authenticated writer from the ledger and refuses to vouch for a body whose content
   * mixes writers or carries any unattributed run.
   */
  genuineBodyContentItemIds(id: string): { client: number; clock: number }[] | null {
    const body = this.body(id);
    if (!body) return null;
    return textContentItemIds(body);
  }

  /**
   * The current messages, in the index's converged order (never carrying
   * authority). Every metadata element is VALIDATED and QUARANTINED: a peer-inserted
   * raw object, malformed JSON, a shape-invalid element, or one with an EMPTY id is
   * dropped, never thrown on (#183 round-2 + round-3) — so a hostile write cannot
   * crash the projection and converge that crash to every client.
   *
   * ID UNIQUENESS IS ENFORCED HERE (#183 round-3, defect b). At most one element per id
   * survives. Which one is a DETERMINISTIC FUNCTION OF SHARED CRDT STATE (P6F-1 round-2
   * fix): the element whose backing Yjs item has the EARLIEST identity ({@link
   * indexItemKeys} / {@link itemIdLess}) among those decoding to the id represents it;
   * every other element for that id is QUARANTINED. Because Yjs item ids are preserved
   * across sync, every replica selects the SAME element — a peer's colliding index element
   * inserted at position 0 has a later clock and does not win, AND a late joiner resolves
   * the same element the seeder does (no divergence). Each surviving message's TEXT is read
   * LIVE from its rich-text body ({@link body}) — the single source of truth for body
   * content, so a peer cannot smuggle competing text through the metadata channel (the
   * schema strips it) and a body edit is genuinely reflected.
   */
  messages(): ChatMsg[] {
    const elements = this.array.toArray();
    const keys = this.indexItemKeys(); // item identity per array position, aligned to `elements`
    const metas = elements.map(decodeElement);
    // The genuine (winning) array position per id: the one with the earliest item identity.
    const winner = new Map<string, number>();
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      if (meta == null) continue;
      const cur = winner.get(meta.id);
      if (cur === undefined || itemIdLess(keys[i] ?? null, keys[cur] ?? null))
        winner.set(meta.id, i);
    }
    const out: ChatMsg[] = [];
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      if (meta == null) continue;
      if (winner.get(meta.id) !== i) continue; // a colliding id: quarantine the non-genuine element
      const bodyText = this.bodyText(meta.id);
      out.push(bodyText === null ? meta : { ...meta, text: bodyText });
    }
    return out;
  }

  /**
   * The Yjs item identity (`{client, clock}`) backing each live element of the message
   * index, ALIGNED positionally to {@link array}'s `toArray()`. Walking the array's item
   * list (skipping deleted, offsetting the clock within a run-length item) recovers a
   * stable, replica-identical identity per element — the key the genuine-seat resolution
   * and the index half of the trust fingerprint ({@link trustFingerprint}) bind to, so a
   * delete-genuine + insert-identical-bytes is a DIFFERENT item (a new clock) and cannot
   * silently inherit the genuine seat.
   */
  private indexItemKeys(): (ItemId | null)[] {
    return arrayItemIds<string>(this.array);
  }

  /** The item identity of the GENUINE (earliest-item-id) index element for `id`, as a
   *  stable `client:clock` key, or a sentinel when the id has no live index element. Bound
   *  into the trust fingerprint so a delete-genuine + reinsert-identical-bytes demotes. */
  private genuineIndexItemKey(id: string): string {
    const elements = this.array.toArray();
    const keys = this.indexItemKeys();
    let best: ItemId | null = null;
    let found = false;
    for (let i = 0; i < elements.length; i++) {
      const meta = decodeElement(elements[i]);
      if (meta === null || meta.id !== id) continue;
      const key = keys[i] ?? null;
      if (!found || itemIdLess(key, best)) {
        best = key;
        found = true;
      }
    }
    return found ? itemIdKey(best) : NO_INDEX;
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
      // A message keeps its authenticated who/kind only if its RECONSTRUCTED content —
      // metadata AND the FULL RENDERED body (marks, embeds, body/ancestor attrs) AND
      // the body's live CRDT item identity — still matches the trusted seed fingerprint.
      // A peer append, a wire arrival, an in-place text edit, a link mark, a mention /
      // embed insertion, OR a delete-all + reinsert of identical plaintext all fail this
      // match and project as UNVERIFIED (`authorKind:'unknown'`) — the codex-gauntlet
      // HIGH (a plaintext-only fingerprint saw none of the format/embed/structural edits).
      trusts: (message) =>
        this.trustedFingerprints.get(message.id) === this.trustFingerprint(message),
      // The CRDT NEVER grants a `✓`. Certification is #181's; the doc cannot mint it.
      certifiedIds: NO_CERTIFICATION,
      // A trusted seeded settlement projects `~` (self-reported), never `✓`.
      settledIds: this.settledIds,
    });
  }

  /**
   * The trust fingerprint of a message: its authority-stripped METADATA bound to (a) the
   * genuine INDEX element's CRDT item identity and (b) its FULL-CONTENT fingerprint.
   *
   * The content half (P6F-1 round-1, gauntlet-confirmed SOUND) is the SL-2 reader's
   * rendered digest — text + inline marks + embeds + body/ancestor attrs, proven injective
   * — bound with the body's CRDT item identity, so every meaning-bearing body edit (format,
   * embed, in-place text, or a delete-all + reinsert of identical plaintext) moves it.
   *
   * The index-identity half (P6F-1 round-2) binds the trust to the genuine index element's
   * Yjs ITEM IDENTITY, not just its serialized VALUE ({@link genuineIndexItemKey}). The
   * round-1 index guard was value-bound (string equality), so a peer that DELETED the
   * genuine index element and INSERTED one with identical serialized bytes kept the trusted
   * authorship (executed HIGH). Binding the item identity closes it: the reinserted element
   * is a different item (a new clock) → the fingerprint moves → the line demotes to
   * unverified (fail-closed). The metadata half is {@link encodeDurable} (the index's own
   * allowlist).
   */
  private trustFingerprint(message: ChatMsg): string {
    return `${encodeDurable(message)}\n${this.genuineIndexItemKey(message.id)}\n${this.contentFingerprint(message.id)}`;
  }

  /**
   * The FULL-CONTENT fingerprint of a message's body, reusing the SL-2 production reader
   * ({@link CovenantDocReaderProd.fullContentFingerprint}) over the GENUINE body block —
   * the SAME rendering a `✓` binds to. A bodyless message (a turn/image shell) has a
   * STABLE `NO_BODY` sentinel, so it stays trusted while it stays bodyless (and demotes
   * if a peer later seats a body under its id). An unresolved / unrenderable body yields
   * `DRIFT_BODY` — a sentinel that can never equal a real `digest|signature`, so it
   * fails CLOSED to unverified rather than vouching for content it could not read.
   */
  private contentFingerprint(id: string): string {
    const path = this.bodyPath(id);
    const body = this.body(id);
    if (path === null || body === null) return NO_BODY;
    try {
      const reader = new CovenantDocReaderProd(
        this.doc,
        { path, start: 0, end: body.length },
        { resolveRoot: conversationContentRoot },
      );
      return reader.fullContentFingerprint() ?? DRIFT_BODY;
    } catch {
      return DRIFT_BODY;
    }
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

/* The selection-bound FIXTURE helpers (`conversationDocFor`, `roomFor`,
   `participantsForSelection`, `conversationModelFromDoc`) moved to
   `yjs-conversation-fixtures.ts` (P6F-2): they depend on the `'use client'`
   `seams` module, and keeping them here dragged that client module into the
   SERVER certify path (`lib/live-covenant-doc.ts` → `lib/server-room-replica.ts`
   → this file). This module is now server-safe — only Yjs, the covenant reader,
   and the pure model transform — so the server-authoritative replica can reuse
   `ConversationDoc` without pulling client code into the Server Action bundle.
   The fixture route + tests import the helpers from the new file. */

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
   metadata AND the FULL RENDERED content of its body — closing the codex-gauntlet
   HIGH (a plaintext-only fingerprint saw neither marks/embeds/attrs nor a structural
   delete+reinsert). The body half is NOT reconstructed here: it REUSES the SL-2
   production reader's rendering/digest bound with the body's CRDT item identity
   ({@link ConversationDoc.contentFingerprint} →
   {@link CovenantDocReaderProd.fullContentFingerprint}), so trust binds to the exact
   same content a `✓` would. The metadata half is {@link encodeDurable} (the same
   allowlist the index carries). The sentinels below stand in for a body that is
   ABSENT (stable — a bodyless shell stays trusted) or UNRENDERABLE (fail-closed —
   never equal to a real `digest|signature`). */

/** A message with no body (a turn/image shell) — a STABLE content component, so a
 *  genuinely bodyless seeded line stays trusted while it stays bodyless. */
const NO_BODY = ' no-body';
/** An unresolved / unrenderable body — a content component that can NEVER equal a
 *  real `digest|signature`, so the line fails CLOSED to unverified (fail-closed). */
const DRIFT_BODY = ' drift-body';

/* ── genuine-seat resolution: earliest Yjs item identity (shared CRDT state) ──────────
   Genuine-seat resolution ({@link ConversationDoc.genuineBodyBlock},
   {@link ConversationDoc.messages}) is a DETERMINISTIC FUNCTION OF SHARED CRDT STATE — the
   block / index element with the earliest Yjs item identity for an id. Yjs item ids
   (`{client, clock}`) are globally unique and preserved across sync, so the min is the SAME
   on every replica: a late joiner, a remote-only client, and two merged offline clients all
   resolve the identical seat (convergence), and a colliding insert at document position 0
   cannot win (it has a later clock, not an earlier position). It is CONVERGENT, not SECURE:
   a peer could craft a lower `client` — real authorship auth is P6F-2 (#196); here a forged
   winner fails the trust fingerprint and demotes (fail-closed). */

/** A message with no live index element (an id that isn't projected) — a STABLE sentinel
 *  for the index-identity half of the fingerprint. It contains a space, so it can never
 *  equal a real `client:clock` key (digits and a colon only) — fail-closed if the genuine
 *  index element is deleted outright. */
const NO_INDEX = ' no-index';

/** Decode a base64 anchor position (relative-position bytes) to a `Uint8Array`. Mirrors
 *  the reader's own `base64ToBytes`; kept module-local so the identity check decodes an
 *  anchor's frozen positions without importing the reader's private codec. */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** A Yjs item identity — the `{client, clock}` of the item backing a CRDT value. */
type ItemId = { client: number; clock: number };

/** A stable `client:clock` string for an item identity (or the {@link NO_INDEX} sentinel
 *  when there is none) — the form bound into the trust fingerprint. */
function itemIdKey(id: ItemId | null): string {
  return id === null ? NO_INDEX : `${id.client}:${id.clock}`;
}

/** Total order on item identities: `client` then `clock`, ascending. A `null` identity
 *  (a not-yet-integrated / item-less value) sorts LAST, so a real identity always wins and
 *  two nulls keep first-encountered order. Returns true iff `a` strictly precedes `b`. */
function itemIdLess(a: ItemId | null, b: ItemId | null): boolean {
  if (a === null) return false; // null is never strictly earlier
  if (b === null) return true; // a real identity precedes a null one
  return a.client !== b.client ? a.client < b.client : a.clock < b.clock;
}

/** The Yjs item identity backing an integrated node — a body BLOCK (`Y.XmlElement`) or its
 *  text CHILD (`Y.XmlText`) — or `null` if it has no item (a top-level type / not yet
 *  integrated). The genuine-seat key for the body channel AT BOTH resolution levels: the
 *  block ({@link genuineBodyBlock}) and, within it, the child ({@link genuineBodyChild}). */
function nodeItemId(node: YXmlElement | YXmlText): ItemId | null {
  const item = (node as unknown as { _item?: { id: ItemId } | null })._item;
  return item ? { client: item.id.client, clock: item.id.clock } : null;
}

/**
 * The Yjs item identities backing the CURRENT (non-deleted) content items of a `Y.XmlText`
 * body — each text run, embed, or inline-format marker, in document order. Walks the text's
 * `_start` item list (the same internal surface {@link arrayItemIds} walks for a `Y.Array`),
 * skipping tombstoned (deleted) items so only content the reader RENDERS is returned. Each
 * `insert` is one item under its writer's `{client, clock}`, so a peer's in-place edit of a
 * victim's body surfaces here as items under the PEER's clocks while the victim's are gone —
 * which is exactly what lets P6F-2 attribute authorship to the writers of the CURRENT content
 * rather than to the (stable) container item. A run-length item is named by its base clock;
 * the ledger's `writerAt` resolves any clock within the run to the same recorded writer.
 */
function textContentItemIds(text: YXmlText): ItemId[] {
  type YItem = { id: ItemId; deleted: boolean; right: YItem | null };
  const out: ItemId[] = [];
  let item = (text as unknown as { _start?: YItem | null })._start ?? null;
  while (item) {
    if (!item.deleted) out.push({ client: item.id.client, clock: item.id.clock });
    item = item.right;
  }
  return out;
}

/**
 * The Yjs item identity backing each LIVE element of a `Y.Array`, ALIGNED positionally to
 * `arr.toArray()`. Yjs coalesces a run of same-client inserts into one item of length > 1;
 * walking the item list (skipping deleted, offsetting the clock by the value's position
 * within its item) recovers a per-element identity that is stable and replica-identical.
 * Reaches into `_start` / `Item` internals — the same internal surface the block channel
 * uses via `_item`; kept in one place so the coupling is auditable.
 */
function arrayItemIds<T>(arr: YArray<T>): (ItemId | null)[] {
  type YItem = {
    id: ItemId;
    length: number;
    deleted: boolean;
    countable: boolean;
    right: YItem | null;
  };
  const out: (ItemId | null)[] = [];
  let item = (arr as unknown as { _start?: YItem | null })._start ?? null;
  while (item) {
    if (!item.deleted && item.countable) {
      for (let j = 0; j < item.length; j++) {
        out.push({ client: item.id.client, clock: item.id.clock + j });
      }
    }
    item = item.right;
  }
  return out;
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
