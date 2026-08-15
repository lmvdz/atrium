/* ═══════════════════════════════════════════════════════════════════════════
 * THE CONVERSATION MODEL — the Phase-6 swap seam.
 *
 * ## What this is
 *
 * ONE interface the conversation column renders THROUGH, and one implementation
 * of it backed by today's mock conversation seam (`seams.ts` → `conversationFor`).
 * The feed component (`ChatBlock`) never reads `ChatMsg[]` any more; it reads a
 * `ConversationModel` — a room, a set of real ledger `MessageRecord`s, an ordered
 * list of feed `items` already shaped for the shipped grammar, and the spoken
 * participants.
 *
 * ## Why the interface exists (read before changing it)
 *
 * Phase 6 replaces the substrate under the conversation with a Yjs/CRDT-backed
 * live document. THE COMPONENTS MUST NOT CHANGE when that happens. So the seam is
 * the SHAPE the components consume, not the source that fills it:
 *
 *   - today   `conversationModel(sel)` maps the mock `ChatMsg[]` seam into this shape.
 *   - phase 6 a `ConversationModel` is produced from the CRDT document instead —
 *             same `records`, same `items`, same `participants`; `ChatBlock`,
 *             `MessageText`, `TimelineRow`, `SystemRow` are untouched.
 *
 * The one rule that makes the swap real: the model emits SHIPPED shapes —
 * `MessageRecord` / `MessageEntry` / `SystemEntry` (model/records.ts) — never the
 * prototype's `ChatMsg`. A component that renders a `ConversationModel` is already
 * rendering the shipped stack; the source behind the model is the only thing a
 * future phase touches.
 *
 * ## The marriage (#151, #155)
 *
 * The Tier-5 "shipped wins" pieces are bound here:
 *   - a plain human/agent message → a real `MessageRecord` + `messageEntry`, so it
 *     renders through the shipped `TimelineRow` (mentions become typed references
 *     via `RichMessageBody`, the machine voice register is honoured, the body is
 *     reconciled against the record — the prototype's hand-rolled `ChatMessage`
 *     plain-row + `RichText` regex are DELETED).
 *   - a system line → a real `SystemEntry` with an `EpistemicState`, so its glyph
 *     is DERIVED (`SystemRow` → `<Glyph>`), never a literal `✓` in mock text. This
 *     is how the settled/certified line renders its tick — from certification
 *     STATE, the covenant's glyph-source rule (test/glyph-source.test.ts).
 *   - an agent TURN stays the design accordion shell (blocked on the live channel
 *     #159 — the prototype's `Turn`/`TurnStep` has no backend), and an inline
 *     image stays a design row (real attachments are a later lane). Both are
 *     carried as their own item kinds so the feed can host them beside the shipped
 *     rows, exactly as #161's scaffold note describes.
 * ═════════════════════════════════════════════════════════════════════════ */

import type {
  BodySegment,
  EpistemicState,
  MessageEntry,
  MessageRecord,
  ParticipantKind,
  ParticipantSummary,
  SystemEntry,
} from '@/src/components/model';
import { bodyText, messageEntry, systemStatement } from '@/src/components/model';
import { conversationFor, participantsFor, sessionFor } from './seams';
import type { ChatKind, ChatMsg, Selection, TurnData } from './types';

/** The person reading the surface — the viewer `messageEntry` derives `fromViewer` from. */
export const VIEWER = 'you';

/* ── the epistemic states a conversation row can carry ──────────────────────
   Small, named, and DERIVED-from here rather than hand-set at each row — the
   same discipline `app/gallery/fixtures.ts` keeps (`TALK`/`VERIFIED`/…). A row's
   glyph is `glyphFor(state)`; nothing writes the character. */

/** Ordinary talk — a person or an agent saying something. `·`, no attention owed. */
const TALK: EpistemicState = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
};

/** A routine system notice — a plan opening, a drift warning. `·`. */
const SYSTEM_ROUTINE: EpistemicState = TALK;

/**
 * A settled reading a human has certified — `✓`. This is the ONE place the
 * conversation's tick comes from: the state, not a glyph in the text. Flip the
 * `certified` field that selects it and the glyph moves to `~` (`SYSTEM_SETTLED`),
 * which is the whole point of the covenant's glyph-source rule.
 */
