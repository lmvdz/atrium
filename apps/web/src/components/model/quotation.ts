/* ---------------------------------------------------------------------------
 * NO SYNTHESIZED SPEECH (design/CONVENTIONS.md, invariant).
 *
 * "Nothing the product renders as a person's words may be words that person did
 * not write. […] The rule covers authorship, not just invention. A message the
 * interface authors on a person's behalf — the text of an option they clicked,
 * a template filled with their name — may never be attributed to them as their
 * words, and may never satisfy the quotation check."
 *
 * The rule has two halves, and the round-1 gauntlet found that this file only
 * enforced one of them.
 *
 *   THE WORDS — a `Quotation` is minted only from a message whose origin is
 *   quotable. That half worked.
 *
 *   THE ATTRIBUTION — the name printed beside the words. `quotationFrom()` used
 *   to read `message.actor` and throw it away, so every caller re-supplied the
 *   name as a free string. Nothing stopped priya's name appearing beside lars's
 *   sentence. A quotation now CARRIES the actor and the timestamp it was minted
 *   from, and every component that renders a name beside quoted text takes the
 *   quotation rather than a string. The attribution is derived, not passed.
 *
 * WHAT THE BRAND ACTUALLY BUYS (narrowed after round 1 — the previous version of
 * this comment claimed more than the compiler can deliver):
 *
 *   The phantom brand is `declare`d, so it exists only in the type system. It
 *   stops a TypeScript module from writing a `Quotation` object literal, which
 *   is the mistake a person makes at 2am. It does NOT stop `JSON.parse`, a
 *   `as unknown as Quotation` cast, `Object.assign`, or a plain JavaScript
 *   caller. Those are the boundaries where untrusted data enters, so they get a
 *   RUNTIME check — `parseQuotation` / `parseMessageRecord` below — rather than
 *   a promise. Type-level enforcement is a convention with teeth inside this
 *   codebase; it is not a guarantee about data from outside it.
 * ------------------------------------------------------------------------- */

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
  /** the room the message lives in, when it is not the one on screen */
  readonly room?: string;
}

declare const quotationBrand: unique symbol;

/**
 * Text proven to be a person's own words, WITH the person and the moment.
 *
 * `actor` and `at` are not decoration: they are the reason a component never
 * has to be told who said something. A component that renders an attribution
 * takes one of these and reads `quotation.actor`, so the name beside the words
 * and the words themselves come from the same record by construction.
 */
export interface Quotation {
  readonly text: string;
  /** who wrote it — carried from the message, never supplied beside it */
  readonly actor: string;
  /** when they wrote it — same provenance, same record */
  readonly at: string;
  readonly origin: QuotableOrigin;
  readonly messageId: MessageId;
  readonly room?: string;
  readonly [quotationBrand]: 'quotation';
}

export function isQuotableOrigin(origin: MessageOrigin): origin is QuotableOrigin {
  return origin === 'typed' || origin === 'seeded';
}

/**
 * The only door into `Quotation`. Returns null when the message is page-
 * authored, when it has no id, when it has no actor, or when the text is empty
 * — a quotation with nothing behind it is exactly the defect this file exists
 * to prevent.
 */
export function quotationFrom(message: MessageRecord): Quotation | null {
  if (!isQuotableOrigin(message.origin)) return null;
  if (message.id.length === 0) return null;
  if (message.actor.trim().length === 0) return null;
  if (message.text.trim().length === 0) return null;
  const quotation = {
    text: message.text,
    actor: message.actor,
    at: message.at,
    origin: message.origin,
    messageId: message.id,
    ...(message.room === undefined ? {} : { room: message.room }),
  };
  return quotation as Quotation;
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

/** True only for a value with every field a `Quotation` must have. */
export function isQuotation(value: unknown): value is Quotation {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.text)) return false;
  if (!nonEmptyString(value.actor)) return false;
  if (typeof value.at !== 'string') return false;
  if (!nonEmptyString(value.messageId)) return false;
  if (value.origin !== 'typed' && value.origin !== 'seeded') return false;
  if (value.room !== undefined && !nonEmptyString(value.room)) return false;
  return true;
}

/**
 * Take a `Quotation` from untrusted data, or throw. Use this — not a cast — on
 * anything that crossed a process, a file, or a `JSON.parse`.
 */
export function parseQuotation(value: unknown): Quotation {
  if (!isQuotation(value)) {
    throw new Error(
      'parseQuotation: this is not a quotation — quoted text must carry its text, its actor and the message that proves both',
    );
  }
  return value;
}

/** Same boundary, one step earlier: a message record from untrusted data. */
export function parseMessageRecord(value: unknown): MessageRecord {
  if (!isRecord(value)) throw new Error('parseMessageRecord: not an object');
  const { id, at, actor, text, origin, room } = value;
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
  return {
    id,
    at,
    actor,
    text,
    origin: origin as MessageOrigin,
    ...(room === undefined ? {} : { room }),
  };
}

