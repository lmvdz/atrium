import {
  alignTokens,
  hasContent,
  isAssertion,
  isBlank,
  LINE_BREAK,
  normalizeForReceipt,
  normalizeForRouting,
  quoteCoversOwnText,
  quoteSpansWholeSentences,
  routingTokens,
  sentencesOf,
  statementBearing,
} from './matching.js';
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
 * Whose words are these?
 *
 * The text policy itself lives in `matching.ts` since r5, split into the two
 * questions it was answering with one function: **which model reads this
 * window** (lossy on purpose) and **is this quote that message** (an allowlist
 * of the differences a quote may have). Everything below reads one or the other
 * and never both, and every call site says which.
 * ───────────────────────────────────────────────────────────────────────── */

/** A line is a blockquote line when its first non-space character is `>`. */
const BLOCKQUOTE_LINE = /^\s*>/;

/**
 * A body cut into lines.
 *
 * `split('\n')` until r6, which is the same defect `matching.ts` found in `\s`
 * one function over: U+0085 NEL, U+2028 and U+2029 end a line everywhere a line
 * is rendered and `\n` sees none of them, so a body whose breaks are NEL is one
 * line — and a reply-blockquote on its first line then swallows the author's own
 * words with it. That failed closed (the author's own text came back empty, so
 * nothing bore the quote), which is why it survived; a refusal for a reason
 * nobody wrote down is one refactor from an acceptance for the same reason.
 * `matching.LINE_BREAK` is the one answer to where a line ends.
 */
const lines = (text: string): string[] => text.split(LINE_BREAK);

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
  return lines(text)
    .filter((line) => !BLOCKQUOTE_LINE.test(line))
    .join('\n');
}