const SYSTEM_CERTIFIED: EpistemicState = {
  kind: 'claim',
  verification: 'accepted',
  owedToViewer: false,
  irreversible: false,
};

/** A settled reading NOT yet certified — the machine's own account, `~`. */
const SYSTEM_SETTLED: EpistemicState = {
  kind: 'claim',
  verification: 'self_reported',
  owedToViewer: false,
  irreversible: false,
};

/**
 * The state a settled system line renders from — certified is a `✓`, uncertified
 * is a `~`. A pure function of the certification field so a test can flip it.
 */
export function systemSettlementState(certified: boolean): EpistemicState {
  return certified ? SYSTEM_CERTIFIED : SYSTEM_SETTLED;
}

/* ── the lossless inline tokenizer ─────────────────────────────────────────
   A message body's markup, as shipped `BodySegment`s: the ONLY two inline runs
   the shipped `MessageBody` knows are `code` and `mention`. Everything else is
   text, verbatim.

   THE RECORD'S TEXT IS `bodyText(body)`, NOT THE RAW MARKUP. The shipped
   `segmentText` of a `code` run is its INNER text — the backticks are markup the
   record does not carry — while a `mention` keeps its `@`. So a record is built
   from `bodyText(messageBody(raw))` (see `conversationModel`), which is exactly
   what `messageEntry` reconciles the body against: the words are the de-marked
   words, and `code`/`mention` mark spans of them. A `==…==` design highlight is
   NOT a shipped segment, so its markers stay as literal text here (the design
   highlight is applied by `MessageText`, which splits on it BEFORE calling this —
   see #161's note about not re-tokenizing a highlight's interior). `matchAll` is
   used rather than a shared `/g` regex with a mutable `lastIndex`, so calling this
   for a run and again for a highlight's interior can never carry state between the
   two. */
const INLINE = /(`[^`]+`|@[\w-]+)/g;

export function messageBody(text: string): BodySegment[] {
  const body: BodySegment[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) body.push({ kind: 'text', text: text.slice(last, index) });
    const token = match[0];
    if (token.startsWith('`')) body.push({ kind: 'code', text: token.slice(1, -1) });
    else body.push({ kind: 'mention', text: token.slice(1) });
    last = index + token.length;
  }
  if (last < text.length) body.push({ kind: 'text', text: text.slice(last) });
  return body.length === 0 ? [{ kind: 'text', text }] : body;
}

/* ── the model ─────────────────────────────────────────────────────────────*/

/** The minimap's per-row datum, carried alongside every item. */
export interface MmMeta {
  readonly who: string;
  readonly kind: string;
  readonly excerpt: string;
}

/**
 * One rendered feed row. The `message`/`system` kinds carry SHIPPED entries and
 * render through `TimelineRow`/`SystemRow`; `turn`/`image` are the design shells
 * a later lane graduates (#159/attachments), rendered by the feed directly.
 */
export type ConversationItem =
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly mm: MmMeta;
      readonly entry: MessageEntry;
    }
  | {
      readonly kind: 'system';
      readonly id: string;
      readonly mm: MmMeta;
      readonly entry: SystemEntry;
    }
  | {
      readonly kind: 'turn';
      readonly id: string;
      readonly mm: MmMeta;
      readonly at: string;
      readonly who: string;
      readonly authorKind: ParticipantKind;
      readonly turn: TurnData;
    }
  | {
      readonly kind: 'image';
      readonly id: string;
      readonly mm: MmMeta;
      readonly at: string;
      readonly who: string;
      readonly authorKind: ParticipantKind;
      readonly body: readonly BodySegment[];
      readonly image: { readonly src: string; readonly alt: string };
    };

/**
 * THE SWAP SEAM. Everything the conversation column renders through.
 *
 * `records` is the register `<AttributionLedger>` is given — every citation a
 * `TimelineRow` resolves is one of these. `items` is the feed in order. Phase 6
 * fills all of this from a CRDT document; the components do not know the difference.
 */
