/* ---------------------------------------------------------------------------
 * NO SYNTHESIZED SPEECH (design/CONVENTIONS.md, invariant).
 *
 * "Nothing the product renders as a person's words may be words that person did
 * not write. […] The rule covers authorship, not just invention. A message the
 * interface authors on a person's behalf — the text of an option they clicked,
 * a template filled with their name — may never be attributed to them as their
 * words, and may never satisfy the quotation check."
 *
 * FOUR ROUNDS, ONE DEFECT, FOUR ADDRESSES — and this is the fix that removes
 * the address rather than guarding it.
 *
 *   r1  the actor was a free string BESIDE the words.        → carry it
 *   r2  the free string moved into the BODY slot.            → derive the body
 *   r3  a caller wrote the entry literal and skipped the     → brand + re-derive
 *       factory.                                               at the renderer
 *   r4  `{...quotationFrom(msg)!, actor:'priya'}` compiled.  → THIS FILE
 *
 * The r4 gauntlet's root-cause sentence is the one worth keeping: NOTHING TIED
 * `quotation.actor` TO `quotation.messageId`. Every previous round answered by
 * adding a guard over the field that had just moved, and the next round moved
 * to the field beside it. A guard over a carried field is always one field
 * behind.
 *
 * SO A QUOTATION CARRIES NO FACT A READER SEES. It is a CITATION:
 *
 *     interface Citation  { messageId, mintedFrom }
 *     interface Quotation extends Citation {}
 *
 * `mintedFrom` is a checksum, not a fact: never printed, never read for its
 * value, and a mismatch throws rather than choosing a winner (round 6 moved it
 * off `AuthoredMessageEntry`, where it protected one of five boundaries, onto
 * the value, where it protects all of them). There is no actor to forge, no
 * text to forge, no timestamp to forge, because
 * there are no such fields. `{...quotation, actor: 'priya'}` does not type-check
 * (`actor` is an excess property on an object literal), and if it is smuggled in
 * as JSON it is ignored, because nothing reads it. The name, the words and the
 * time are LOOKED UP FROM THE MESSAGE ID at the render boundary, out of the same
 * record set the feed itself is built from — see `resolveQuotation` below and
 * `model/ledger.tsx`, which is how a component gets one.
 *
 * WHAT THE BRAND ACTUALLY BUYS (narrowed in round 1, narrowed again here after
 * the r4 receipt caught the previous version of this comment overclaiming):
 *
 *   The phantom brand is `declare`d, so it exists only in the type system. It
 *   stops a TypeScript module from writing a `Quotation` object literal. It does
 *   NOT stop `JSON.parse`, `as unknown as Quotation`, `Object.assign`, or a
 *   plain JavaScript caller — and, specifically, IT DOES NOT SURVIVE BEING
 *   CIRCUMVENTED BY A SPREAD: TypeScript carries `unique symbol` keys through
 *   object spread, so `{...aQuotation}` is still a `Quotation` as far as the
 *   compiler is concerned. That is exactly how round 4 forged one, and it is why
 *   the guarantee is now a property of the SHAPE (there is nothing to change)
 *   and of the RENDER BOUNDARY (everything printed is re-derived), rather than
 *   a property of the brand.
 * ------------------------------------------------------------------------- */

import type { Maybe } from './text';

export type MessageId = string;

/**
 * How a message came to exist.
 *
 * `typed`  — a human typed these words into the composer.
 * `seeded` — a human's words already on the record when the page loaded
 *            (replayed history). Quotable for the same reason `typed` is.
 * `chosen` — the interface authored it on the person's behalf: the statement
 *            behind a one-click answer. Recorded verbatim, attributed to the
 *            *act* of choosing, never to the person as their words.
 */
export type MessageOrigin = 'typed' | 'seeded' | 'chosen';

/** The two origins that may be quoted. `chosen` is deliberately absent. */
export type QuotableOrigin = Extract<MessageOrigin, 'typed' | 'seeded'>;

const ORIGINS: readonly MessageOrigin[] = ['typed', 'seeded', 'chosen'];

export interface MessageRecord {
  readonly id: MessageId;
  readonly at: string;
  readonly actor: string;
  readonly text: string;
  readonly origin: MessageOrigin;
  readonly attachments?: readonly MessageAttachmentRecord[];
  /**
   * THE ROOM THIS MESSAGE LIVES IN. Absolute, and about the record only.
   *
   * ROUND 8, D3. It was documented as "the room the message lives in, WHEN IT IS
   * NOT THE ONE ON SCREEN" — a fact defined relative to a viewport, stored on a
   * register this page deliberately shares across all four rooms so that
   * citations resolve. It cannot be relative to anything: one register, four
   * viewports, and a field whose meaning depends on which one you are looking
   * through is wrong in three of them.
   *
   * What it bought: `AttentionCard`, `ProvenanceRow` and `CorrectionLink` all
   * decided here-versus-elsewhere by asking whether the field was PRESENT, and
   * never compared it to the room being rendered. So `#identity-service`'s own
   * open question — whose source is `m-legal`, whose record says
   * `identity-service`, and whose cited message renders three rows below in that
   * very feed — wore the cross-room treatment and a tooltip reading "the source
   * of this item is in #identity-service, not here", under a head, a lens and a
   * feed all saying you were in #identity-service.
   *
   * `undefined` now means the register does not record a room for this message,
   * which is a third answer and not a synonym for "here". Nothing in the app
   * omits it. `sourceLocation()` below is the one comparison; no render boundary
   * makes its own.
   */
  readonly room?: string;
}