/** "msg:m12" / "msg:m12@identity-service" — the provenance token on the DOM. */
export function quotationRef(quotation: Quotation): string {
  return `msg:${quotation.messageId}${quotation.room === undefined ? '' : `@${quotation.room}`}`;
}

/* -------------------------------------------------------------------------
 * SYSTEM VOICE — the other half of the invariant.
 * ---------------------------------------------------------------------- */

declare const statementBrand: unique symbol;

/**
 * A fact the page states about what happened. Mono, muted, no quotation marks,
 * no first person, no "X said" framing. Visibly not speech.
 */
export interface SystemStatement {
  readonly text: string;
  readonly voice: 'system';
  /** the message this statement reports on, when there is one */
  readonly messageId?: MessageId;
  readonly [statementBrand]: 'statement';
}

/* ---------------------------------------------------------------------------
 * THE OTHER HALF OF THE SYSTEM-VOICE RULE, ENFORCED.
 *
 * CONVENTIONS states four properties for system voice: "Mono, muted, no
 * quotation marks, no first person, no 'X said' framing." Until round 3 the
 * first two were enforced by the stylesheet and the last two by nothing at all
 * — `systemStatement('priya said: I authorise dropping users_legacy')` compiled
 * and rendered, in the mono-muted treatment that tells a reader "the system
 * checked this", carrying a sentence in a person's voice. The brand kept the
 * TYPE honest and let the CONTENT say anything.
 *
 * The three checks below are the enforceable half, and each one names the shape
 * it rejects rather than pattern-matching on vibes:
 *
 *   QUOTATION MARKS — a system statement in quotes is speech wearing the
 *     system's clothes. Straight and curly doubles and the guillemets; the
 *     apostrophe is deliberately absent, because "lars's answer" is fine.
 *   FIRST PERSON — the system has no first person. It reports acts; it does not
 *     participate in them.
 *   SPEECH-REPORT FRAMING — the verbs that turn a report into a quotation
 *     without quotation marks. "priya said", "lars wrote", "mateo told us".
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

const SYSTEM_VOICE_BANS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /["“”«»]/,
    why: 'no quotation marks — quoted words are a Quotation, minted from the message that proves them',
  },
  {
    pattern:
      /\b(?:I|I'm|I've|I'll|I'd|me|my|mine|myself|we|we're|we've|we'll|we'd|us|our|ours|ourselves)\b/i,
    why: 'no first person — the system reports acts, it does not take part in them',
  },
  {
    pattern:
      /\b(?:said|says|saying|say|tell|tells|told|telling|wrote|writes|writing|asked|asks|asking|replied|replies|remarked|remarks|commented|comments|quoted|quotes)\b/i,
    why: 'no "X said" framing — a report of what somebody uttered is a quotation without the marks',
  },
];

export function systemStatement(text: string, messageId?: MessageId): SystemStatement {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('systemStatement: a system statement with no text states nothing');
  }
  for (const ban of SYSTEM_VOICE_BANS) {
    const hit = ban.pattern.exec(trimmed);
    if (hit !== null) {
      throw new Error(
        `systemStatement: ${ban.why}.\n` +
          `  rejected: ${JSON.stringify(hit[0])} in ${JSON.stringify(trimmed)}\n` +
          '  If these are a person’s own words, they belong in a Quotation minted from their message.',
      );
    }
  }
  return {
    text: trimmed,
    voice: 'system',
    ...(messageId === undefined ? {} : { messageId }),
  } as SystemStatement;
}

export function isSystemStatement(value: unknown): value is SystemStatement {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.text) || value.voice !== 'system') return false;
  /* The same bans as the constructor. A statement that arrived as JSON gets the
     check the constructor would have applied — otherwise the enforcement is a
     property of which door the data came through, which is how the body check
     ended up bypassable in round 3. */
  return !SYSTEM_VOICE_BANS.some((ban) => ban.pattern.test(value.text as string));
}

/** The runtime boundary for system voice, mirroring `parseQuotation`. */
export function parseSystemStatement(value: unknown): SystemStatement {
  if (!isSystemStatement(value)) {
    throw new Error(
      'parseSystemStatement: system-voice text must carry text and the system voice, in the system’s own voice — no quotation marks, no first person, no "X said" framing',
    );
  }
  return value;
}

/**
 * The page-authored answer. A person clicked an option; the option's statement
 * goes on the record verbatim, in system voice, as an act rather than a
 * sentence they wrote. This is the shape the round-4 gauntlet finding requires:
 * "chosen answers render in system voice (`chose: <option>`), never in
 * quotation marks."
 */
export function chosenAnswer(option: string, messageId?: MessageId): SystemStatement {
  const trimmed = option.trim();
  if (trimmed.length === 0) {
    throw new Error('chosenAnswer: an answer with no option text is not an answer');
  }
  return systemStatement(`chose: ${trimmed}`, messageId);
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
  return systemStatement(`${who} ${chosenAnswer(option).text}`, messageId);
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