export interface ConversationModel {
  readonly room: string;
  readonly records: readonly MessageRecord[];
  readonly items: readonly ConversationItem[];
  readonly participants: readonly ParticipantSummary[];
}

/** The minimap excerpt for a message — the prototype's original cleaning, kept. */
function mmFor(message: ChatMsg): MmMeta {
  const excerpt = (
    message.text ??
    message.turn?.conclusion?.text ??
    message.turn?.summary ??
    (message.image ? `[image] ${message.image.alt}` : '')
  )
    .replace(/[`=*]/g, '')
    .trim();
  return {
    who: message.kind === 'system' ? 'system' : (message.who ?? ''),
    kind: message.kind,
    excerpt,
  };
}

function authorKindOf(kind: ChatKind): ParticipantKind {
  return kind === 'agent' ? 'agent' : 'human';
}

/**
 * TODAY'S IMPLEMENTATION of the swap seam, backed by the mock conversation seam.
 * When #159/Phase 6 lands, THIS function is what changes — its output shape does
 * not, so nothing downstream does either.
 */
export function conversationModel(selection: Selection): ConversationModel {
  const room = sessionFor(selection).agent.room;
  const records: MessageRecord[] = [];
  const items: ConversationItem[] = [];

  for (const message of conversationFor(selection)) {
    const mm = mmFor(message);

    if (message.kind === 'system') {
      const entry: SystemEntry = {
        type: 'system',
        id: message.id,
        at: message.time,
        statement: systemStatement((message.text ?? '').trim()),
        // The tick is DERIVED from the certification field, never a glyph in text.
        state: message.certified === true ? SYSTEM_CERTIFIED : SYSTEM_ROUTINE,
      };
      items.push({ kind: 'system', id: message.id, mm, entry });
      continue;
    }

    if (message.turn !== undefined) {
      items.push({
        kind: 'turn',
        id: message.id,
        mm,
        at: message.time,
        who: message.who ?? '',
        authorKind: authorKindOf(message.kind),
        turn: message.turn,
      });
      continue;
    }

    if (message.image !== undefined) {
      items.push({
        kind: 'image',
        id: message.id,
        mm,
        at: message.time,
        who: message.who ?? '',
        authorKind: authorKindOf(message.kind),
        body: messageBody(message.text ?? ''),
        image: message.image,
      });
      continue;
    }

    // A plain human/agent line → a real record + entry → the shipped TimelineRow.
    // The record's text is the DE-MARKED words (`code` drops its backticks); the
    // body marks spans of exactly those words, so `messageEntry` reconciles.
    const body = messageBody(message.text ?? '');
    const authorKind = authorKindOf(message.kind);
    const record: MessageRecord = {
      id: message.id,
      at: message.time,
      actor: message.who ?? (authorKind === 'human' ? VIEWER : 'agent'),
      text: bodyText(body),
      origin: 'seeded',
      authorKind,
      room,
    };
    records.push(record);
    items.push({
      kind: 'message',
      id: message.id,
      mm,
      entry: messageEntry(record, { state: TALK, body, viewer: VIEWER }),
    });
  }

  return { room, records, items, participants: participantsFor(selection) };
}

/**
 * A locally-sent line (an echo). It is the viewer TYPING, so it is a real typed
 * message on the same register as the rest of the feed — not a second render
 * path. The record and the entry come back together so `ChatBlock` can add both
 * to the ledger and the feed. (SEAM #157: a real send routes through a gated
 * dispatch; until then this is the honest local shape of the viewer's own words.)
 */
export function echoItem(
  text: string,
  index: number,
  room: string,
): { readonly record: MessageRecord; readonly item: ConversationItem } {
  const id = `echo-${index}`;
  const body = messageBody(text);
  const record: MessageRecord = {
    id,
    at: 'now',
    actor: VIEWER,
    text: bodyText(body),
    origin: 'typed',
    authorKind: 'human',
    room,
  };
  return {
    record,
    item: {
      kind: 'message',
      id,
      mm: { who: VIEWER, kind: 'human', excerpt: text.replace(/[`=*]/g, '').trim() },
      entry: messageEntry(record, { state: TALK, body, viewer: VIEWER }),
    },
  };
}