export interface MessageAttachmentRecord {
  readonly key: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

/** Where a cited message is, RELATIVE TO THE ROOM ON SCREEN — the only relative thing. */
export type SourceWhere = 'here' | 'elsewhere' | 'unrecorded';

export interface SourceLocation {
  readonly where: SourceWhere;
  /** the record's own room, absolute; null only when the register does not say */
  readonly room: Maybe<string>;
}

/**
 * THE COMPARISON, ONCE, IN THE ONE PLACE THAT KNOWS BOTH OPERANDS.
 *
 * A record's room is a fact about the record. "Here" is a fact about the
 * viewport. "Is this somewhere else?" is neither — it is a comparison, and a
 * comparison written at three render boundaries is three chances to write it
 * from one operand, which is exactly what round 8 shipped at all three.
 */
export function sourceLocation(
  /* A record or a resolved attribution — both carry the record's own room, and
     `Attribution.room` is `Maybe<string>` where `MessageRecord.room` is
     optional. One comparison, both shapes, so the receipt's excerpt row and the
     card's source link cannot answer differently. */
  record: { readonly room?: Maybe<string> },
  here: string,
): SourceLocation {
  const room = record.room ?? null;
  if (room === null) return { where: 'unrecorded', room: null };
  return { where: room === here ? 'here' : 'elsewhere', room };
}

declare const citationBrand: unique symbol;
declare const quotationBrand: unique symbol;

/**
 * A REFERENCE TO A MESSAGE ON THE RECORD, of any origin.
 *
 * Two fields, and neither of them is a fact a reader sees. `messageId` says
 * WHICH message; `mintedFrom` is a checksum of the record it was minted from,
 * never printed and never read for its value — see `recordFingerprint`.
 *
 * ROUND 6: the checksum lived on `AuthoredMessageEntry` and therefore protected
 * exactly one of the five render boundaries that resolve a citation. The other
 * four — the reply line, the composer's reply banner, the receipt's provenance
 * row and `<Quoted>` itself — took a bare id and resolved it against whatever
 * ledger they happened to be under, so a citation minted from lars's record
 * rendered priya's name inside a register that disagreed, at four addresses.
 * A guarantee that lives on ONE ROW TYPE protects one row type; a guarantee that
 * lives on THE VALUE protects everywhere the value goes.
 */
export interface Citation {
  readonly messageId: MessageId;
  /** a checksum of the record this citation was minted from — never rendered */
  readonly mintedFrom: string;
  readonly [citationBrand]: 'citation';
}

/**
 * A CITATION of a message whose words are that person's own.
 *
 * No carried facts, on purpose. Round 4 forged an attribution by spreading a
 * genuine quotation and overwriting `actor`; the fields it overwrote no longer
 * exist. Everything a component needs in order to render one — the words, the
 * name, the time, the room — comes from `resolveQuotation`, which reads the
 * record out of the ledger the page was built from. The citation says WHICH
 * message; the record says what it contains; nothing in between gets an opinion.
 */
export interface Quotation extends Citation {
  readonly [quotationBrand]: 'quotation';
}

/**
 * A resolved quotation: the citation, plus everything the cited record actually
 * says. Produced only by `resolveQuotation`, never carried across a boundary,
 * never stored on a prop — recompute it wherever it is needed, which is cheap
 * because it is a map lookup.
 */
export interface Attribution {
  readonly messageId: MessageId;
  readonly actor: string;
  readonly text: string;
  readonly at: string;
  readonly origin: QuotableOrigin;
  readonly room: string | null;
  readonly attachments: readonly MessageAttachmentRecord[];
}

export function isQuotableOrigin(origin: MessageOrigin): origin is QuotableOrigin {
  return origin === 'typed' || origin === 'seeded';
}

/**
 * The only door into `Quotation`. Returns null when the message is page-
 * authored, when it has no id, when it has no actor, or when the text is empty
 * — a quotation with nothing behind it is exactly the defect this file exists
 * to prevent.
 *
 * The checks are the same as they always were even though the returned value now
 * carries only the id: minting is where "is this message quotable at all?" gets
 * asked the first time. It is asked again at resolution, because a mint-time
 * check is a check the JSON path skips.
 */
export function quotationFrom(message: MessageRecord): Quotation | null {
  if (!isQuotableOrigin(message.origin)) return null;
  if (message.id.length === 0) return null;
  if (message.actor.trim().length === 0) return null;
  if (message.text.trim().length === 0) return null;
  return { messageId: message.id, mintedFrom: recordFingerprint(message) } as unknown as Quotation;
}

/**
 * A reference to a message of ANY origin — including a page-authored one.
 *
 * The receipt links to the superseded chosen answer; a chosen feed row is about
 * a chosen record; a cross-room trace points at the row it landed on. None of
 * those is quotable and all of them are message references, and before round 6
 * every one of them was a bare caller-supplied string that no register checked.
 * `Citation` is the reference; `Quotation` is a reference that additionally
 * proves the words are somebody's own.
 */
export function citationFrom(message: MessageRecord): Citation {
  if (message.id.trim().length === 0) {
    throw new Error('citationFrom: a message with no id cannot be cited');
  }
  return { messageId: message.id, mintedFrom: recordFingerprint(message) } as unknown as Citation;
}

/* -------------------------------------------------------------------------
 * THE LEDGER — the record set a citation is resolved against.
 *
 * This is deliberately NOT a module-level registry. A process-wide map keyed by
 * a caller-chosen id can be poisoned by whoever mints `{id:'m14', actor:'priya'}`
 * first, and it leaks between requests on a server. The ledger is a value, built
 * from the records a page was handed, and it flows down the tree the same way
 * every other prop does (model/ledger.tsx wraps that in a context so the
 * intermediate components do not have to carry it).
 * ---------------------------------------------------------------------- */

export interface MessageLedger {
  /** The record behind an id, or null when this page has never seen it. */
  readonly recordFor: (id: MessageId) => MessageRecord | null;
  /** How many records back it — asserted by the tests so a ledger cannot be silently empty. */
  readonly size: number;
}

export function messageLedger(records: Iterable<MessageRecord>): MessageLedger {
  const byId = new Map<MessageId, MessageRecord>();
  for (const record of records) {
    const existing = byId.get(record.id);
    /* TWO RECORDS CLAIMING ONE ID IS A THROW, NOT LAST-WRITE-WINS — and "two
       records" means TWO DIFFERENT RECORDS, compared by what a reader can see.
       ROUND 7, D5: this compared by REFERENCE (`existing !== record`), so two
       VALUE-IDENTICAL records for one id threw as loudly as a forgery. That is
       not a hypothetical difference. It is what a live adapter does every time
       it re-delivers a message the page already holds — an at-least-once
       delivery, a reconnect replay, a React re-render that rebuilt the array —
       and on `/` it was reachable from two clicks of Send in one task:

         [pageerror] messageLedger: two different records both claim the id "local-1"
         body.innerText → "This page couldn't load | Reload to try again, or go back."

       The rule is right and the implementation was measuring identity instead of
       disagreement. `recordFingerprint` is already the one description of "every
       field a reader can see", and it is what `resolveCitation` compares two
       registers with; comparing the same thing here makes idempotent
       re-delivery a no-op and a genuine disagreement a throw. */
    if (existing !== undefined && existing !== record) {
      const before = recordFingerprint(existing);
      const after = recordFingerprint(record);
      if (before !== after) {
        throw new Error(
          `messageLedger: two DIFFERENT records both claim the id ${JSON.stringify(record.id)} — a citation resolved against this ledger could name either of them.\n` +
            `  already held: ${before}\n` +
            `  offered:      ${after}\n` +
            '  Re-delivering a record this page already holds is fine; changing what it says is not.',
        );
      }
      /* Same id, same visible facts: the same message, delivered twice. Keep the
         one already held so the identity of what the ledger returns is stable
         across a re-delivery. */
      continue;
    }
    byId.set(record.id, record);
  }
  return {
    recordFor: (id) => byId.get(id) ?? null,
    size: byId.size,
  };
}

/**
 * A CHECKSUM OF A RECORD — never rendered, only compared.
 *
 * Found by the blind cross-lineage review of round 5, and it is the same
 * "two sources of truth" shape one level out. `RoomFrame` takes the feed rows
 * and the record register as INDEPENDENT props, so a caller can mint a row from
 * lars's record and render it inside a ledger whose `m14` says priya — no cast,
 * no forged field, and the body check passes because only the name differs.
 * `messageLedger` refuses two records under one id *within its own input*; it
 * cannot see the record the row was minted from.
 *
 * So a row carries a fingerprint of the record it was minted from, and the
 * render boundary recomputes it from the record it is about to resolve against.
 * This is NOT the carried-field pattern this round deleted: nothing here is
 * printed, nothing here is read for its value, and a mismatch throws rather than
 * choosing a winner. An attribution is a claim about who; a checksum is a claim
 * that two registers are the same register.
 */
export function recordFingerprint(record: MessageRecord): string {
  /* EVERY FIELD A READER CAN SEE, which is the property CONVENTIONS states and
     which the round-5 version did not have: `room` was left out, and `room` is
     read at the render boundary and printed into `data-quoted` as
     `msg:m10@identity-service`. Two records differing only in room hashed
     identically, so the one check that says "these two registers are the same
     register" could not see a difference the DOM was publishing. The register
     that disagrees about the field you left out is the one that gets through.

     `room` is optional, so it is encoded as a distinguishable absence rather
     than as the empty string: `room: ''` is refused by `parseMessageRecord`, but
     a cast is not, and `∅` is not a room name a record can hold. */
  return [
    record.id,
    record.origin,
    record.at,
    record.actor,
    record.text,
    record.room ?? '∅',
    JSON.stringify(record.attachments ?? []),
  ]
    .map((part) => `${part.length}:${part}`)
    .join('|');
}

/**
 * THE DERIVATION. Everything a render boundary prints beside quoted words comes
 * out of here, and it throws rather than degrading — a row that renders a name
 * over words that are not on that person's record is the one failure this whole
 * model exists to prevent, and a silently corrected render is a corrected render
 * nobody finds out about.
 *
 * `from` names the caller so a stack-free error still says which boundary
 * refused, exactly as `bodyDivergence` does for the words.
 */
export function resolveCitation(
  ledger: MessageLedger,
  citation: Citation,
  from: string,
): MessageRecord {
  const id = citation.messageId;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(`${from}: a citation with no message id cites nothing`);
  }
  const record = ledger.recordFor(id);
  if (record === null) {
    throw new Error(
      `${from}: ${JSON.stringify(id)} is not a message on this page's record, so there is nobody to attribute it to.\n` +
        '  A quotation is a citation; it is only worth what the cited record says.',
    );
  }
  /* THE CITATION AND THE LEDGER ARE THE SAME REGISTER, OR THIS DOES NOT RESOLVE.
     One check, on the path every one of the five render boundaries takes,
     instead of one check on one row type. A mismatch means two registers
     disagree about one message, which is exactly the state in which a name over
     words is a coin flip. */
  const here = recordFingerprint(record);
  if (citation.mintedFrom !== here) {
    throw new Error(
      `${from}: this citation was minted from a different record than the one this page holds for ${id}.\n` +
        '  A citation and the register it is resolved against have to be the same register; two records for one message id is not a near-miss.\n' +
        `  minted from: ${String(citation.mintedFrom)}\n` +
        `  on this page: ${here}`,
    );
  }
  return record;
}

