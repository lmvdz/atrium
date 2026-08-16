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
  Quotation,
  SystemEntry,
} from '@/src/components/model';
import { bodyText, messageEntry, quotationFrom, systemStatement } from '@/src/components/model';
import { conversationFor, participantsFor, sessionFor } from './seams';
import type { Artifact, ChatKind, ChatMsg, Selection, TurnData } from './types';

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

/* ── the doc/plan artifact, as an attributed record (#158) ──────────────────
   A doc/plan artifact is the agent's drafted markdown. It renders through the
   SHIPPED `RichMessageBody` grammar — the same grammar the conversation feed
   uses — which resolves its text from the attribution register (`useAttribution`)
   and NEVER raw-prints a caller string. So the artifact becomes a real
   `MessageRecord` the body cites, and the pane wraps it in an
   `<AttributionLedger>`. The record is honestly classified: `authorKind: 'agent'`
   (a machine draft is the agent's own words, records.ts), `origin: 'seeded'` (a
   draft already present when the pane opened). The `~`/`✓` mark stays DERIVED
   from `certified` elsewhere — this helper is only the body render.

   SEAM(#155): the room + actor bind to the session's real room and author at
   app-integration. Here the room is the artifact's own scope and the actor is
   the artifact's name — neither is ever PAINTED (RichMessageBody renders only
   the body, never a name or a time), so nothing false reaches a reader; the
   record exists so the register can resolve the body the way the feed does. */
export const ARTIFACT_DOC_ROOM = 'artifact';

export function artifactDocModel(
  artifact: Artifact,
): { readonly record: MessageRecord; readonly citation: Quotation } | null {
  const md = artifact.md ?? '';
  if (md.trim().length === 0) return null;
  const record: MessageRecord = {
    id: `artifact:${artifact.id}`,
    at: '',
    actor: artifact.title,
    text: md,
    origin: 'seeded',
    authorKind: 'agent',
    room: ARTIFACT_DOC_ROOM,
  };
  const citation = quotationFrom(record);
  return citation === null ? null : { record, citation };
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
 * How a locally-appended line reached (or did NOT reach) the room.
 *
 *  - `said`     — the viewer's own words, honestly typed into the room. A real
 *                 authored line on the same register as the rest of the feed.
 *  - `refused`  — a covenant act that returned honestly inert: nothing reached
 *                 the server. Rendered as a NOT-delivered system notice.
 *
 * The distinction is the whole point of #157 round-1 D1: a covenant act that
 * did not reach a durable door must NEVER render as a sent-looking authored
 * message. Only `said` becomes an authored viewer row; a `refused` echo renders
 * as a system notice carrying a ✗ (not-delivered) glyph, so no covenant act can
 * show a "sent" outcome with no command behind it. (Steer/interrupt is no longer
 * inferred from chat prose — it is a structured control, #157 r3 — so the only
 * `refused` echo today is the anchored comment-to-steer mediation, #158/#152.)
 */
export type EchoDelivery = 'said' | 'refused';

/** A locally-appended feed line and how far it actually got. */
export interface Echo {
  readonly text: string;
  readonly delivery: EchoDelivery;
}

/**
 * A covenant act that reached no server. `event` + `failed` derives a `✗` (see
 * `glyphFor`) — the one glyph that reads, unmistakably, "this did NOT happen",
 * the exact opposite of the sent/`✓` a faked stop would wear. It is NOT owed to
 * the viewer and NOT a claim, so it carries no attention dot and no dotted
 * underline: it is a plain, honest "nothing was delivered" notice.
 */
const NOT_DELIVERED: EpistemicState = {
  kind: 'event',
  verification: 'failed',
  owedToViewer: false,
  irreversible: false,
};

/**
 * A locally-appended line (an echo), rendered by its delivery.
 *
 * A `said` echo is the viewer TYPING — a real typed message on the same
 * register as the rest of the feed, so its record and entry come back together
 * for `ChatBlock` to add to both the ledger and the feed. A `refused`
 * echo is a covenant act that reached no durable door: it renders as a SYSTEM
 * notice with a ✗ (not-delivered) glyph and carries NO `MessageRecord` — it is
 * structurally not an authored, sent-looking message. (SEAM #157: a real send
 * routes through a gated dispatch; until then a steer is honestly not delivered,
 * and it says so on its own row the instant it is begun.)
 */
export function echoItem(
  echo: Echo,
  index: number,
  room: string,
): { readonly record?: MessageRecord; readonly item: ConversationItem } {
  const id = `echo-${index}`;
  const excerpt = echo.text.replace(/[`=*]/g, '').trim();

  if (echo.delivery !== 'said') {
    // A covenant act that did NOT reach a server: a system NOT-delivered notice,
    // never an authored viewer message. No `MessageRecord` — this line is not the
    // viewer's speech, it is the surface reporting that nothing was sent.
    const entry: SystemEntry = {
      type: 'system',
      id,
      at: 'now',
      statement: systemStatement(echo.text),
      state: NOT_DELIVERED,
    };
    return { item: { kind: 'system', id, mm: { who: 'system', kind: 'system', excerpt }, entry } };
  }

  const body = messageBody(echo.text);
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
      mm: { who: VIEWER, kind: 'human', excerpt },
      entry: messageEntry(record, { state: TALK, body, viewer: VIEWER }),
    },
  };
}

/**
 * The feed echo for an anchored artifact COMMENT, honest about durability
 * (#168 go-live B2 fix1, F3).
 *
 * On the `/prototype` FIXTURE route (`liveMount` false) a comment is the design
 * shell's own local demo line: a `said` echo, the operator speaking on the feed,
 * unchanged.
 *
 * On a LIVE mount (`liveMount` true) this same client path is STILL local-only
 * `setState`: the durable comment write (SEAM #156 → a real `sendMessage` on the
 * room register) is not wired yet. So the echo must NOT read as authored-on-the-
 * room's-register — that would be the fake-delivery this covenant forbids. It is a
 * `refused` echo instead: `echoItem` renders it as a NOT-delivered system notice
 * (a ✗, no `MessageRecord`, structurally not a sent-looking authored message),
 * stating verbatim that the comment is a local draft not yet on the room ledger.
 * This mirrors the steer-mediation path, which already reports "not delivered".
 */
export function commentEcho(liveMount: boolean, anchor: string, quote: string, text: string): Echo {
  const q = quote.length > 46 ? `${quote.slice(0, 46)}…` : quote;
  return liveMount
    ? {
        delivery: 'refused',
        text: `comment not delivered — a local draft, not yet written to the room ledger (no durable comment write is wired on this surface yet) · ${anchor} · “${q}” — ${text}`,
      }
    : { delivery: 'said', text: `💬 ${anchor} · “${q}” — ${text}` };
}
