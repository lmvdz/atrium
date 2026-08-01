/* ---------------------------------------------------------------------------
 * NO SYNTHESIZED SPEECH (design/CONVENTIONS.md, invariant).
 *
 * "Nothing the product renders as a person's words may be words that person did
 * not write. […] The rule covers authorship, not just invention. A message the
 * interface authors on a person's behalf — the text of an option they clicked,
 * a template filled with their name — may never be attributed to them as their
 * words, and may never satisfy the quotation check."
 *
 * The mechanism here is a smart constructor over a branded type:
 *
 *   - `Quotation` carries a phantom brand whose key is a module-private
 *     `unique symbol`. No other module can name that key, so no other module
 *     can write a `Quotation` object literal. The brand is `declare`d, so it
 *     costs nothing at runtime and the value stays plain JSON.
 *   - `quotationFrom()` is the ONLY way to obtain one, and it returns `null`
 *     for a `chosen` message. A page-authored answer therefore cannot reach a
 *     quotation prop at all — not "should not", cannot.
 *   - Page-authored text is a different type (`SystemStatement`) taken by a
 *     different prop and rendered by a different component, in system voice,
 *     with no quotation marks and no first person.
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
 * Text proven to be a person's own words, with the message that proves it.
 * Unforgeable outside this module: see the brand note at the top of the file.
 */
export interface Quotation {
  readonly text: string;
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
 * authored, when it has no id, or when the text is empty — a quotation with
 * nothing behind it is exactly the defect this file exists to prevent.
 */
export function quotationFrom(message: MessageRecord): Quotation | null {
  if (!isQuotableOrigin(message.origin)) return null;
  if (message.id.length === 0) return null;
  if (message.text.trim().length === 0) return null;
  const quotation = {
    text: message.text,
    origin: message.origin,
    messageId: message.id,
    ...(message.room === undefined ? {} : { room: message.room }),
  };
  return quotation as Quotation;
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

export function systemStatement(text: string, messageId?: MessageId): SystemStatement {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('systemStatement: a system statement with no text states nothing');
  }
  return {
    text: trimmed,
    voice: 'system',
    ...(messageId === undefined ? {} : { messageId }),
  } as SystemStatement;
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