export function resolveQuotation(
  ledger: MessageLedger,
  quotation: Quotation,
  from: string,
): Attribution {
  const record = resolveCitation(ledger, quotation, from);
  const id = record.id;
  if (!isQuotableOrigin(record.origin)) {
    throw new Error(
      `${from}: ${id} is page-authored (origin ${record.origin}); it may be reported in system voice, never quoted as somebody's words`,
    );
  }
  if (record.actor.trim().length === 0 || record.text.trim().length === 0) {
    throw new Error(`${from}: ${id} has no actor or no text — there is nothing to attribute`);
  }
  return {
    messageId: record.id,
    actor: record.actor,
    text: record.text,
    at: record.at,
    origin: record.origin,
    room: record.room ?? null,
    attachments: record.attachments ?? [],
  };
}

/* -------------------------------------------------------------------------
 * RUNTIME BOUNDARY.
 *
 * Everything above is compile-time. These are the checks that hold when the
 * data did not come from a TypeScript literal: a fetch, a JSON file, a cast, a
 * JavaScript caller. #25 (replay) and #27 (live) both feed this layer from
 * outside, so the boundary is where they hand data over.
 * ---------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * True only for a citation this ledger can resolve.
 *
 * The ledger is REQUIRED rather than optional. "Is this shaped like a
 * quotation?" is not a question worth answering on its own — the shape is one
 * string — and an optional second argument is an exemption with a default,
 * which is the shape of every hole the last four rounds found.
 */
