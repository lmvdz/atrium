import type { AcceptedObjectType } from './objects.js';
import { RECEIPT_POLICY, type ReceiptPolicy } from './policy.js';

/**
 * Deterministic text triggers, computed *before* any model call, plus the
 * deterministic checks a proposal must survive *after* one.
 *
 * ## Why this file exists at all
 *
 * #8 resolved interpretation as two tiers: a cheap default pass, and an
 * escalation to a stronger model on four conditions — the pass proposes a
 * supersession, attributes a commitment to a third party, contradicts accepted
 * state, or lands its confidence between θ_min and θ_auto.
 *
 * The interpretation spike measured all four against a real corpus and the
 * amendment on #8 replaced them, because **all four are read off the default
 * pass's own self-report and the default pass does not produce them**:
 *
 * | #8 trigger                         | fired, over six runs                     |
 * | ---------------------------------- | ---------------------------------------- |
 * | proposes a supersession            | 0/6, against a corpus containing one      |
 * | third-party commitment attribution | 0/6 — one commitment total, self-attributed |
 * | contradicts accepted state         | 0, on a window of people hurt by exactly that decision |
 * | θ-band confidence                  | unusable: 0.937 mean on wrong objects vs 0.928 on right |
 *
 * As specified, the escalation tier was close to dead code. The amendment routes
 * on the *raw text of the window instead*, before a model has seen it — which
 * costs nothing, is testable without a model, and fires on the 10–15% of
 * messages that carry the load, which is the cost profile #7 assumed.
 *
 * Everything here is a pure function of text. No model, no clock, no I/O. #23's
 * worker calls `evaluateEscalation` to pick a tier and
 * `validateProposalProvenance` to check what came back.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * Text normalization — shared by the triggers and the provenance checks
 * ───────────────────────────────────────────────────────────────────────── */

/** A line is a blockquote line when its first non-space character is `>`. */
const BLOCKQUOTE_LINE = /^\s*>/;

/**
 * Drop GitHub reply-blockquotes, leaving only what this author actually wrote.
 *
 * This is the single highest-value function in the file. The spike's worst
 * failure in six runs was a Claim attributed to jordanbtucker at confidence
 * 0.98, citing two of *dhlolo's* messages — the quoted sentence appeared in them
 * only because dhlolo had reply-blockquoted jordanbtucker. Statement right,
 * claimant right, provenance overlap non-empty, receipt completely wrong. A
 * naive substring matcher scores it as a pass and it survives casual review.
 *
 * Nested quotes (`> > …`) go with it: they are quoting even harder.
 */
export function stripReplyBlockquotes(text: string): string {
  return text
    .split('\n')
    .filter((line) => !BLOCKQUOTE_LINE.test(line))
    .join('\n');
}

/** Only the blockquoted lines, with their `>` markers removed. */
export function replyBlockquotes(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (BLOCKQUOTE_LINE.test(line)) {
      current.push(line.replace(/^\s*>+\s?/, ''));
      continue;
    }
    if (line.trim() === '' && current.length > 0) continue;
    if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks.map((block) => block.trim()).filter((block) => block.length > 0);
}

/** True when the text contains at least one blockquote line. */
export function hasReplyBlockquote(text: string): boolean {
  return text.split('\n').some((line) => BLOCKQUOTE_LINE.test(line));
}

/**
 * **Is there anything here at all?** — the one emptiness test, used before every
 * required receipt input.
 *
 * r3's gauntlet, as a polish note that is really a principle: zero-width
 * characters were refused only *incidentally*. `"​"` is not `""`, so it
 * walked past every `trim()` check marked "required" and died three checks later
 * as not-found or too-short. The refusal was accidental, and an accidental
 * refusal is one code change away from an accidental acceptance.
 *
 * The fix is not a list of invisible characters — that list is unbounded in
 * exactly the way a stopword list is, and Unicode adds to it. It is the
 * complement: **content is a letter or a digit.** Everything else — spaces of
 * every width, zero-width joiners, format and control codes, unassigned code
 * points, lone combining marks, punctuation on its own — is absence, whether or
 * not anybody has enumerated it. A quote of `"…"`, a message body of `"​"`,
 * and `""` are the same fact about the world and get the same answer.
 */
const CONTENTFUL = /[\p{L}\p{N}]/u;

/** True when `text` carries at least one letter or digit. */
export function hasContent(text: string | null | undefined): boolean {
  return text !== null && text !== undefined && CONTENTFUL.test(text);
}

/** `hasContent`, negated — reads better at the gates, which are all refusals. */
export function isBlank(text: string | null | undefined): boolean {
  return !hasContent(text);
}

/**
 * Format and control characters, which render as nothing and must not survive
 * into a comparison. `\p{Cf}` covers U+200B–U+200F, U+2060–U+2064, U+00AD and
 * U+FEFF; `\p{Cc}` covers the C0/C1 controls. Whitespace of every width is
 * handled by `\s`, which in JavaScript already includes NBSP, the en/em spaces
 * and U+3000.
 */
const INVISIBLE = /[\p{Cf}\p{Cc}]/gu;

/**
 * Fold away the formatting both tiers drop when they quote.
 *
 * Markdown links collapse to their text, emphasis/code/strike markers vanish,
 * invisible characters are deleted, whitespace collapses, case folds. Measured
 * need, not defensiveness: three of the eight apparent provenance failures in the
 * spike were pure formatting artifacts — the model had dropped `**` or `[…](…)`
 * while quoting correctly — and without this the checker generates false failures
 * on correct output.
 *
 * The invisible-character step is r3's gauntlet: without it a zero-width space
 * spliced into a quote makes it a different string from the message it came out
 * of, so `"ship​ it"` is "not found" in a message that says `ship it`. That
 * is the right verdict for the wrong reason, and the wrong reason is the kind
 * that stops being right.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Ellipsis characters a model uses when it silently shortens a quote. */
const ELISION = /\.\.\.|…/;