/** Only the blockquoted lines, with their `>` markers removed. */
export function replyBlockquotes(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines(text)) {
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
  return lines(text).some((line) => BLOCKQUOTE_LINE.test(line));
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
 * The subset of the markers above that **perform a retraction** rather than
 * merely sounding like agreement.
 *
 * Two lists because they answer two questions with opposite risk profiles, and
 * `CONCESSION_MARKERS` says why it is deliberately noisy: it decides which model
 * reads a window, so `actually`, `fair enough` and `good point` earn their false
 * positives at the price of one model call. This subset is read on the
 * **acceptance** path, where a hit means "a person looks at this" — so it holds
 * only the phrases whose utterance *is* the withdrawal. "Good point" concedes
 * something; "scratch that" takes something back.
 *
 * This is the one marker list in the package that touches acceptance, and the
 * direction it can be wrong in is the whole justification: it can only add a
 * referral. It never accepts anything and never discards anything, so no entry
 * here can turn a reading into a fact — which is the property `STOPWORDS` lost
 * when `findDuplicate` discarded on it (see `acceptance.ts`).
 */
export const RETRACTION_MARKERS: readonly string[] = Object.freeze([
  'i was wrong',
  "i'm wrong",
  'i am wrong',
  'i stand corrected',
  'correction',
  'corrected',
  'never mind',
  'nevermind',
  'scratch that',
  'disregard that',
  'i take that back',
  'withdrawn',
]);

/**
 * `s/wrong/right/` — the terse form, which no word list catches.
 *
 * The closing slash is required and `s` must start a word.
 *
 * **It fires on some URLs, and the comment here used to say it could not.** The
 * old claim was that in `https://…` and `docs/api/v1/` the `s` is preceded by a
 * word character so `\b` fails. That is true of the `s` in `https` and says
 * nothing about a *path segment* named `s`: `https://x.example/s/abc/def/` has
 * an `s` preceded by `/`, which is a word boundary, and it matches. So does any
 * `…/s/…/…/` path.
 *
 * The disposition is unchanged and the residue is stated rather than fixed,
 * because this marker is admissible **only** on the direction it can be wrong
 * in: a hit adds a `refer` and can never add an acceptance, so a URL that reads
 * as a retraction costs one person one glance. Narrowing the pattern to exclude
 * URLs would be a denylist of the URL shapes somebody has thought of, which is
 * the move this package has now paid for three times. What is fixed is the
 * comment: a stated limit that is false is worse than no stated limit, because
 * the next reader builds on it.
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
  for (const raw of normalizeForRouting(text).split(/[^a-z0-9']+/)) {
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
    const normalized = normalizeForRouting(quoted);
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
  const normalizedOwn = normalizeForRouting(own);

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
    if (
      normalizeForRouting(candidate.body.slice(0, config.maxScanChars)).includes(normalizedQuote)
    ) {
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

/**
 * One token, as a refusal should show it.
 *
 * r6 made `orderedTokens` exhaustive, so a token can now be a character with no
 * glyph — a C0 control, a bidi override, a soft hyphen. Interpolating one raw
 * produces a refusal that reads `the quote says ""` and tells a reader nothing,
 * which is a receipt failing to say what it found: the same class of defect as a
 * check that does not run, one layer out into the prose. Anything without a
 * rendering is named by its code point instead.
 */
function token(value: string): string {
  const printable = /^[\p{L}\p{N}\p{M}\p{P}\p{S}]+$/u.test(value);
  if (printable) return `"${value}"`;
  return [...value]
    .map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join('+');
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

/**
 * **Every way a receipt can be wrong, or unjudgeable — as data.**
 *
 * A `const` tuple rather than a bare union, because r4's blind review found the
 * shape this closes: `acceptance.test.ts` carried a test titled "reaches every
 * rule name the type declares" whose supposedly complete list *omitted* a rule,
 * so the test passed while the engine behaviour it named could have been
 * deleted. A restated list only catches removals; a derived one only catches
 * additions. Deriving the type from the data catches both, because the list and
 * the type are then the same object and a test can iterate it.
 *
 * What each kind means:
 *
 *  - `no_provenance` — a model proposal citing nothing. Schema-blocked on
 *    `Proposal`, and checked again here because r2's gauntlet found the schema
 *    was never reached: `appendEvent`/`reduce` folded whatever object they were
 *    handed. A check that only runs one layer up is not a check.
 *  - `unknown_message` — cites a message id that is not in the window.
 *  - `missing_quote` — a model reading that quotes nothing. r3's gauntlet minted
 *    a model *objective* with `quote: null` through the version of this that was
 *    scoped to claims and commitments; it covers every model-minted type now.
 *  - `quote_not_found` — the quote is in no cited message at all.
 *  - `quote_only_in_reply_blockquote` — the quote is only in a cited message's
 *    reply-blockquote, text the cited author did not write. The spike's worst
 *    error, at 0.98 confidence.
 *  - `elided_quote` — silently shortened with `…`, and not verbatim anywhere.
 *  - `quote_too_short` — "yes", "ok", "+1" occur in every thread, so a citation
 *    resting on one identifies the conversation rather than the sentence.
 *  - `quote_does_not_bear_statement` — the sentence being minted asserts words
 *    the quote does not contain. r2's gauntlet, major 1: cite Bob's unrelated
 *    "yes", mint "Bob will deploy". Since r4 it also covers a quantifier or
 *    modal *substitution* — quote "all services restart", mint "some services
 *    restart".
 *  - `quote_carries_more_than_statement` — every word of the statement is in the
 *    quote, in order, and the quote says more. r3's gauntlet: quote "Bob will
 *    **not** deploy production Friday", mint the affirmative. The dropped word
 *    may be decorative or it may invert the sentence, and nothing here can tell
 *    which.
 *  - `statement_respaces_the_quote` — **r6.** The two texts hold the same marks
 *    in the same order and space them differently, so the statement is not the
 *    text in the message. Stated as the fact rather than as a list of the ways
 *    it can arise, because two drafts of this entry tried the list and a brute
 *    force broke both. `normalizeForReceipt` has passed code segments through
 *    byte for byte since r5 on the argument that "two spaces in a password are a
 *    different password", and nothing at the comparison consulted it, because
 *    the tokenizer threw the spaces away: ``Run `rm -rf / tmp/cache` …`` bore
 *    ``Run `rm -rf /tmp/cache` …`` and auto-accepted.
 *  - `quote_is_a_fragment` — a span cut out of the middle of a sentence rather
 *    than a run of whole ones. r4's own blind review.
 *  - `quote_omits_surrounding_text` — **r5.** The quote is whole sentences and
 *    the author wrote more around them, so a neighbouring sentence this check
 *    cannot read may change the force of the quoted one ("We will deploy
 *    production Friday. Not."). r4 documented this as a residue it could not
 *    see and auto-accepted it anyway; see `quoteCoversOwnText`.
 *  - `superseded_by_later_message` — **r5.** A message later in the same window
 *    restates the sentence with something added ("Correction: we will **not** …")
 *    and the proposal cites only the earlier one. Append-only storage prevents
 *    an edit; it does not make a correction part of acceptance.
 *  - `statement_is_not_an_assertion` — **r5.** The sentence carries a question
 *    mark and is being minted as something other than an open question. A
 *    question quoted verbatim is an OpenQuestion or a referral, never a Claim.
 *  - `statement_uncheckable` — the bearing check could not run: no quote, no
 *    statement, or an input too large to align. Fails closed, because an
 *    unchecked receipt is not a passed one — and **the two cases are not the
 *    same severity since r6.** An empty quote or an empty statement is a
 *    malformed reading and is rejected. An input too large to align is an
 *    ordinary long message that nothing has judged, and `refer` is defined as
 *    *"the check cannot judge this, so a person must — never auto-accepted,
 *    never discarded"*. r5 rejected it, so a 421-token design comment, quoted
 *    whole and correctly attributed, was **destroyed**, and the room was told its
 *    citation had failed when it had not.
 *  - `ambiguous_quote` — two or more cited messages, by different people,
 *    contain the quote. Taking the first in window order picks an author by
 *    accident, and the author is the whole answer to "who said this".
 *  - `attributed_person_not_author` — a Claim's claimant or a Commitment's owner
 *    did not write the message bearing the quote.
 */
export const PROVENANCE_PROBLEM_KINDS = [
  'no_provenance',
  'unknown_message',
  'missing_quote',
  'quote_not_found',
  'quote_only_in_reply_blockquote',
  'elided_quote',
  'quote_too_short',
  'quote_does_not_bear_statement',
  'quote_carries_more_than_statement',
  'statement_respaces_the_quote',
  'quote_is_a_fragment',
  'quote_omits_surrounding_text',
  'superseded_by_later_message',
  'statement_is_not_an_assertion',
  'statement_uncheckable',
  'ambiguous_quote',
  'attributed_person_not_author',
] as const;

export type ProvenanceProblemKind = (typeof PROVENANCE_PROBLEM_KINDS)[number];

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
  const normalizedQuote = normalizeForReceipt(quote);

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
      normalizeForReceipt(message.body).includes(normalizedQuote),
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

    // ── …and cut at the sentence, not wherever the model liked ────────────
    //
    // r4's own blind review. A model that chooses the span can leave the
    // inverter outside it — "It is not true that Bob will deploy production
    // Friday", quoted from "Bob" onwards — and every check in this file, the
    // strict bearing comparison included, passes on the result. See
    // `quoteSpansWholeSentences`. `refer` rather than `reject`: a fragment may be
    // a perfectly fair quotation, and nothing here can read the rest of the
    // sentence to find out, which is the definition of the third severity.
    if (fromModel && bearing) {
      const ownText = stripReplyBlockquotes(bearing.body);
      if (!quoteSpansWholeSentences(quote, ownText, policy)) {
        problems.push({
          kind: 'quote_is_a_fragment',
          severity: 'refer',
          detail: `the quote is a span cut out of the middle of a sentence in message "${bearing.id}" rather than one or more whole sentences of it — the words on either side of the cut may qualify or reverse it ("it is not true that …"), and nothing here can read them, so this reading is not accepted on a machine's word`,
          messageId: bearing.id,
        });
      } else if (!quoteCoversOwnText(quote, bearing.body, policy)) {
        // ── …and the sentences either side of it are not somebody's scissors ──
        //
        // r5, and it is r4's own documented residue turned into a disposition.
        // r4 wrote: *"polarity that lives in a different sentence ('I will deploy
        // Friday. Not.') is not visible to this and is not visible to any span
        // rule"*. True, correct about the mechanism, and the code auto-accepted
        // the sentence anyway — while the same round built the third severity
        // that exactly fits it. A stated limit is not a disposition.
        //
        // The rule is "the quote is everything this author wrote here", not a
        // list of the constructions a neighbour might use, because that list is
        // unbounded in the way `RETRO.md` has now recorded three times. See
        // `quoteCoversOwnText` for the candidates that were tried and what broke
        // each of them.
        problems.push({
          kind: 'quote_omits_surrounding_text',
          severity: 'refer',
          detail: `the quote is whole sentences of message "${bearing.id}" but not the whole of it — there is more in that message, and a neighbouring line can reverse, condition or withdraw the one being quoted ("… Not.", "Unless CI is red.", "Correction: …") in a way no rule about the quoted span can see, so this reading is not accepted on a machine's word`,
          messageId: bearing.id,
        });
      }
    }

    // ── …and nobody in the window has taken it back since ──────────────────
    //
    // r5. `ProvenanceMessage` carries `id`, `authorId` and `body`, and until now
    // this function constructed and inspected only the *cited* messages — so a
    // window holding "We will deploy production Friday." followed by
    // "Correction: we will not deploy production Friday.", citing only the
    // first, was a clean receipt. The message table being append-only stops the
    // first message being edited; it does not make the second part of
    // acceptance.
    //
    // Deliberately not a marker list ("correction", "actually", `s/x/y/`) —
    // those route which model reads a window and have no business deciding
    // whether a reading becomes a fact. The test is structural and reuses the
    // alignment: a later message **restates the statement and adds to it**. That
    // catches the inserted `not`, the added `unless`, and the retraction verb,
    // without an opinion about which words are dangerous. An exact restatement
    // is not a correction and a message about something else does not align at
    // all.
    if (fromModel && cited.length > 0) {
      const revisited = laterRevision(
        subject.statement ?? '',
        subject.provenance,
        messages,
        policy,
      );
      if (revisited.kind === 'unscanned') {
        problems.push({
          kind: 'superseded_by_later_message',
          severity: 'refer',
          detail:
            revisited.why === 'window_is_only_the_citations'
              ? `the window supplied is nothing but the ${cited.length} message${cited.length === 1 ? '' : 's'} this proposal cites, so the correction scan had nothing to read that the proposal did not choose — whether a later message takes the quoted sentence back was never established, and a window the proposal selects is not a window (see \`AcceptanceContext.messages\`)`
              : `the window carries more after this citation than this check will read (${policy.maxLaterMessagesScanned} messages, ${policy.maxScannedSentences} sentences each, ${policy.maxAlignedTokens} tokens a sentence), so whether one of them corrects the quoted sentence was never established — an unread window is not a clean one, and a check that declined to run is not a check that passed`,
          messageId: null,
        });
      } else if (revisited.kind === 'revision') {
        problems.push({
          kind: 'superseded_by_later_message',
          severity: 'refer',
          detail: `message "${revisited.message.id}" comes after the messages this cites and carries ${revisited.added.map(token).join(', ')} — a later message restates the quoted sentence with something changed, takes something back, or is the same author returning to this subject, and whether that reverses this reading, narrows it or leaves it alone is not something a machine may decide from the words`,
          messageId: revisited.message.id,
        });
      }
    }

    // ── …and it is being offered as an assertion at all ────────────────────
    //
    // r5. `objects.ts` requires a nonempty string and the receipt proves string
    // equality, so `"Would we deploy production Friday?"` minted as a `claim`
    // with an identical quote had a perfect receipt and turned somebody's
    // question into their position. `RECEIPT_POLICY.droppableTokens` already
    // makes this argument in the other direction — `?` is kept out of the set
    // the bearing check will forgive because "Bob will deploy Friday?" is a
    // question and minting it as an assertion is the same defect in different
    // clothes. Here the mark is read rather than compared.
    if (fromModel && subject.type !== 'open_question' && !isAssertion(subject.statement ?? '')) {
      problems.push({
        kind: 'statement_is_not_an_assertion',
        severity: 'refer',
        detail: `the ${subject.type} being minted carries a question mark — a question quoted verbatim is an open question or a referral, never an assertion about what somebody holds, and nothing here can tell a rhetorical question from a real one`,
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
      const where = bearing?.id ?? null;
      if (bearingResult.undecidable !== null) {
        // Not "no problem found" — no check performed. The two are the same
        // shape in the code and opposite facts about the world, and every finding
        // in this campaign has been one of them wearing the other's clothes.
        //
        // **Two severities, since r6.** `empty_quote` and `empty_statement` are
        // malformed readings: there is no sentence, so there is nothing a person
        // could be shown either. `too_long` is an ordinary long message that
        // nothing has judged — `refer` is defined as "the check cannot judge
        // this, so a person must; never auto-accepted, **never discarded**", and
        // r5 rejected it, which `acceptance.ts` turns into `discard`. A 421-token
        // design comment, quoted whole and correctly attributed, was destroyed,
        // and the reason shown to the room said its citation had failed when it
        // had not. The sibling condition — `laterRevision` returning `unscanned`,
        // which is the same "could not read it all" fact — has been `refer` since
        // r5; both fired on that input and the reject won.
        const tooLong = bearingResult.undecidable === 'too_long';
        problems.push({
          kind: 'statement_uncheckable',
          severity: tooLong ? 'refer' : 'reject',
          detail:
            bearingResult.undecidable === 'empty_statement'
              ? `the ${subject.type} asserts nothing that can be checked against its quote — with no statement there is no sentence for the receipt to bear, and an unchecked receipt is not a passed one`
              : tooLong
                ? `the quote or the statement runs past the ${policy.maxAlignedTokens} tokens this check will align, so it was never checked — not accepted on a machine's word, and not thrown away either: a person can read a long message, and this one may be perfectly quoted`
                : 'the quote carries no words at all, so nothing could be checked against the statement',
          messageId: where,
        });
      } else if (!bearingResult.borne) {
        // **Branching on `borne` and then naming every way it can be false.**
        // r6: the three fields below used to be read directly, so a result that
        // was not borne for a reason none of the first two named produced *no
        // problem at all* — a check that ran, failed, and reported nothing. The
        // shape is the one this whole ticket keeps finding, and the fix is not to
        // enumerate more carefully but to make the enumeration structural: the
        // outer condition is the refusal, and the branches only decide what it
        // says. The final `else` is unreachable by `alignTokens`' own invariant
        // and is written out anyway, because "unreachable" is a claim about code
        // that changes.
        if (bearingResult.unmatchedInStatement.length > 0) {
          // The reading asserts words that are not in the record. This is a
          // verdict, not a hesitation: the citation leads a reader to a sentence
          // that does not say this.
          problems.push({
            kind: 'quote_does_not_bear_statement',
            severity: 'reject',
            detail: `"${clip(statement, 60)}" asserts ${bearingResult.unmatchedInStatement.map(token).join(', ')}, which the quote does not say — the quoted span is from a cited message but it is not this sentence, so the citation leads a reader somewhere that does not say this`,
            messageId: where,
          });
        } else if (bearingResult.unmatchedInQuote.length > 0) {
          // Every word of the statement is in the quote, in order, and the quote
          // says more. `not` is this case. So is `unless CI is red`. So is a
          // harmless "I think". The check declines rather than guessing.
          problems.push({
            kind: 'quote_carries_more_than_statement',
            severity: 'refer',
            detail: `the quote says ${bearingResult.unmatchedInQuote.map(token).join(', ')} and "${clip(statement, 60)}" drops ${bearingResult.unmatchedInQuote.length === 1 ? 'it' : 'them'} — those words may be an aside or may reverse the sentence, and nothing here can tell which, so this reading is not accepted on a machine's word; a person has to read the quote`,
            messageId: where,
          });
        } else if (bearingResult.whitespaceDiffers) {
          // Same marks, same order, different spacing.
          //
          // **The refusal names the fact and not the cause, and two of this
          // round's own adversarial passes are why.** The first draft said the
          // difference could only be inside a code span; a brute force over
          // generated pairs produced 21,344 counterexamples in plain prose. The
          // second draft named two causes — a code literal, and a droppable full
          // stop standing where the other side has a space; the next pass
          // produced a third (`wa 'z` against `wa' z`, a space and a mark
          // trading places) and there is no reason to think it is the last. A
          // list of the ways a thing can happen is the instrument `RETRO.md` has
          // now recorded four times, and it does not stop being one for being
          // written in prose. What is true of every case is the sentence above.
          //
          // `reject` and not `refer`: this is a verdict, not a hesitation. The
          // statement carries a text its author did not write, and no reading of
          // the neighbouring words can make it the one that is in the message.
          problems.push({
            kind: 'statement_respaces_the_quote',
            severity: 'reject',
            detail: `"${clip(statement, 60)}" holds every mark of the quote in the same order and spaces them differently, so it is not the text that is in the message — for instance a code literal respaced (\`rm -rf / tmp/cache\` is not \`rm -rf /tmp/cache\`), or a space standing where the quote ends a sentence`,
            messageId: where,
          });
        } else {
          problems.push({
            kind: 'statement_uncheckable',
            severity: 'reject',
            detail: `the bearing check refused "${clip(statement, 60)}" against its quote and named no difference — that is a contradiction in this package, not a finding about the reading, and an answer nothing can explain is not an answer a machine may act on`,
            messageId: where,
          });
        }
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
 * What the later-correction scan found — **a tagged union, and `RETRO.md` is
 * why**: "validate a union by its tag, not by key presence".
 *
 * Until r6 this was `{…} | 'unscanned' | null`, and every caller distinguished
 * the three by truthiness. Three states told apart by falsiness is two states
 * one refactor away from being one, and the two that must never merge here are
 * *nothing corrects this* and *nothing read the window*.
 */
export type LaterRevision =
  /** A later message restates the sentence with something changed. */
  | { kind: 'revision'; message: ProvenanceMessage; added: string[] }
  /**
   * The scan declined. `why` is reported to the room, because "we did not check"
   * and "we checked and it was fine" must not read alike.
   */
  | {
      kind: 'unscanned';
      why:
        | 'statement_too_long'
        | 'window_is_only_the_citations'
        | 'too_many_messages'
        | 'too_many_sentences'
        | 'too_many_tokens_in_a_sentence';
    }
  /**
   * The scan ran to the end of the window and found nothing.
   *
   * `scannedAfterCitations` records **how far it read** — the count nothing kept
   * before r6, which is half of why a truncated window was invisible.
   */
  | { kind: 'none'; scannedAfterCitations: number };

const revision = (message: ProvenanceMessage, added: string[]): LaterRevision => ({
  kind: 'revision',
  message,
  added,
});
const unscanned = (why: Extract<LaterRevision, { kind: 'unscanned' }>['why']): LaterRevision => ({
  kind: 'unscanned',
  why,
});
const scanned = (scannedAfterCitations: number): LaterRevision => ({
  kind: 'none',
  scannedAfterCitations,
});

/**
 * **Does a message later in this window say the quoted sentence again, with
 * something added?**
 *
 * "Later" is positional: after every message the proposal cites. `EscalationWindow`
 * documents its messages as being in room order, and the acceptance path is
 * handed the same window, so position is the ordering the room itself has.
 * Messages the proposal cites are not later than themselves, and a message
 * *before* the citations is not a revision of them.
 *
 * The comparison runs over **routing** tokens rather than receipt tokens, and
 * that is the one place on the receipt path where the lossy fold is correct: this
 * is a detector, not a certification. A false positive costs a referral — a
 * person reads two sentences — and a false negative costs an auto-accepted
 * statement the room has already walked back. Case, fullwidth spellings and
 * markdown are all noise to that question.
 *
 * Returns the tokens the later message added, because a refusal that does not
 * say what changed is a dead end.
 *
 * ## The window is the contract, and r6 made it one
 *
 * This scan reads `messages` and nothing else. Until r6 nothing said how far
 * that had to reach and nothing checked, so the *natural* caller — one that
 * supplies "the messages this receipt cites", which is what
 * `commitmentAttribution` does one function over — turned the whole check off in
 * silence:
 *
 * | window                | verdict                    |
 * | --------------------- | -------------------------- |
 * | the whole room        | `receipt_not_certifiable`  |
 * | the cited messages    | `auto_accept`              |
 *
 * That is r2's and r3's fail-open (`messages: []`, `[{ body: '' }]`) one level
 * out: absence and emptiness were made one fact and **truncation was left
 * invisible**. The contract is now written on `AcceptanceContext.messages` and
 * `TrustedContextInput.messages` — *the room's window in room order, continuing
 * past the citations* — and the half of it that is observable from in here is
 * enforced: **a window holding nothing but the messages the proposal cites is
 * `unscanned`**, because the proposal chose every message the check was allowed
 * to read, and a boundary the proposal controls is the shape of every padding
 * attack this file has been through.
 *
 * What that check cannot see is a window that is truncated but not *only* the
 * citations — **any** message the proposal did not cite satisfies it, including
 * one that sits before the sentence and can therefore never be a correction of
 * it. Core cannot distinguish a truncated window from a room that genuinely ends
 * where the window does; it has no message table and no clock. That residue is
 * recorded beside the two other things `TrustedContext` says core cannot check,
 * and `scannedAfterCitations` on the `none` result reports how far this call
 * actually read, so a caller that wants to assert more has the number to assert
 * it against.
 *
 * ## What this does **not** catch, and what the code does with it
 *
 * A contradiction phrased in fresh words — *"Bob will deploy production Friday."*
 * followed by *"That statement is false; production will not be deployed
 * Friday."* — reuses none of the sentence and performs no marked retraction. It
 * **auto-accepts**, and that is stated as a disposition rather than a residue,
 * because r4 was failed for doing the opposite.
 *
 * The argument that this disposition is right, and it is a different argument
 * from every other limit in this file: the receipt's guarantee is *somebody in
 * this room wrote this sentence, in these words*, and a later contradiction does
 * not make that false. Bob did write it. What the later message changes is the
 * **world**, not the quote — and the product has machinery for that which this
 * check is not: supersession (human-only for decisions, commitments and
 * objectives, per `decideSupersession`), the correction verbs, and #5/#17's
 * correction-rate telemetry. A model-accepted object also renders as `~` and
 * never as a fact.
 *
 * Compare what this file refuses: those inputs make the record assert something
 * its named author *never wrote*. That is unrecoverable, because nothing in the
 * room contradicts it. A stale-but-verbatim record is contradicted by the very
 * message that makes it stale, three lines further down the same window.
 *
 * ## The fail-closed variant was built, measured, and removed
 *
 * The fourth review pass proposed the obvious repair — refer whenever a later
 * message by the **bearing author** shares any content word with the statement,
 * on the ground that over-firing costs only a referral. It was implemented and
 * run, and the numbers refused it:
 *
 * | later message                              | vs the statement                    | shared | fraction |
 * | ------------------------------------------ | ----------------------------------- | ------ | -------- |
 * | "The production deployment is cancelled."  | "We will deploy production Friday." | `production` | **0.33** |
 * | "I'll land the migration tomorrow."         | "The migration is reversible."      | `migration`  | **0.50** |
 *
 * The first row is the defect — a genuine replacement that must be referred. The
 * second is an ordinary window from `acceptance.test.ts`: one person stating two
 * independent facts about one subject, which must **not** be referred. **The
 * benign pair scores higher than the defect.** No threshold separates them,
 * because there is nothing lexical to separate; the whole acceptance matrix went
 * `pending` when the clause was live, which is the auto-accept path dying rather
 * than being made safe.
 *
 * That measurement is the argument for the disposition above, and it is a better
 * one than the prose: the check that would close this class does not exist at
 * this layer. Detecting an arbitrary natural-language contradiction needs a
 * model, and #8's escalation tier is where a model belongs. This is a
 * deterministic check, and it says exactly what it proves.
 */
export function laterRevision(
  statement: string,
  citedIds: readonly string[],
  messages: readonly ProvenanceMessage[],
  policy: ReceiptPolicy = RECEIPT_POLICY,
): LaterRevision {
  if (isBlank(statement)) return scanned(0);
  const wanted = routingTokens(statement);
  if (wanted.length === 0) return scanned(0);
  // Too long to align against anything is the same answer the bearing check
  // gives: not checked, therefore not passed.
  if (wanted.length > policy.maxAlignedTokens) return unscanned('statement_too_long');

  // ── What counts as "later", and the padding attack that decided it ────────
  //
  // **After the *earliest* cited message, and the cited ones are scanned too**
  // (the paragraph below says why; this sentence read "skipping the cited ones"
  // until r6 and was contradicted seventeen lines later by the code and by its
  // own next comment). The first
  // draft scanned after the *last* citation, and this round's own blind review
  // walked through it: cite `m1` — where the sentence is — **and** an unrelated
  // later `m3`, and the correction sitting in `m2` is behind the scan's start.
  // Padding the citation list to move a boundary is the same attack r1's
  // gauntlet found against the attribution check, one guard over: a value the
  // proposal controls was being used to decide how much evidence gets read.
  //
  // The earliest citation is the floor because nothing before the sentence can
  // be a correction of it, and a cited message is not a revision of itself.
  const cited = new Set(citedIds);
  let firstCited = -1;
  for (const [index, message] of messages.entries()) {
    if (cited.has(message.id) && firstCited === -1) firstCited = index;
  }
  if (firstCited === -1) return scanned(0);

  // ── The window has to be the room's, and this is the half that is checkable ─
  //
  // r6. Nothing required `messages` to reach past the citations, so a caller
  // supplying "the messages this receipt cites" — the natural reading, and what
  // `commitmentAttribution` does one function over — silently turned this whole
  // scan off: whole room ⇒ `receipt_not_certifiable`, cited only ⇒
  // `auto_accept`. The contract is written on `AcceptanceContext.messages`; this
  // is the part of it a pure function can enforce. A window whose every message
  // the proposal chose is a window the proposal controls, which is the shape of
  // every padding attack this file has been through, and the answer to a scan
  // that could not read anything is the one it gives everywhere else: not
  // checked, therefore not passed.
  if (messages.every((message) => cited.has(message.id))) {
    return unscanned('window_is_only_the_citations');
  }

  // **Cited messages are scanned, not skipped.** The first repair filtered them
  // out, and the next review pass used that: put the correction in a message the
  // proposal *cites*, and the scan that exists to find corrections stepped over
  // it. A citation is chosen by the proposal, so anything a citation can exclude
  // is a boundary the proposal controls — which is the shape of every padding
  // attack this file has been through. A cited message aligned against its own
  // statement is exact, and an exact restatement is not a revision, so scanning
  // them costs nothing.
  const later = messages.slice(firstCited + 1);
  // ── The cap fails closed, and that is r5 auditing its own first draft ──────
  //
  // The first version of this scan stopped at the cap and returned "nothing
  // found", with a comment arguing that stopping was safe "in the direction that
  // matters — it can only miss a correction". That argument is the exact shape
  // this round exists to delete: a limit written into a comment, and an input
  // inside it **auto-accepted**. A window with 201 messages after the citation
  // is a window this function did not read, and an unread window is not a clean
  // one. `maxAlignedTokens` and `maxScannedSentences` already answer their own
  // version of this question with a refusal; this one now does too.
  if (later.length > policy.maxLaterMessagesScanned) return unscanned('too_many_messages');

  for (const message of later) {
    const own = stripReplyBlockquotes(message.body);

    // ── …or somebody took something back, in whatever words ────────────────
    //
    // The structural test below only sees a correction that **reuses the
    // sentence**. This round's own adversarial pass produced the one it does
    // not: *"We will deploy production Friday."* followed by *"Correction: the
    // deployment is cancelled."* shares not one content token with the statement
    // (`deploy` and `deployment` are different tokens), aligns with nothing, and
    // auto-accepted.
    //
    // So the second clause is a marker, and it is the only marker list in this
    // package that acceptance reads. It is admissible **because of the direction
    // it can be wrong in**: a hit adds a referral and can never add an
    // acceptance, so an over-firing entry costs a person one glance at a window
    // where somebody explicitly withdrew something — which is a window a machine
    // should not be minting facts out of anyway. `RETRACTION_MARKERS` is the
    // subset that performs a withdrawal; the noisy conversational half of
    // `CONCESSION_MARKERS` (`actually`, `good point`) stays out, because a
    // referral is cheap and free is cheaper.
    const normalized = normalizeForRouting(own);
    for (const marker of RETRACTION_MARKERS) {
      if (containsPhrase(normalized, marker)) return revision(message, [marker]);
    }
    if (SED_CORRECTION.test(own)) return revision(message, ['s/…/…/']);

    const sentences = sentencesOf(own);
    if (sentences.length > policy.maxScannedSentences) return unscanned('too_many_sentences');
    for (const sentence of sentences) {
      const aligned = alignTokens(routingTokens(sentence), wanted, policy);
      if (aligned.undecidable === 'too_long') return unscanned('too_many_tokens_in_a_sentence');
      if (aligned.undecidable !== null) continue;
      // **One side is contained in the other, and they are not the same.**
      //
      // The first draft asked only about *addition* — every word of the statement
      // present, in order, and the sentence saying more. grok's pass produced the
      // mirror image: a later message that says the same thing with a word
      // **removed** is the exact case r3's gauntlet is built on, and it aligned
      // the other way round, so it read as unrelated. "Bob will not deploy
      // production Friday." followed by "Bob will deploy production Friday." is a
      // correction in either direction.
      //
      // An exact restatement is agreement, not a revision, and a sentence that
      // differs on both sides is about something else. Containment in either
      // direction, and nothing else — no threshold, no opinion about which words
      // matter.
      if (aligned.borne) continue;
      const contained =
        aligned.unmatchedInStatement.length === 0 || aligned.unmatchedInQuote.length === 0;
      if (contained) {
        const changed =
          aligned.unmatchedInQuote.length > 0
            ? aligned.unmatchedInQuote
            : aligned.unmatchedInStatement;
        // `changed` is empty only when the two sentences differ in spacing
        // alone, which `normalizeForRouting` collapses away and so should be
        // unreachable here. Reported rather than skipped, because "unreachable"
        // is a claim about code that changes, and skipping would be this file's
        // own fail-open shape: a difference found and nothing said about it.
        return revision(message, changed.length > 0 ? changed : ['whitespace']);
      }
    }
  }
  return scanned(later.length);
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
  const normalized = normalizeForReceipt(quote);
  if (normalized.length === 0) return [];
  return messages.filter((message) =>
    normalizeForReceipt(stripReplyBlockquotes(message.body)).includes(normalized),
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