export function isQuotation(value: unknown, ledger: MessageLedger): value is Quotation {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.messageId)) return false;
  const record = ledger.recordFor(value.messageId);
  if (record === null) return false;
  if (!isQuotableOrigin(record.origin)) return false;
  return nonEmptyString(record.actor) && nonEmptyString(record.text);
}

/** The same boundary for a reference of any origin. */
export function isCitation(value: unknown, ledger: MessageLedger): value is Citation {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.messageId)) return false;
  return ledger.recordFor(value.messageId) !== null;
}

/**
 * Take a `Citation` from untrusted data, or throw.
 *
 * The checksum is RE-DERIVED from this ledger's record rather than read off the
 * payload: a fingerprint that arrived with the data is a claim by the sender
 * about a register the sender cannot see. Everything that crossed a process
 * boundary is, by definition, being adopted into THIS page's register, and the
 * parse is where that adoption is checked (the id has to resolve here) and
 * recorded (the checksum is this page's).
 */
export function parseCitation(value: unknown, ledger: MessageLedger): Citation {
  if (!isCitation(value, ledger)) {
    throw new Error(
      'parseCitation: this is not a citation — a message reference has to name a message on this page’s record',
    );
  }
  const id = (value as { messageId: MessageId }).messageId;
  const record = ledger.recordFor(id) as MessageRecord;
  return adopt(value, record, 'parseCitation') as unknown as Citation;
}

/**
 * THE PARSER MAY NOT LAUNDER PROVENANCE.
 *
 * Found by the blind cross-lineage review of round 6's own fix, and it is the
 * round's own defect committed by the round's own fix. The first version of
 * these parsers DISCARDED the incoming `mintedFrom` and minted a fresh one from
 * the destination ledger, justified by a comment saying that data crossing a
 * process boundary is being adopted into this page's register. The consequence:
 *
 *     const foreign = quotationFrom(larsRecord)!;     // register A
 *     const here = messageLedger([priyaRecordSameId]); // register B
 *     resolveQuotation(here, parseQuotation(foreign, here), 'x');
 *     // → priya, "drop it". No throw.
 *
 * The one check that says "these two registers are the same register" was
 * satisfied by a function whose whole job was to replace its evidence. A
 * laundering step in front of a checksum is worse than no checksum, because the
 * checksum is what everything downstream now trusts.
 *
 * So: a value that ARRIVES WITH a fingerprint must match this page's record —
 * that is a claim about a register, and a claim that disagrees is refused. A
 * value that arrives WITHOUT one (genuine external data that never had a
 * register: a JSON file, a fetch, a JavaScript caller) is adopted, and the
 * adoption is explicit and happens exactly here, at the boundary whose job it is.
 */
function adopt(
  value: unknown,
  record: MessageRecord,
  from: string,
): { messageId: MessageId; mintedFrom: string } {
  const here = recordFingerprint(record);
  const arrived = (value as { mintedFrom?: unknown }).mintedFrom;
  if (typeof arrived === 'string' && arrived.length > 0 && arrived !== here) {
    throw new Error(
      `${from}: this reference was minted from a different record than the one this page holds for ${record.id}.\n` +
        '  A parser may adopt a reference that never had a register; it may not overwrite one that disagrees with this page.\n' +
        `  minted from: ${arrived}\n` +
        `  on this page: ${here}`,
    );
  }
  return { messageId: record.id, mintedFrom: here };
}

/**
 * Take a `Quotation` from untrusted data, or throw. Use this — not a cast — on
 * anything that crossed a process, a file, or a `JSON.parse`.
 *
 * Whatever else the incoming object carried is DROPPED: the returned citation
 * holds the id and nothing else, so a payload that arrived with an `actor` on it
 * cannot survive into the tree even by accident.
 */
export function parseQuotation(value: unknown, ledger: MessageLedger): Quotation {
  if (!isQuotation(value, ledger)) {
    throw new Error(
      'parseQuotation: this is not a quotation — quoted text must cite a message on the record, and that message must be one a person actually wrote',
    );
  }
  const id = (value as { messageId: MessageId }).messageId;
  const record = ledger.recordFor(id) as MessageRecord;
  return adopt(value, record, 'parseQuotation') as unknown as Quotation;
}