/* ─────────────────────────────────────────────────────────────────────────
 * The four triggers
 * ───────────────────────────────────────────────────────────────────────── */

export interface EscalationMessage {
  id: string;
  authorId: string;
  body: string;
}

export type EscalationTriggerKind =
  /** Quotes an earlier message — every real dispute in both spike windows did. */
  | 'reply_blockquote'
  /** "you are right", "I was wrong", `s/x/y/` — the retraction chain. */
  | 'concession_marker'
  /** "@name will", "you should", "can you" — the third-party-commitment zone. */
  | 'named_person_future'
  /** Lexical overlap with an accepted Decision — the contradiction zone. */
  | 'accepted_decision_overlap';

export interface EscalationTrigger {
  kind: EscalationTriggerKind;
  /** The message that fired it. */
  messageId: string;
  /** The span that fired it, so a human can see why the money was spent. */
  evidence: string;
  /**
   * For `reply_blockquote`, the earlier message the quote was matched to, when
   * one was found in the supplied history. For `accepted_decision_overlap`, the
   * id of the decision it overlaps.
   */
  matched: string | null;
}

export interface EscalationConfig {
  /**
   * Shortest quoted span that counts as quoting something. Below this a `>` is
   * a shell prompt, a diff marker, or a one-word aside.
   *
   * The default is `RECEIPT_POLICY.minQuoteLength`, and it is the same number
   * for the same reason: the acceptance path enforces it too, and "how short is
   * too short to be quoting anything" cannot have two answers.
   */
  minQuoteLength: number;
  /** Fraction of a decision's content words a message must share to count. */
  decisionOverlapThreshold: number;
  /** …and at least this many of them, so a two-word decision cannot fire on one. */
  decisionOverlapMinTokens: number;
  /**
   * Characters of a message body the triggers will look at.
   *
   * A cost cap, routed out of r1's gauntlet. Every trigger normalizes text, and
   * normalization is linear in the body — so without a bound the work per window
   * is chosen by whoever writes the messages, and a 2 MB paste is a free way to
   * make the pre-model pass cost more than the model call it was meant to avoid.
   * The cap is far above any real message; the point is that it exists.
   */
  maxScanChars: number;
  /**
   * Earlier messages the blockquote matcher will scan, newest first. The match
   * is evidence, not a condition (see `triggersForMessage`), so giving up after
   * a bounded look-back costs a `matched` id and never a trigger.
   */
  maxHistoryScanned: number;
  /**
   * Accepted decisions compared against one message. Overlap is O(decisions),
   * and a room with a thousand accepted decisions must not turn every message
   * into a thousand comparisons.
   */
  maxComparedDecisions: number;
}

export const defaultEscalationConfig: EscalationConfig = Object.freeze({
  minQuoteLength: RECEIPT_POLICY.minQuoteLength,
  decisionOverlapThreshold: 0.5,
  decisionOverlapMinTokens: 3,
  maxScanChars: 20000,
  maxHistoryScanned: 200,
  maxComparedDecisions: 200,
});

/**
 * Concession and reversal markers.
 *
 * Drawn from the spike's list. `actually` is on it and is deliberately noisy —
 * it appears in ordinary technical prose constantly. That is the right trade
 * here and it is worth saying why: a false positive costs one call to a better
 * model, a false negative costs a missed retraction chain that then renders as
 * a live decision the room has already walked back. The asymmetry is not close.
 */
export const CONCESSION_MARKERS: readonly string[] = Object.freeze([
  'you are right',
  "you're right",
  'you were right',
  'i was wrong',
  "i'm wrong",
  'i am wrong',
  'i stand corrected',
  'my mistake',
  'my bad',
  'correction',
  'corrected',
  'actually',
  'never mind',
  'nevermind',
  'scratch that',
  'disregard that',
  'on second thought',
  'fair enough',
  'good point',
  'i take that back',
  'withdrawn',
]);

/**
 * `s/wrong/right/` — the terse form, which no word list catches.
 *
 * The closing slash is required and `s` must start a word, so a path (`docs/api/
 * v1/`) and a URL (`https://…`) cannot fire it: in both, the `s` is preceded by
 * a word character and `\b` fails.
 */
export const SED_CORRECTION = /\bs\/[^/\n]+\/[^/\n]*\//;

/**
 * Future-tense constructions aimed at a named person or at "you".
 *
 * This is the zone #4 spends most of its length on — third-party commitment
 * attribution, and the rule that nobody gets committed by someone else's
 * sentence — and it is the zone the spike's public-RFC corpus never exercised
 * once. Nobody on a TypeScript issue says "Ryan will handle it". The trigger is
 * built from the shape of the sentence rather than from corpus evidence, and
 * that is stated here rather than hidden: it is the one trigger not measured.
 */
export const FUTURE_PATTERNS: readonly RegExp[] = Object.freeze([
  /@[\w-]+\s+(?:will|should|can|could|needs? to|is going to|has to|must|please)\b/i,
  /\byou\s+(?:will|should|need to|needs to|ought to|have to|must|can|could)\b/i,
  /\b(?:can|could|would|will)\s+you\b/i,
  /@[\w-]+[,:]?\s+(?:please|take|handle|own|pick up)\b/i,
  /\bplease\s+(?:can|could|take|handle|own|pick up|review|land|ship)\b/i,
]);