/** Same boundary, one step earlier: a message record from untrusted data. */
export function parseMessageRecord(value: unknown): MessageRecord {
  if (!isRecord(value)) throw new Error('parseMessageRecord: not an object');
  const { id, at, actor, text, origin, room, attachments } = value;
  if (!nonEmptyString(id)) throw new Error('parseMessageRecord: a message needs an id');
  if (typeof at !== 'string') throw new Error('parseMessageRecord: a message needs a timestamp');
  if (!nonEmptyString(actor)) throw new Error('parseMessageRecord: a message needs an actor');
  if (typeof text !== 'string') throw new Error('parseMessageRecord: a message needs text');
  if (typeof origin !== 'string' || !ORIGINS.includes(origin as MessageOrigin)) {
    throw new Error(
      `parseMessageRecord: origin must be one of ${ORIGINS.join(', ')} — an unlabelled message cannot be told from a page-authored one`,
    );
  }
  if (room !== undefined && !nonEmptyString(room)) {
    throw new Error('parseMessageRecord: room, when present, names a room');
  }
  if (
    attachments !== undefined &&
    (!Array.isArray(attachments) ||
      attachments.some(
        (attachment) =>
          !isRecord(attachment) ||
          !nonEmptyString(attachment.key) ||
          !nonEmptyString(attachment.name) ||
          !nonEmptyString(attachment.contentType) ||
          typeof attachment.size !== 'number' ||
          !Number.isSafeInteger(attachment.size) ||
          attachment.size <= 0,
      ))
  ) {
    throw new Error('parseMessageRecord: attachments must carry key, name, type and size');
  }
  return {
    id,
    at,
    actor,
    text,
    origin: origin as MessageOrigin,
    ...(room === undefined ? {} : { room }),
    ...(attachments === undefined
      ? {}
      : { attachments: attachments as unknown as MessageAttachmentRecord[] }),
  };
}

/**
 * "msg:m12" / "msg:m12@identity-service" — the provenance token on the DOM.
 *
 * It takes the RESOLVED attribution rather than the citation, because the room
 * is a fact about the record and not about the citation. A token built from a
 * carried field is a token that can point at the wrong room.
 */
export function quotationRef(attribution: Attribution): string {
  return `msg:${attribution.messageId}${attribution.room === null ? '' : `@${attribution.room}`}`;
}

/* -------------------------------------------------------------------------
 * SYSTEM VOICE — the other half of the invariant.
 * ---------------------------------------------------------------------- */

declare const statementBrand: unique symbol;

/**
 * One span of a system statement, tagged with WHO WROTE THE WORDS.
 *
 * `system`   — the page's own framing. It is held to the whole system-voice
 *              rule: no quotation marks, no first person, no "X said".
 * `verbatim` — a page-authored payload the system is REPORTING rather than
 *              speaking: the text of the option somebody clicked, recorded
 *              exactly as it was offered. Ordinary English, pronouns and all.
 */
export type StatementPart =
  | { readonly voice: 'system'; readonly text: string }
  | { readonly voice: 'verbatim'; readonly text: string };

/**
 * A fact the page states about what happened. Mono, muted, no quotation marks,
 * no first person, no "X said" framing. Visibly not speech.
 *
 * `parts` is the statement's own account of which words it wrote and which
 * words it is quoting back from a button, so the JSON boundary can apply the
 * same split the constructor did instead of guessing from the finished string.
 */
export interface SystemStatement {
  readonly text: string;
  readonly voice: 'system';
  readonly parts: readonly StatementPart[];
  /** the message this statement reports on, when there is one */
  readonly messageId?: MessageId;
  readonly [statementBrand]: 'statement';
}

/* ---------------------------------------------------------------------------
 * THE OTHER HALF OF THE SYSTEM-VOICE RULE, ENFORCED — AND SCOPED.
 *
 * CONVENTIONS states four properties for system voice: "Mono, muted, no
 * quotation marks, no first person, no 'X said' framing." Until round 3 the
 * first two were enforced by the stylesheet and the last two by nothing at all
 * — `systemStatement('priya said: I authorise dropping users_legacy')` compiled
 * and rendered, in the mono-muted treatment that tells a reader "the system
 * checked this", carrying a sentence in a person's voice.
 *
 * ROUND 4 ENFORCED IT OVER THE WRONG SPAN. The bans were applied to the whole
 * finished string, which includes the OPTION PAYLOAD — so
 * `messageEntry` threw, at render, on "Keep it behind our retention window",
 * "Give us another day", "Yes — I approve" and "Ship it, we agreed". A product
 * whose reversible one-click answers must avoid the five commonest pronouns in
 * English is not a product; and the failure was a runtime throw inside render
 * rather than a compile error, so it would have shipped and then fallen over on
 * a real customer's button copy.
 *
 * The rule was never about the letters. It is about WHO IS SPEAKING:
 *
 *   The INTERFACE may not speak in the first person, may not put words in
 *   quotation marks, and may not report what somebody uttered. Its own framing
 *   is held to all three.
 *
 *   A VERBATIM PAYLOAD — the text of the option that was clicked — is not the
 *   interface speaking. It is the interface reporting, exactly, what was on the
 *   button. It keeps its pronouns. What it may NOT do is arrive dressed as
 *   speech, so quotation marks stay banned there too, and it may never be the
 *   opening span: a statement that starts with somebody else's words is a
 *   quotation without the marks, whatever the type says.
 *
 * WHAT THIS DOES NOT CATCH, stated so the next round does not have to discover
 * it: the check is lexical. `systemStatement('priya: drop the table')` still
 * compiles — a colon is not a speech verb, and banning colons would take out
 * `chose:`, `parity #415 passed with 0 diffs · 12:29` and every label in the
 * receipt. What stops THAT from being an attribution is structural rather than
 * lexical, and it is the part that actually carries the guarantee: a
 * SystemStatement has no actor field, no component renders one beside it, and
 * `<SystemVoice>` paints it in the mono-muted system treatment with no
 * attribution column. The row that carries it (`ChosenMessageEntry`) has no
 * field a renderer could put a name in. These checks narrow the ways a
 * page-authored string can LOOK like speech; the type is what stops it being
 * ATTRIBUTED as speech, and the type is the load-bearing half.
 * ------------------------------------------------------------------------- */