/**
 * Words carrying no topic signal — dropped before overlap is measured.
 *
 * **This list decides which model reads a window. It has not decided whether a
 * reading becomes a fact since r4, and it must never do so again.** `not` is on
 * it, which is correct for routing — a negated sentence is about the same topic
 * as its affirmation, and that is the question `accepted_decision_overlap` and
 * `findDuplicate` ask. It was catastrophic for the receipt: r3 measured "does
 * this quote bear this sentence" with `lexicalOverlap`, so *"Bob will not deploy
 * production Friday"* scored 100% support for *"Bob will deploy production
 * Friday"*. The receipt now uses `statementBearing`, which has no stopword list
 * at all, because a similarity measure cannot be made into an entailment check by
 * curating its stopwords.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'have',
  'has',
  'had',
  'not',
  'but',
  'are',
  'was',
  'were',
  'will',
  'would',
  'should',
  'could',
  'can',
  'its',
  'it',
  'you',
  'your',
  'our',
  'their',
  'they',
  'them',
  'his',
  'her',
  'she',
  'him',
  'all',
  'any',
  'out',
  'get',
  'got',
  'let',
  'lets',
  'into',
  'onto',
  'than',
  'then',
  'there',
  'here',
  'what',
  'when',
  'which',
  'who',
  'why',
  'how',
  'been',
  'being',
  'does',
  'did',
  'done',
  'just',
  'also',
  'very',
  'more',
  'most',
  'some',
  'such',
  'only',
  'own',
  'same',
  'too',
  'about',
]);

/** Content words: normalized, ≥3 characters, not a stopword. Deduplicated. */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of normalizeForMatch(text).split(/[^a-z0-9']+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/**
 * How much of `statement`'s content the `text` reuses, 0..1.
 *
 * Containment relative to the statement, not Jaccard: a 400-word message that
 * restates a 9-word decision word for word is the case that must fire, and
 * Jaccard scores it near zero because the message is long.
 *
 * **A routing and dedup measure. Not a receipt check** — see `STOPWORDS`, and
 * `statementBearing` for the thing that replaced it there.
 */
export function lexicalOverlap(text: string, statement: string): number {
  return overlapOf(contentTokens(text), statement).overlap;
}

/** Content words shared between a message and a statement. */
export function sharedTokenCount(text: string, statement: string): number {
  return overlapOf(contentTokens(text), statement).shared;
}

/**
 * Both measures from one already-tokenized message.
 *
 * The message is tokenized once per call rather than once per decision: with
 * `n` accepted decisions the old shape re-normalized the whole body `2n` times,
 * which is the unbounded per-call cost r1's gauntlet flagged. Same numbers, one
 * pass over the text.
 */
function overlapOf(
  have: ReadonlySet<string>,
  statement: string,
): {
  overlap: number;
  shared: number;
} {
  const wanted = contentTokens(statement);
  let shared = 0;
  for (const token of wanted) if (have.has(token)) shared += 1;
  return { overlap: wanted.size === 0 ? 0 : shared / wanted.size, shared };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Does the quote bear the statement?
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Every word of a text, in the order it was written.
 *
 * Deliberately unlike `contentTokens` in all three ways that matter, and each
 * one is a defect r3's gauntlet exploited or could have:
 *
 *  - **No stopword list.** `not`, `all`, `some`, `will`, `might`, `unless` and
 *    every word nobody has thought of yet are content here. There is no list to
 *    get wrong because there is no list.
 *  - **No de-duplication.** "not not" is two tokens. A `Set` cannot tell double
 *    negation from single.
 *  - **No length floor.** `no` is two characters and inverts a sentence.
 *
 * Apostrophes are kept *inside* a word, so `won't` is one token and is not
 * `will`. An apostrophe at either edge is a quotation mark rather than a letter
 * — `'online'` is the word `online` — so it is trimmed, and a token that was
 * nothing but apostrophes disappears.
 */
export function orderedTokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(/[^a-z0-9']+/)
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .filter((token) => token.length > 0);
}

/**
 * What the bearing check found. **`borne` is the only affirmative answer** —
 * every other shape of this result is a refusal, and the two lists say which
 * refusal it is.
 */
export interface StatementBearing {
  /**
   * True only when the statement is the quote with nothing removed but
   * `RECEIPT_POLICY.droppableWords`, in the order it was written.
   */
  borne: boolean;
  /** Words the statement asserts that the quote does not contain, in order. */
  unmatchedInStatement: string[];
  /** Words the quote contains that the statement drops, in order. */
  unmatchedInQuote: string[];
  /** Set when the check declined to run at all, rather than running and failing. */
  undecidable: 'empty_quote' | 'empty_statement' | 'too_long' | null;
}

/**
 * **Is the asserted statement a word-for-word reduction of this quote?**
 *
 * ## What this proves, stated in the terms it actually holds
 *
 * `borne === true` means exactly one thing, and it is worth writing out because
 * the check it replaced claimed something it could not deliver:
 *
 * > Every word of the statement appears in the quote, in the same order, and
 * > every word of the quote appears in the statement, in the same order, except
 * > for the three articles in `RECEIPT_POLICY.droppableWords`.
 *
 * That is a **structural** claim about two strings. It is not entailment, and
 * nothing here can establish entailment — but combined with the checks around it
 * (the quote occurs verbatim in a cited message, outside any reply-blockquote,
 * written by exactly one identifiable author) it supports the sentence the
 * product actually needs to be able to say: *the sentence being asserted is one
 * somebody in this room wrote, in these words.*
 *
 * ## Why not the softer test
 *
 * r3 asked "how many of the statement's content words does the quote contain",
 * over a de-duplicated set, with `not` dropped as a stopword. The answer for
 * *"Bob will not deploy production Friday"* → *"Bob will deploy production
 * Friday"* was 100%, and that acceptance was automatic. Every softening of the
 * test above reopens it somewhere:
 *
 *  - A **set** cannot see order, so "A blocks B" and "B blocks A" are the same.
 *  - A **threshold** licenses dropping whatever falls under it, and one dropped
 *    word is all a negation needs.
 *  - A **stopword list** decides in advance which words cannot matter, which is
 *    the assumption that failed.
 *  - Checking only the **covering span** of the statement inside the quote misses
 *    the prefix ("I don't think ") and the suffix (" unless CI is red"), which is
 *    where a qualifier lives. So the *whole* quote must be accounted for.
 *
 * The cost is stated rather than hidden: a model reading that paraphrases —
 * expands a pronoun, fixes a tense, tightens the wording — is no longer
 * auto-acceptable. It is not destroyed; it goes to a person, which is where a
 * reading that is not in the record in these words belongs.
 *
 * ## The alignment
 *
 * Greedy, with a one-sided lookahead so a single extra word resynchronises
 * instead of scrambling the rest of the comparison. Deterministic, total, and
 * bounded by `RECEIPT_POLICY.maxAlignedTokens` — an input too big to align is
 * refused, not approximated.
 */
export function statementBearing(
  quote: string,
  statement: string,
  policy: ReceiptPolicy = RECEIPT_POLICY,
): StatementBearing {
  const empty = (undecidable: StatementBearing['undecidable']): StatementBearing => ({
    borne: false,
    unmatchedInStatement: [],
    unmatchedInQuote: [],
    undecidable,
  });

  if (isBlank(quote)) return empty('empty_quote');
  if (isBlank(statement)) return empty('empty_statement');

  const q = orderedTokens(quote);
  const s = orderedTokens(statement);
  if (q.length === 0) return empty('empty_quote');
  if (s.length === 0) return empty('empty_statement');
  if (q.length > policy.maxAlignedTokens || s.length > policy.maxAlignedTokens) {
    return empty('too_long');
  }

  const droppable = (token: string | undefined): boolean =>
    token !== undefined && policy.droppableWords.has(token);

  const unmatchedInQuote: string[] = [];
  const unmatchedInStatement: string[] = [];
  let i = 0;
  let j = 0;

  while (i < q.length && j < s.length) {
    const qt = q[i];
    const st = s[j];
    if (qt === st) {
      i += 1;
      j += 1;
      continue;
    }
    // An article on either side may be skipped silently — that is the entire
    // licence this check grants, and `droppableWords` says why.
    if (droppable(qt)) {
      i += 1;
      continue;
    }
    if (droppable(st)) {
      j += 1;
      continue;
    }
    // A real disagreement. Resynchronise towards whichever side can still be
    // matched, so one interposed word ("not") is reported as one interposed word
    // rather than knocking every later token out of alignment.
    if (st !== undefined && q.indexOf(st, i + 1) !== -1) {
      if (qt !== undefined) unmatchedInQuote.push(qt);
      i += 1;
    } else {
      if (st !== undefined) unmatchedInStatement.push(st);
      j += 1;
    }
  }

  // Whatever is left over on either side is unaccounted for — a trailing
  // "unless CI is red" is exactly this case, and it is why the tail is not
  // forgiven.
  for (; i < q.length; i += 1) {
    const token = q[i];
    if (!droppable(token) && token !== undefined) unmatchedInQuote.push(token);
  }
  for (; j < s.length; j += 1) {
    const token = s[j];
    if (!droppable(token) && token !== undefined) unmatchedInStatement.push(token);
  }

  return {
    borne: unmatchedInQuote.length === 0 && unmatchedInStatement.length === 0,
    unmatchedInStatement,
    unmatchedInQuote,
    undecidable: null,
  };
}

/** An accepted decision, as the trigger needs it: an id and its statement. */
export interface AcceptedDecisionRef {
  objectId: string;
  statement: string;
}

export interface EscalationWindow {
  /** The messages about to be interpreted, in room order. */
  messages: readonly EscalationMessage[];
  /**
   * Room messages *before* the window. A quote-reply usually points backwards
   * out of a 20-message window, so without these the blockquote trigger loses
   * exactly the chains it exists to catch.
   */
  priorMessages?: readonly EscalationMessage[];
  /**
   * Statements of the room's currently-accepted decisions. Note this is the
   * *only* place accepted state is used: per the spike, it is a trigger input
   * and a dedup input, and it is deliberately **not** in the extraction prompt
   * (supplying it there collapsed recall 19 → 11 objects and lost the dispute
   * edge entirely).
   */
  acceptedDecisions?: readonly AcceptedDecisionRef[];
}

export interface EscalationVerdict {
  /** Send this window to the stronger tier. */
  escalate: boolean;
  /** Every trigger that fired, in message order then kind order. */
  triggers: EscalationTrigger[];
  /** The distinct kinds that fired, sorted — the cheap thing to log. */
  kinds: EscalationTriggerKind[];
}

/**
 * Should this window go to the escalation tier?
 *
 * Any trigger escalates the **whole window**, not the message that fired: the
 * dispute is the chain, and handing the stronger model one message out of a
 * quote-reply argument is handing it the half that makes no sense.
 *
 * Deterministic and total: same window in, same verdict out, no clock, no
 * model, no randomness. Triggers come back in `(message order, kind order)` so
 * two callers logging them produce the same bytes.
 */
export function evaluateEscalation(
  window: EscalationWindow,
  config: EscalationConfig = defaultEscalationConfig,
): EscalationVerdict {
  const triggers: EscalationTrigger[] = [];
  const history: EscalationMessage[] = [...(window.priorMessages ?? [])];

  for (const message of window.messages) {
    for (const trigger of triggersForMessage(message, history, window.acceptedDecisions, config)) {
      triggers.push(trigger);
    }
    history.push(message);
  }

  const kinds = [...new Set(triggers.map((trigger) => trigger.kind))].sort();
  return { escalate: triggers.length > 0, triggers, kinds };
}

/**
 * The triggers one message fires, given what came before it.
 *
 * Exported because #23's worker wants per-message attribution for its logs, and
 * because it is the unit the tests table-drive.
 */
export function triggersForMessage(
  message: EscalationMessage,
  earlier: readonly EscalationMessage[] = [],
  acceptedDecisions: readonly AcceptedDecisionRef[] = [],
  config: EscalationConfig = defaultEscalationConfig,
): EscalationTrigger[] {
  const found: EscalationTrigger[] = [];
  // Every trigger below reads this, and nothing reads past it — see
  // `EscalationConfig.maxScanChars`.
  const body = message.body.slice(0, config.maxScanChars);

  // ── 1. reply-blockquote ──────────────────────────────────────────────────
  //
  // Fires on any substantive blockquote, and records *which* earlier message it
  // matched when it can find one. It does not require the match: a window is 20
  // messages and a quote-reply routinely points at message 3 of a 400-message
  // thread, so demanding a match would drop the chains this exists to catch.
  // The match is evidence for a human reading the log, not a condition.
  for (const quoted of replyBlockquotes(body)) {
    const normalized = normalizeForMatch(quoted);
    if (normalized.length < config.minQuoteLength) continue;
    found.push({
      kind: 'reply_blockquote',
      messageId: message.id,
      evidence: clip(quoted),
      matched: matchEarlier(normalized, earlier, config),
    });
    break; // One is enough to escalate; the rest are the same signal.
  }

  // Everything below reads only what this author wrote. A concession inside a
  // blockquote is somebody else's concession being quoted back at them, and the
  // trigger above has already fired on that message anyway.
  const own = stripReplyBlockquotes(body);
  const normalizedOwn = normalizeForMatch(own);

  // ── 2. concession markers ────────────────────────────────────────────────
  for (const marker of CONCESSION_MARKERS) {
    if (!containsPhrase(normalizedOwn, marker)) continue;
    found.push({
      kind: 'concession_marker',
      messageId: message.id,
      evidence: marker,
      matched: null,
    });
    break;
  }
  if (!found.some((trigger) => trigger.kind === 'concession_marker')) {
    const sed = SED_CORRECTION.exec(own);
    if (sed) {
      found.push({
        kind: 'concession_marker',
        messageId: message.id,
        evidence: sed[0],
        matched: null,
      });
    }
  }

  // ── 3. named-person future tense ─────────────────────────────────────────
  for (const pattern of FUTURE_PATTERNS) {
    const hit = pattern.exec(own);
    if (!hit) continue;
    found.push({
      kind: 'named_person_future',
      messageId: message.id,
      evidence: hit[0].trim(),
      matched: null,
    });
    break;
  }

  // ── 4. overlap with an accepted decision ─────────────────────────────────
  const ownTokens = contentTokens(own);
  const compared = acceptedDecisions.slice(0, config.maxComparedDecisions);
  for (const decision of compared) {
    const { overlap, shared } = overlapOf(ownTokens, decision.statement);
    if (overlap < config.decisionOverlapThreshold) continue;
    if (shared < config.decisionOverlapMinTokens) continue;
    found.push({
      kind: 'accepted_decision_overlap',
      messageId: message.id,
      evidence: clip(decision.statement),
      matched: decision.objectId,
    });
    break;
  }

  return found;
}

/** The earlier message a quote came from, or `null`. Bounded look-back. */
function matchEarlier(
  normalizedQuote: string,
  earlier: readonly EscalationMessage[],
  config: EscalationConfig,
): string | null {
  const stop = Math.max(0, earlier.length - config.maxHistoryScanned);
  for (let index = earlier.length - 1; index >= stop; index -= 1) {
    const candidate = earlier[index];
    if (!candidate) continue;
    if (normalizeForMatch(candidate.body.slice(0, config.maxScanChars)).includes(normalizedQuote)) {
      return candidate.id;
    }
  }
  return null;
}

/**
 * Phrase match on normalized text with word boundaries, so "correction" does
 * not fire on "corrections" — it does, and should, but "actually" must not fire
 * on "factually".
 */
function containsPhrase(normalized: string, phrase: string): boolean {
  const at = normalized.indexOf(phrase);
  if (at === -1) return false;
  const before = at === 0 ? ' ' : normalized[at - 1];
  const afterIndex = at + phrase.length;
  const after = afterIndex >= normalized.length ? ' ' : normalized[afterIndex];
  return !isWordChar(before) && !isWordChar(after);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}

function clip(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Proposal validation — the checks that run *after* the model call
 * ───────────────────────────────────────────────────────────────────────── */

/** A message as the provenance checker needs it. */
export interface ProvenanceMessage {
  id: string;
  authorId: string;
  body: string;
}

export type ProvenanceProblemKind =
  /** A model proposal citing nothing. Schema-blocked; checked again here. */
  | 'no_provenance'
  /** Cites a message id that is not in the window. */
  | 'unknown_message'
  /**
   * A model reading that puts a name on somebody and quotes nothing.
   *
   * Schema-blocked on `Proposal`, and checked again here because r2's gauntlet
   * found the schema was never reached: `appendEvent`/`reduce` folded whatever
   * object they were handed. A check that only runs one layer up is not a
   * check — this one runs inside the validator both the engine and the reducer
   * call.
   */
  | 'missing_quote'
  /** The quote is in no cited message at all. */
  | 'quote_not_found'
  /**
   * The quote is only in a cited message's *reply-blockquote* — text the cited
   * author did not write. The spike's worst error, at 0.98 confidence.
   */
  | 'quote_only_in_reply_blockquote'
  /** The quote was silently shortened with `…` and does not appear verbatim. */
  | 'elided_quote'
  /**
   * Too short to identify anything. "yes", "ok", "+1" occur in every thread, so
   * a citation resting on one is a citation to the conversation rather than to a
   * sentence.
   */
  | 'quote_too_short'
  /**
   * The quote is real and correctly attributed, and the sentence being minted
   * asserts words the quote does not contain. r2's gauntlet, major 1: cite Bob's
   * unrelated "yes", mint "Bob will deploy". Every other check passes on that.
   * Since r4 this also covers a quantifier or modal *substitution* — quote
   * "all services restart", mint "some services restart" — because `some` is a
   * word the quote does not carry.
   */
  | 'quote_does_not_bear_statement'
  /**
   * Every word of the statement is in the quote, in order, and the quote carries
   * more. r3's gauntlet: quote "Bob will **not** deploy production Friday", mint
   * "Bob will deploy production Friday". The dropped word may be decorative or it
   * may invert the sentence, and **nothing here can tell which** — so this is not
   * a verdict that the reading is wrong, it is a refusal to have an opinion, and
   * the reading goes to a person.
   */
  | 'quote_carries_more_than_statement'
  /**
   * The bearing check could not run: no quote, no statement, or an input too
   * large to align. Fails closed for the same reason every other missing input
   * does — an unchecked receipt is not a passed one.
   */
  | 'statement_uncheckable'
  /**
   * Two or more cited messages, by different people, contain the quote. Taking
   * the first in window order picks an author by accident, and the author is the
   * whole answer to "who said this".
   */
  | 'ambiguous_quote'
  /** A Claim's claimant / Commitment's owner authored none of the cited messages. */
  | 'attributed_person_not_author';

/**
 * What a problem *means*, which is not the same as what it is.
 *
 * The spike's third check reads: "for Claim/Commitment, require the
 * claimant/owner to be the author of at least one cited message, **or force
 * `attribution: third_party`**". That "or" is load-bearing and it splits by
 * type:
 *
 *  - On a **claim**, a claimant who wrote none of the cited messages is a
 *    *wrong receipt*. "X said Y" where X did not say it is the failure mode, and
 *    the reading is discarded.
 *  - On a **commitment**, the same finding is *the ordinary case #4 is about*:
 *    "Justin will handle it" is a real commitment, correctly extracted, that
 *    happens to be third-party. Discarding it would delete exactly the flow #4
 *    spends most of its length designing — the named owner never gets asked.
 *
 * So the finding is reported either way and its consequence is carried with it.
 */
export type ProvenanceSeverity =
  /** Demote below θ_min: the reading is wrong. */
  | 'reject'
  /**
   * **The check cannot judge this, so a person must.** Never auto-accepted, never
   * discarded: the reading stays staged, quietly, with its quote attached.
   *
   * The third severity exists because r4's bearing check has exactly one
   * affirmative answer and two different negative ones, and collapsing them would
   * repeat the mistake it was built to fix. "The statement says words that are not
   * in the quote" is a finding — the receipt points somewhere that does not say
   * this, and the reading is wrong. "The quote says more than the statement" is
   * *not* a finding: the dropped words may be an aside or may be `not`, and no
   * amount of string comparison distinguishes them. Reporting a guess as a verdict
   * in either direction is the class of error this whole file exists to refuse, so
   * the honest output is "I decline, here is the discrepancy, you look".
   */
  | 'refer'
  /** Keep the reading, treat it as third-party attribution. */
  | 'reclassify';

export interface ProvenanceProblem {
  kind: ProvenanceProblemKind;
  severity: ProvenanceSeverity;
  /** Human-readable, and specific enough to act on. */
  detail: string;
  /** The message involved, when one message is at fault. */
  messageId: string | null;
}

/** The slice of a proposal these checks read. */
export interface ProvenanceSubject {
  type: AcceptedObjectType;
  provenance: readonly string[];
  quote?: string | null;
  proposer?: { kind: 'model' | 'human' };
  /** `claimant` for a claim, `owner` for a commitment. */
  attributedTo?: string | null;
  /**
   * The sentence being asserted — `statement` / `question` / `title`, whichever
   * the type carries. Supplied so the quote can be checked against *what is
   * being minted* rather than only against the messages.
   *
   * Optional in the type because a human-staged subject has nothing to check.
   * **For a model subject its absence is a refusal, not a skip** — r3 let it be
   * "honest silence", which is the fail-open shape every round of this ticket has
   * found somewhere else: a check that does not run reads identically to a check
   * that passed. A model subject with no statement gets `statement_uncheckable`.
   * Every caller inside this package supplies it.
   */
  statement?: string | null;
}

/**
 * The three deterministic post-checks the spike specified, plus the two
 * structural ones they imply. Every one of these caught a real error in the
 * spike, and none of them needs a model.
 *
 * A proposal with any problem should be **demoted below θ_min** — discarded,
 * not surfaced (`acceptance.ts` does this when the problems are passed in). The
 * reasoning is the whole point of the receipt: a reading whose citation is
 * wrong is worse than no reading, because the citation is what a person clicks
 * to check it, and a wrong one survives casual review.
 */
export function validateProposalProvenance(
  subject: ProvenanceSubject,
  messages: readonly ProvenanceMessage[],
  policy: ReceiptPolicy = RECEIPT_POLICY,
): ProvenanceProblem[] {
  const problems: ProvenanceProblem[] = [];
  const byId = new Map(messages.map((message) => [message.id, message]));

  // The strictness below is aimed at *machine* readings. A person staging their
  // own reading is the receipt (#4) and is not asked to quote themselves, so the
  // checks that would demand a quote of them are scoped rather than universal.
  const fromModel = subject.proposer?.kind === 'model';

  if (subject.provenance.length === 0) {
    if (fromModel) {
      problems.push({
        kind: 'no_provenance',
        severity: 'reject',
        detail: 'a model proposal must cite at least one source message',
        messageId: null,
      });
    }
    return problems;
  }

  const cited: ProvenanceMessage[] = [];
  for (const id of subject.provenance) {
    const message = byId.get(id);
    if (!message) {
      problems.push({
        kind: 'unknown_message',
        severity: 'reject',
        detail: `cites message "${id}", which is not in the window`,
        messageId: id,
      });
      continue;
    }
    cited.push(message);
  }

  const quote = hasContent(subject.quote) ? (subject.quote as string).trim() : '';
  const normalizedQuote = normalizeForMatch(quote);

  // ── A model reading must quote the message it was read out of ────────────
  //
  // `Proposal` already refuses this at parse time. It is checked again here
  // because r2's gauntlet found the parse never happened: the reducer folded
  // whatever object it was handed, so the schema was a manner and not a
  // boundary. Both are fixed — `appendEvent`/`reduce` parse now — and this stays,
  // because "absent or empty required receipt input is a refusal" has to be true
  // in the layer that computes the receipt, not only in the layer above it.
  //
  // **Every model-minted type, since r4.** It used to be scoped to claims and
  // commitments, on the argument that those are the two that put a name on
  // somebody. r3's gauntlet walked through the gap: a model *objective* with
  // `quote: null`, citing one message whose body is `""`, passed every check
  // there was — the citation array was non-empty, so the window looked supplied,
  // and no quote meant no quote check ran. The receipt is not only about
  // attribution. It answers "which sentence, in which message" for every type,
  // and a type with no answer to that has no receipt at all.
  if (fromModel && normalizedQuote.length === 0) {
    problems.push({
      kind: 'missing_quote',
      severity: 'reject',
      detail: `a model ${subject.type} proposal must quote the message that carries it — with no quote nothing identifies which message this was read out of${subject.attributedTo ? ` or which one named "${subject.attributedTo}"` : ''}, and the honest reading of no answer is that nobody did`,
      messageId: null,
    });
  }

  /** The one cited message whose own words carry the quote, when there is one. */
  let bearing: ProvenanceMessage | null = null;
  /** Several cited authors carry it — nothing can be attributed. */
  let ambiguous = false;

  if (normalizedQuote.length > 0 && cited.length > 0) {
    const inFullText = cited.filter((message) =>
      normalizeForMatch(message.body).includes(normalizedQuote),
    );
    const inOwnText = bearingMessages(quote, cited);

    if (inOwnText.length === 0 && inFullText.length > 0) {
      // The nastiest class: the quote is real, the attribution is real, and the
      // receipt still points at a person who did not say it.
      problems.push({
        kind: 'quote_only_in_reply_blockquote',
        severity: 'reject',
        detail: `the quote appears in message "${inFullText[0]?.id}" only inside a reply-blockquote — its author was quoting someone else, so this citation attributes the words to the wrong person`,
        messageId: inFullText[0]?.id ?? null,
      });
    } else if (inFullText.length === 0) {
      problems.push(
        ELISION.test(quote)
          ? {
              kind: 'elided_quote',
              severity: 'reject',
              detail: `the quote was shortened with an ellipsis and does not appear verbatim in any cited message: "${clip(quote, 80)}"`,
              messageId: null,
            }
          : {
              kind: 'quote_not_found',
              severity: 'reject',
              detail: `the quote appears in none of the cited messages: "${clip(quote, 80)}"`,
              messageId: null,
            },
      );
    }

    // ── Which message bears it, and is that answerable at all ──────────────
    //
    // r2's gauntlet: "when several cited messages match, refuse as ambiguous
    // rather than picking the first in window order". Window order is an
    // accident of ingestion, and picking an author by accident is exactly the
    // failure the whole receipt exists to prevent.
    //
    // Several matches by *one* author is not that failure — "who wrote this" has
    // a single answer, and refusing a repeated sentence would fire on every
    // thread where somebody says the same thing twice. So the refusal is scoped
    // to the case where the answer is genuinely undetermined: more than one
    // author.
    const authors = new Set(inOwnText.map((message) => message.authorId));
    if (authors.size > 1) {
      ambiguous = true;
      problems.push({
        kind: 'ambiguous_quote',
        severity: 'reject',
        detail: `the quote appears in the own text of ${inOwnText.length} cited messages written by different people (${[
          ...authors,
        ]
          .sort()
          .map((author) => `"${author}"`)
          .join(
            ', ',
          )}) — nothing says which of them said it, and picking the first in window order would attribute it by accident`,
        messageId: null,
      });
    } else {
      bearing = inOwnText[0] ?? null;
    }

    // ── Long enough to be quoting something ───────────────────────────────
    if (fromModel && normalizedQuote.length < policy.minQuoteLength) {
      problems.push({
        kind: 'quote_too_short',
        severity: 'reject',
        detail: `the quote "${clip(quote, 40)}" is ${normalizedQuote.length} characters, below the ${policy.minQuoteLength} a receipt needs — a span that short occurs in any thread, so it identifies the conversation rather than the sentence`,
        messageId: bearing?.id ?? null,
      });
    }

    // ── …and actually carrying the sentence being minted ──────────────────
    //
    // The check r2's gauntlet asked for by name and r3's gauntlet found built out
    // of the wrong instrument. Everything above can pass on a quote that has
    // nothing to do with the payload — cite the message where Bob wrote "yes,
    // that works for me", quote it, mint "Bob will deploy on Friday" — and r3's
    // lexical-overlap answer to that passed something worse: a quote that says
    // the **opposite** of the payload. See `statementBearing`.
    if (fromModel) {
      const statement = subject.statement ?? '';
      const bearingResult = statementBearing(quote, statement, policy);
      if (bearingResult.undecidable !== null) {
        // Not "no problem found" — no check performed. The two are the same
        // shape in the code and opposite facts about the world, and every finding
        // in this campaign has been one of them wearing the other's clothes.
        problems.push({
          kind: 'statement_uncheckable',
          severity: 'reject',
          detail:
            bearingResult.undecidable === 'empty_statement'
              ? `the ${subject.type} asserts nothing that can be checked against its quote — with no statement there is no sentence for the receipt to bear, and an unchecked receipt is not a passed one`
              : bearingResult.undecidable === 'too_long'
                ? `the quote or the statement is longer than the ${policy.maxAlignedTokens} words this check will align, so it was not checked — an input too large to verify is refused rather than approximated`
                : 'the quote carries no words at all, so nothing could be checked against the statement',
          messageId: bearing?.id ?? null,
        });
      } else if (bearingResult.unmatchedInStatement.length > 0) {
        // The reading asserts words that are not in the record. This is a
        // verdict, not a hesitation: the citation leads a reader to a sentence
        // that does not say this.
        problems.push({
          kind: 'quote_does_not_bear_statement',
          severity: 'reject',
          detail: `"${clip(statement, 60)}" asserts ${bearingResult.unmatchedInStatement.map((token) => `"${token}"`).join(', ')}, which the quote does not say — the quoted span is from a cited message but it is not this sentence, so the citation leads a reader somewhere that does not say this`,
          messageId: bearing?.id ?? null,
        });
      } else if (bearingResult.unmatchedInQuote.length > 0) {
        // Every word of the statement is in the quote, in order, and the quote
        // says more. `not` is this case. So is `unless CI is red`. So is a
        // harmless "I think". The check declines rather than guessing.
        problems.push({
          kind: 'quote_carries_more_than_statement',
          severity: 'refer',
          detail: `the quote says ${bearingResult.unmatchedInQuote.map((token) => `"${token}"`).join(', ')} and "${clip(statement, 60)}" drops ${bearingResult.unmatchedInQuote.length === 1 ? 'it' : 'them'} — those words may be an aside or may reverse the sentence, and nothing here can tell which, so this reading is not accepted on a machine's word; a person has to read the quote`,
          messageId: bearing?.id ?? null,
        });
      }
    }
  }

  // #4's rule, mechanized: nobody gets committed — or quoted — by someone
  // else's sentence.
  //
  // **Bound to the message bearing the sentence, not to the citation list.**
  // r1's gauntlet: "self-stated if the owner authored *any* cited message —
  // padding provenance flips attribution". It does. Cite one message the owner
  // wrote about anything at all, next to the message where somebody else
  // committed them, and the old check read the pair as a self-statement and
  // auto-accepted an obligation nobody agreed to. The quote identifies which
  // message carries the sentence; that message's author is the only one whose
  // authorship means anything here.
  //
  // **The citation-list fallback is gone for machine readings.** r2 kept it on
  // the argument that it "can only be more likely to report a problem, never
  // less", and that was wrong in one direction r2's gauntlet found: with an
  // *empty* quote none of the quote checks above run, no bearing message is
  // computed, and the fallback reads "somebody in the citation list wrote
  // something" as support — the padding attack, reopened through the empty
  // string. A model reading with no determinable bearing message is unsupported,
  // full stop. A human's still falls back, because a person staging a reading is
  // not quoting anyone.
  const attributed = subject.attributedTo;
  const namesAPerson = subject.type === 'claim' || subject.type === 'commitment';
  if (attributed && cited.length > 0 && namesAPerson) {
    const supported = bearing
      ? bearing.authorId === attributed
      : fromModel
        ? false
        : cited.some((message) => message.authorId === attributed);
    if (!supported) {
      const claim = subject.type === 'claim';
      const where = bearing
        ? `the message bearing it ("${bearing.id}") was written by "${bearing.authorId}"`
        : ambiguous
          ? 'more than one cited author carries the quote, so no message can be said to bear it'
          : fromModel
            ? 'no cited message bears the quote, so nothing identifies the message that named them'
            : `authored none of the cited messages (${cited.map((message) => `"${message.authorId}"`).join(', ')})`;
      problems.push({
        kind: 'attributed_person_not_author',
        // The split the spike's "or force `attribution: third_party`" implies.
        // A claim whose claimant said nothing is a wrong receipt; a commitment
        // whose owner said nothing is the third-party case #4 is entirely about,
        // and discarding it would delete the confirm flow rather than trigger it.
        severity: claim ? 'reject' : 'reclassify',
        detail: claim
          ? `claimant "${attributed}" ${where} — the receipt does not support "X said Y"`
          : `owner "${attributed}" ${where} — this is third-party attribution, not a self-statement, so it needs their confirm`,
        messageId: bearing?.id ?? null,
      });
    }
  }

  return problems;
}

/**
 * Every cited message whose *own* text carries a quoted span — reply-blockquotes
 * stripped, so a message that merely quoted the sentence back does not count.
 *
 * Returns all of them rather than the first, because "how many" is the question
 * `ambiguous_quote` asks and a function that returns one answer cannot be asked
 * it.
 */
export function bearingMessages(
  quote: string,
  messages: readonly ProvenanceMessage[],
): ProvenanceMessage[] {
  const normalized = normalizeForMatch(quote);
  if (normalized.length === 0) return [];
  return messages.filter((message) =>
    normalizeForMatch(stripReplyBlockquotes(message.body)).includes(normalized),
  );
}

/**
 * The cited message that actually carries a quoted span, when exactly one person
 * can be said to have written it.
 *
 * This is the function that makes attribution answerable. "Did the owner say
 * this?" is a question about one message, and every version of it that ranges
 * over the citation list instead is answerable by padding the list.
 *
 * `null` covers three cases that all mean the same thing here — no cited message
 * carries it, the quote is empty, or several *different authors* carry it. All
 * three leave "who said this" undetermined, and an undetermined author is not a
 * cheaper kind of answer: `commitmentAttribution` reads `null` as third-party and
 * `validateProposalProvenance` reports it.
 */
export function bearingMessage(
  quote: string,
  messages: readonly ProvenanceMessage[],
): ProvenanceMessage | null {
  const borne = bearingMessages(quote, messages);
  if (borne.length === 0) return null;
  const authors = new Set(borne.map((message) => message.authorId));
  return authors.size === 1 ? (borne[0] ?? null) : null;
}

/** True when nothing is wrong with the receipt. */
export function provenanceIsClean(problems: readonly ProvenanceProblem[]): boolean {
  return problems.length === 0;
}

/** The problems that mean "throw this reading away". */
export function rejectingProblems(problems: readonly ProvenanceProblem[]): ProvenanceProblem[] {
  return problems.filter((problem) => problem.severity === 'reject');
}

/** The problems that mean "a person has to look at this before it counts". */
export function referringProblems(problems: readonly ProvenanceProblem[]): ProvenanceProblem[] {
  return problems.filter((problem) => problem.severity === 'refer');
}

/**
 * Every problem that stops a machine accepting the reading — `reject` **and**
 * `refer`, and not `reclassify`, which is a route rather than a refusal.
 *
 * This exists so a caller cannot add a severity and quietly fail open by
 * filtering for the one it remembers. Anything that is not explicitly a route is
 * a block.
 */
export function blockingProblems(problems: readonly ProvenanceProblem[]): ProvenanceProblem[] {
  return problems.filter((problem) => problem.severity !== 'reclassify');
}