interface Ban {
  readonly pattern: RegExp;
  readonly why: string;
}

const QUOTATION_MARKS: Ban = {
  /* The straight double, the curly doubles, the guillemets, the low-9 doubles
     and the CJK corner brackets. The APOSTROPHE FAMILY is deliberately absent in
     both directions — "lars's answer" and "lars’s answer" are ordinary English —
     which is why the single curly quotes are not here either.

     Stated limit, from the round-5 blind review: this is a list of code points,
     so a homoglyph (a fullwidth quotation mark, a Cherokee letter shaped like
     "I") is outside it. The lexical bans narrow how a page-authored string can
     LOOK like speech; what stops it being ATTRIBUTED as speech is structural,
     and that half does not care what alphabet the letters came from. */
  pattern: /["“”«»„‟「」『』]/,
  why: 'no quotation marks — quoted words are a Quotation, minted from the message that proves them',
};

const FIRST_PERSON: Ban = {
  pattern:
    /\b(?:I|I'm|I've|I'll|I'd|me|my|mine|myself|we|we're|we've|we'll|we'd|us|our|ours|ourselves)\b/i,
  why: 'no first person — the system reports acts, it does not take part in them',
};

const SPEECH_REPORT: Ban = {
  pattern:
    /\b(?:said|says|saying|say|tell|tells|told|telling|wrote|writes|writing|asked|asks|asking|replied|replies|remarked|remarks|commented|comments|quoted|quotes)\b/i,
  why: 'no "X said" framing — a report of what somebody uttered is a quotation without the marks',
};

/** What the INTERFACE writes is held to the whole rule. */
const SYSTEM_VOICE_BANS: readonly Ban[] = [QUOTATION_MARKS, FIRST_PERSON, SPEECH_REPORT];

/**
 * What the interface REPORTS keeps its pronouns and its speech verbs — it is
 * somebody's button copy, recorded as offered — but it may not wear quotation
 * marks, because that is the one thing that makes page-authored text look like
 * a person's utterance rather than a recorded choice.
 */
const VERBATIM_BANS: readonly Ban[] = [QUOTATION_MARKS];

const BANS_FOR: Readonly<Record<StatementPart['voice'], readonly Ban[]>> = {
  system: SYSTEM_VOICE_BANS,
  verbatim: VERBATIM_BANS,
};

/**
 * The ONE framing a recorded payload may appear behind: "chose: " or
 * "<who> chose: ".
 *
 * Round 5's first version let a caller pair any framing with any payload
 * through a public `composeStatement`, and the blind cross-lineage review broke
 * it in one line: `[{system:'priya '}, {verbatim:'said: I approve…'}]` passed,
 * because the system span held no banned token and the verbatim span was exempt
 * from the speech-report and first-person bans. The rendered statement read
 * "priya said: I approve…" — page-authored text made to look like priya
 * speaking, which is the exact thing this file exists to prevent.
 *
 * The payload exemption is not a property of a span; it is a property of ONE
 * SENTENCE SHAPE — "somebody chose an option, and this is the option". So the
 * shape is what is checked, the general composer is module-private, and the
 * only public doors to a payload are `chosenAnswer` and `chosenAct`.
 */
const CHOSE_FRAMING = /^(?:[^\s:]+ )?chose: $/;

/** The single description of "this is not the system's voice", shared by the constructor and the boundary. */
function statementDefect(parts: readonly StatementPart[]): string | null {
  if (parts.length === 0) return 'a system statement with no parts states nothing';
  const first = parts[0];
  if (first === undefined || first.voice !== 'system' || first.text.trim().length === 0) {
    return (
      'a system statement must OPEN in the system’s own voice.\n' +
      '  A statement whose first words are a recorded payload is a quotation without the marks — ' +
      'the framing is what says these words are being reported rather than spoken.'
    );
  }
  if (parts.some((part) => part.voice === 'verbatim')) {
    if (parts.length !== 2 || parts[1]?.voice !== 'verbatim') {
      return (
        'a recorded payload is one span behind one framing, and nothing else.\n' +
        '  Anything more is a caller composing a sentence out of an exempt span and a name.'
      );
    }
    if (!CHOSE_FRAMING.test(first.text)) {
      return (
        `a recorded payload may only follow "chose: " or "<who> chose: ", not ${JSON.stringify(first.text)}.\n` +
        '  The exemption belongs to that sentence shape — "somebody chose an option, and this is the option" — ' +
        'not to any framing a caller cares to write in front of it.'
      );
    }
  }
  if (
    parts
      .map((part) => part.text)
      .join('')
      .trim().length === 0
  ) {
    return 'a system statement with no text states nothing';
  }
  for (const part of parts) {
    if (part.voice !== 'system' && part.voice !== 'verbatim') {
      return `a statement part must be system or verbatim, not ${JSON.stringify(String((part as StatementPart).voice))}`;
    }
    for (const ban of BANS_FOR[part.voice]) {
      const hit = ban.pattern.exec(part.text);
      if (hit !== null) {
        return (
          `${ban.why}.\n` +
          `  rejected: ${JSON.stringify(hit[0])} in the ${part.voice} span ${JSON.stringify(part.text)}\n` +
          '  If these are a person’s own words, they belong in a Quotation minted from their message.'
        );
      }
    }
  }
  return null;
}

/**
 * Build a statement out of spans, each tagged with who wrote it.
 *
 * MODULE-PRIVATE ON PURPOSE. The public doors are `systemStatement` (all
 * framing) and `chosenAnswer` / `chosenAct` (one fixed framing plus one
 * payload). Exporting the general composer is what let the blind review write
 * `[{system:'priya '}, {verbatim:'said: I approve…'}]` — the shape check above
 * refuses it now, and not exporting this means a caller cannot reach for it in
 * the first place.
 */
function composeStatement(parts: readonly StatementPart[], messageId?: MessageId): SystemStatement {
  const trimmed = parts.map((part, index) => ({
    voice: part.voice,
    /* Only the outer edges are trimmed: a space between the framing and the
       payload is what keeps "lars chose:" from welding onto the option. */
    text:
      index === 0
        ? part.text.trimStart()
        : index === parts.length - 1
          ? part.text.trimEnd()
          : part.text,
  })) as StatementPart[];
  const defect = statementDefect(trimmed);
  if (defect !== null) throw new Error(`systemStatement: ${defect}`);
  /* `as unknown as` because the phantom key cannot be written — which is the
     point of it. This is the one place in the program allowed to mint one. */
  return {
    text: trimmed.map((part) => part.text).join(''),
    voice: 'system',
    parts: trimmed,
    ...(messageId === undefined ? {} : { messageId }),
  } as unknown as SystemStatement;
}

/** A statement the system wrote in full — every word of it is the interface speaking. */
export function systemStatement(text: string, messageId?: MessageId): SystemStatement {
  if (text.trim().length === 0) {
    throw new Error('systemStatement: a system statement with no text states nothing');
  }
  return composeStatement([{ voice: 'system', text: text.trim() }], messageId);
}

export function isSystemStatement(value: unknown): value is SystemStatement {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.text) || value.voice !== 'system') return false;
  /* A statement that arrived without its parts is treated as ALL SYSTEM VOICE,
     which is the strictest reading — the default direction is never the lenient
     one. An arrival that wants the payload exemption has to declare where the
     payload is, and then the text has to agree with the parts. */
  const parts = Array.isArray(value.parts)
    ? (value.parts as readonly StatementPart[])
    : [{ voice: 'system' as const, text: value.text }];
  for (const part of parts) {
    if (!isRecord(part) || typeof part.text !== 'string') return false;
    if (part.voice !== 'system' && part.voice !== 'verbatim') return false;
  }
  if (parts.map((part) => part.text).join('') !== value.text) return false;
  /* The same bans as the constructor. A statement that arrived as JSON gets the
     check the constructor would have applied — otherwise the enforcement is a
     property of which door the data came through, which is how the body check
     ended up bypassable in round 3. */
  return statementDefect(parts) === null;
}

/**
 * THE RENDER BOUNDARY FOR SYSTEM VOICE. Every place that puts a statement's
 * words on screen goes through this, and it throws rather than degrading.
 *
 * Found by the blind cross-lineage review of round 5: the bans held at the
 * constructor and at `parseSystemStatement`, and four components rendered
 * `statement.text` directly — so a cast or a JSON payload put "I approve
 * deleting users_legacy." into a receipt's history line beside a free `who`
 * string and it printed. That is round 3's finding ("a guarantee that holds only
 * for callers who used the door it was installed in") in the one artifact whose
 * whole job is being the trustworthy record.
 *
 * The pattern is the same one the attribution half uses: the check that matters
 * is the one on the path every render takes, not the one at the constructor.
 */
export function statementText(statement: SystemStatement, from: string): string {
  if (!isSystemStatement(statement)) {
    throw new Error(
      `${from}: this is not system voice — a statement the page prints has to be in the system’s own voice ` +
        '(no quotation marks, no first person, no "X said" framing), and a recorded payload has to say that it is one.\n' +
        `  rejected: ${JSON.stringify(String((statement as { text?: unknown })?.text).slice(0, 120))}`,
    );
  }
  return statement.text;
}

/**
 * The system-voice bans, for the OTHER page-authored strings.
 *
 * Found by the round-5 blind review: `Rationale` is a branded non-empty string
 * that `AttentionCard` renders under `data-voice="system"`, and its constructor
 * checked length and nothing else — so `rationale('priya said: I approve the
 * drop')` compiled and rendered in the mono-muted treatment that tells a reader
 * the system checked this. That is the round-3 `systemStatement` finding in the
 * type next door, which is what happens when doctrine is written for one
 * page-authored string and applied to one page-authored string.
 */
export function systemVoiceDefect(text: string): string | null {
  for (const ban of SYSTEM_VOICE_BANS) {
    const hit = ban.pattern.exec(text);
    if (hit !== null) return `${ban.why} (rejected ${JSON.stringify(hit[0])})`;
  }
  return null;
}

/**
 * THE THIRD PAGE-AUTHORED STRING SINK, and it is a sink rather than a type.
 *
 * Round 6 fixed `Rationale` at the renderer because round 5 had fixed only
 * `SystemStatement`, and wrote down "there are two page-authored string types".
 * A blind sweep of every element carrying `data-voice="system"` found six render
 * sites and three unchecked string sinks inside them: the trailer's lead, the
 * trailer's last-check time, and the room name in the cross-room trace. None of
 * them has a constructor to be checked at — they are plain props — so the
 * renderer is not merely the last place the check can go, it is the only place.
 *
 * `systemText` is that check, for a string the page states inside the mono-muted
 * treatment without minting a `SystemStatement` for it: a room name, a clock, a
 * derived summary clause. It is deliberately NOT a branded type. A brand buys a
 * compile-time door, and the thing being prevented here reaches the screen from
 * a prop with no door at all; what the value needs is the check on the path, and
 * a fourth brand would suggest the doors were the guarantee.
 *
 * ROUND 7 CORRECTED THE RULE'S SCOPE. It used to read "anything a caller
 * supplies that renders inside `data-voice="system"`" — which is a denominator
 * supplied by the claim, the exact thing CONVENTIONS' harness section condemns,
 * and `test/system-voice.test.tsx` took its count from that attribute. The blind
 * review of round 6's fix found four sinks outside it, two of them in the
 * receipt: `ProvenanceEntry.note` printed inside the same `<button>` as a
 * resolved quotation on the line after the quoted words, `CorrectionEntry.heading`
 * in the layout slot round 6 had just deleted `HappenedLine.who` from,
 * `RowTag.label` welded onto the end of a person's own sentence, and
 * `AttentionItem.facts`.
 *
 * The general rule is: **every caller-supplied string the page prints goes
 * through a check on the render path**, and `test/printed-strings.test.tsx`
 * enumerates those from the TYPES and the JSX rather than from an attribute the
 * page chose to write.
 */
export function systemText(value: string, from: string): string {
  const painted = String(value);
  const defect = systemVoiceDefect(painted);
  if (defect !== null) {
    throw new Error(
      `${from}: ${defect}.\n` +
        '  This string is painted in the system’s own voice; it is never somebody’s words.\n' +
        `  rejected: ${JSON.stringify(painted.slice(0, 120))}`,
    );
  }
  return painted;
}

/**
 * THE OTHER DOOR, AND WHY THERE ARE EXACTLY TWO.
 *
 * `systemText` holds a string to the whole system-voice rule, which is right for
 * everything the page STATES and wrong for the copy ON A CONTROL. Round 4 already
 * shipped that mistake once, at the model layer: the first-person ban was applied
 * to the option payload, so "Keep it behind our retention window", "Give us
 * another day", "Yes — I approve" and "Ship it, we agreed" all threw at render.
 * A product whose buttons cannot contain the five commonest pronouns in English
 * is not a product, and CONVENTIONS records the fix as a split by WHO IS
 * SPEAKING rather than by which letters are in the string.
 *
 * `offeredText` is that same split, applied to a printed string rather than to a
 * span of a `SystemStatement`. It is the text of something the page is OFFERING
 * — a button's label, its tooltip, the hold control's contract line. It keeps its
 * pronouns, exactly as a `verbatim` span does; what it may not do is wear
 * quotation marks, because that is the one thing that makes page-authored text
 * read as an utterance.
 *
 * It is the WEAKER door, so it is bounded structurally rather than by care:
 * `test/printed-strings.test.tsx` requires every call site to sit inside a
 * control (`<button>`, `<HoldToAct>`, `<a>`, `<summary>`), and asserts that list.
 * CONVENTIONS' rule for the `verbatim` exemption is that it belongs to a sentence
 * SHAPE and not to a span; this is the same rule for a printed string — it
 * belongs to a CONTROL, not to whoever reaches for the laxer function.
 */
export function offeredText(value: string, from: string): string {
  const painted = String(value);
  const hit = QUOTATION_MARKS.pattern.exec(painted);
  if (hit !== null) {
    throw new Error(
      `${from}: ${QUOTATION_MARKS.why} (rejected ${JSON.stringify(hit[0])}).\n` +
        '  This is the copy on a control the page offers. It keeps its pronouns — it is not the system speaking — but quotation marks are what make offered text read as somebody’s utterance.\n' +
        `  rejected: ${JSON.stringify(painted.slice(0, 120))}`,
    );
  }
  return painted;
}

/** The runtime boundary for system voice, mirroring `parseQuotation`. */
export function parseSystemStatement(value: unknown): SystemStatement {
  if (!isSystemStatement(value)) {
    throw new Error(
      'parseSystemStatement: system-voice text must carry text and the system voice, in the system’s own voice — no quotation marks, no first person, no "X said" framing, and a recorded payload has to say that it is one',
    );
  }
  return value;
}

/**
 * The page-authored answer. A person clicked an option; the option's statement
 * goes on the record verbatim, in system voice, as an act rather than a
 * sentence they wrote.
 *
 * `chose: ` is the system's framing and is held to the whole rule; the option
 * is a verbatim payload and keeps whatever ordinary English it was written in.
 * Round 4 held the option to the framing's rule and threw on "Yes — I approve".
 */
export function chosenAnswer(option: string, messageId?: MessageId): SystemStatement {
  const trimmed = option.trim();
  if (trimmed.length === 0) {
    throw new Error('chosenAnswer: an answer with no option text is not an answer');
  }
  return composeStatement(
    [
      { voice: 'system', text: 'chose: ' },
      { voice: 'verbatim', text: trimmed },
    ],
    messageId,
  );
}

/**
 * The same act, said in the third person with the actor in it: "lars chose: …".
 *
 * This is what a page-authored answer looks like on a feed row. The person's
 * name is INSIDE a system-voice sentence rather than in an attribution column,
 * which is the whole difference between reporting an act and quoting a person.
 */
export function chosenAct(actor: string, option: string, messageId?: MessageId): SystemStatement {
  const who = actor.trim();
  if (who.length === 0) {
    throw new Error('chosenAct: an act with nobody behind it is not on the record');
  }
  const trimmed = option.trim();
  if (trimmed.length === 0) {
    throw new Error('chosenAnswer: an answer with no option text is not an answer');
  }
  return composeStatement(
    [
      { voice: 'system', text: `${who} chose: ` },
      { voice: 'verbatim', text: trimmed },
    ],
    messageId,
  );
}

/**
 * The one honest way to turn a message into renderable record text: a typed or
 * seeded message becomes a quotation; a chosen one becomes a system statement.
 * There is no third outcome and no way to get the wrong one.
 */
export type AttributedText =
  | { readonly as: 'quotation'; readonly quotation: Quotation }
  | { readonly as: 'system'; readonly statement: SystemStatement };

export function attribute(message: MessageRecord): AttributedText {
  const quotation = quotationFrom(message);
  if (quotation !== null) return { as: 'quotation', quotation };
  return { as: 'system', statement: chosenAnswer(message.text, message.id) };
}
