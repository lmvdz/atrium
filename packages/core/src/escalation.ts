import { ATTRIBUTION_FIELD, ATTRIBUTION_FIELDS } from './attribution.js';
import {
  addedBlockStructure,
  addedLinkStructure,
  alignTokens,
  hasContent,
  isAssertion,
  isBlank,
  LINE_BREAK,
  normalizeForReceipt,
  normalizeForRouting,
  orderedTokens,
  quoteCoversOwnText,
  quoteSpansWholeSentences,
  readsAsQuestion,
  routingTokens,
  sentencesOf,
  statementBearing,
} from './matching.js';
import type { AcceptedObjectType } from './objects.js';
import { DEFAULT_ACCEPTANCE_RULES, RECEIPT_POLICY, type ReceiptPolicy } from './policy.js';

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
 *  - `unknown_message` — cites a message id that is not in the window. `refer`
 *    since r10, not `reject`: it is a fact about the window supplied, not about
 *    the reading. See the check itself.
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
 *    it can arise, because three drafts of this entry tried the list and a brute
 *    force broke all three. `normalizeForReceipt` has passed code segments
 *    through byte for byte since r5 on the argument that "two spaces in a
 *    password are a different password", and nothing at the comparison consulted
 *    it, because the tokenizer threw the spaces away: ``Run `rm -rf / tmp/cache`
 *    …`` bore ``Run `rm -rf /tmp/cache` …`` and auto-accepted.
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
 *  - `statement_adds_link_structure` — the statement being minted carries
 *    Markdown link markup **the cited message** does not, built out of the
 *    author's own words. The fold unfolds a link to `label dest title`, so the
 *    two normalize identically and every other check passes; the stored text is
 *    markup its named author never wrote. See `linkStructures`.
 *  - `statement_adds_block_structure` — **r11**, and it is the entry above at
 *    the other rule in the fold that can *build* structure rather than delete
 *    it. The statement carries a Markdown block marker, a paragraph break or a
 *    hard line break **the cited message** does not, built by putting a line
 *    break where the author put a space; the whitespace collapse forgives the
 *    difference, so the two normalize identically and every other check passes.
 *    See `blockStructures` and `breakStructures`.
 *
 *    **Both are read against the message body since r12, not against the
 *    quote.** The quote is a proposal field: r10 and r11 diffed the statement
 *    against it, so a forgery written into *both* fields cancelled to an empty
 *    difference and auto-accepted. A guard on what an author wrote can only be
 *    anchored to text the author wrote — see `addedStructure`.
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
  'quote_span_unscanned',
  'quote_omits_surrounding_text',
  'superseded_by_later_message',
  'statement_is_not_an_assertion',
  'statement_is_not_a_question',
  'statement_uncheckable',
  'statement_adds_link_structure',
  'statement_adds_block_structure',
  'ambiguous_quote',
  'attributed_person_not_author',
] as const;

export type ProvenanceProblemKind = (typeof PROVENANCE_PROBLEM_KINDS)[number];

/**
 * **What a finding is a fact *about*** — r11, and it is the distinction that
 * decides whether a cycle may treat its own verdict as a judgement.
 *
 * A finding about *the reading* is true of the proposal wherever it is examined
 * from: the quote is empty, the statement asserts words the quote does not, the
 * record would carry markup its author never wrote. Re-run it against any window
 * and it says the same thing.
 *
 * A finding about *the window* is a fact about **what the caller happened to
 * supply**. `unknown_message` is the obvious one; `quote_not_found` on a
 * two-citation proposal whose window dropped the bearing message is the same
 * fact wearing a verdict's clothes, and it is what r11 was opened on. An
 * ordinary sliding "last N messages" window produces it with no caller mistake,
 * and `attention.ts` used to read the resulting `discard` as *this cycle judged
 * this proposal and it owes nobody anything* — resolving somebody's confirm
 * forever, from a cycle that could not see the message it was confirming.
 *
 * Carried on the finding rather than tested at the place that consumes it,
 * because the consuming place is a *dispatch* and `RETRO.md` records what an
 * invariant asserted on one branch of one is worth. r10 moved `unknown_message`
 * from `reject` to `refer` — one severity, correct, and the branch that reads
 * severities went on reading `discard` as concluded. Moving a second severity
 * would be the same repair a third time; the class is wider than any list of
 * kinds somebody has met.
 */
export type ProblemSubject = 'the_reading' | 'the_window';

/**
 * **What each check reads** — declared once, per kind, and total by its type.
 *
 * `about` is derived from this rather than written at the ~20 places a problem
 * is pushed, which is the difference between a property of the finding and a
 * list maintained at the call site. `tsc` refuses a new kind that does not
 * appear here, so the classification cannot silently fall behind the taxonomy —
 * the same construction `objectPayloadKeys` uses for payload fields.
 *
 *  - `the_proposal` — the check reads the quote, the statement, the type or the
 *    citation list, and nothing else. Its answer cannot change with the window.
 *  - `the_cited_messages` — the check reads the cited messages' bodies or
 *    authors. Its answer is a fact about the window **exactly when the window
 *    did not hold every message the proposal cites**, because then it was
 *    computed over the survivors.
 *  - `the_window` — the finding *is* a statement about the window's reach, in
 *    every window. `unknown_message` says a citation was not reached;
 *    `superseded_by_later_message` says what does or does not follow the
 *    citations, and both of its arms change answer when the window slides.
 */
type ProblemEvidence = 'the_proposal' | 'the_cited_messages' | 'the_window';

const PROBLEM_EVIDENCE: Readonly<Record<ProvenanceProblemKind, ProblemEvidence>> = Object.freeze({
  no_provenance: 'the_proposal',
  unknown_message: 'the_window',
  missing_quote: 'the_proposal',
  quote_not_found: 'the_cited_messages',
  quote_only_in_reply_blockquote: 'the_cited_messages',
  elided_quote: 'the_cited_messages',
  quote_too_short: 'the_proposal',
  quote_does_not_bear_statement: 'the_proposal',
  quote_carries_more_than_statement: 'the_proposal',
  statement_respaces_the_quote: 'the_proposal',
  quote_is_a_fragment: 'the_cited_messages',
  quote_span_unscanned: 'the_cited_messages',
  quote_omits_surrounding_text: 'the_cited_messages',
  superseded_by_later_message: 'the_window',
  statement_is_not_an_assertion: 'the_proposal',
  statement_is_not_a_question: 'the_proposal',
  statement_uncheckable: 'the_proposal',
  statement_adds_link_structure: 'the_proposal',
  statement_adds_block_structure: 'the_proposal',
  ambiguous_quote: 'the_cited_messages',
  attributed_person_not_author: 'the_cited_messages',
});

/**
 * `about`, derived. The one place the classification above is applied.
 *
 * A `the_cited_messages` finding on a **complete** window is a finding about the
 * reading and must stay one: a quote that appears in none of the messages it
 * cites, all of which were supplied, is a wrong receipt, and a cycle that says
 * so has judged the proposal. Reading every such finding as a window-fact would
 * close rule 2 altogether, which is a different way of being wrong.
 */
function problemSubject(
  kind: ProvenanceProblemKind,
  windowHoldsEveryCitation: boolean,
): ProblemSubject {
  const evidence = PROBLEM_EVIDENCE[kind];
  if (evidence === 'the_proposal') return 'the_reading';
  if (evidence === 'the_window') return 'the_window';
  return windowHoldsEveryCitation ? 'the_reading' : 'the_window';
}

/** Whether any finding in a set is a fact about the window rather than the reading. */
export function isAboutTheWindow(problems: readonly ProvenanceProblem[]): boolean {
  return problems.some((problem) => problem.about === 'the_window');
}

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
  /**
   * **Whether this is a fact about the reading or about the window** — r11. See
   * `ProblemSubject`. Derived from `PROBLEM_EVIDENCE` and never written at a
   * `push` site, so a new finding cannot claim to have judged a reading it could
   * not see.
   */
  about: ProblemSubject;
}

/**
 * A finding before `about` is put on it — the shape every check inside
 * `validateProposalProvenance` builds.
 *
 * The field is deliberately absent here: a check states what it found, and
 * whether that was a fact about the reading or about the window is a property of
 * *which check it was* and of *what the window held*, decided in one place for
 * all of them.
 */
type Finding = Omit<ProvenanceProblem, 'about'>;

/** The slice of a proposal these checks read. */
export interface ProvenanceSubject {
  type: AcceptedObjectType;
  provenance: readonly string[];
  quote?: string | null;
  proposer?: { kind: 'model' | 'human' };
  /**
   * The person this payload names, from `payloadAttributions` — `claimant`,
   * `owner` or `decidedBy`, whichever the type carries. Never spelled out by a
   * caller: see `attribution.ts`.
   */
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
  const problems: Finding[] = [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  /**
   * Whether this window reached everything the proposal cites — the one input
   * `problemSubject` needs, computed before any check runs so that every finding
   * is scoped against the same fact.
   */
  const windowHoldsEveryCitation = subject.provenance.every((id) => byId.has(id));
  /** The single exit. Every `return` in this function goes through it. */
  const sealed = (): ProvenanceProblem[] =>
    problems.map((finding) => ({
      ...finding,
      about: problemSubject(finding.kind, windowHoldsEveryCitation),
    }));

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
    return sealed();
  }

  const cited: ProvenanceMessage[] = [];
  for (const id of subject.provenance) {
    const message = byId.get(id);
    if (!message) {
      // ── An unread window is not a clean one, in the other direction — r10 ──
      //
      // This was `reject` — *the reading is wrong* — and the fact it has is *the
      // window did not reach the message*. Those are different facts, and this
      // file applies the distinction the other way everywhere else it appears:
      // `quote_span_unscanned`, the `too_long` arm of `statement_uncheckable`,
      // and `laterRevision`'s three `unscanned` answers are all `refer`, on the
      // stated principle that **a check that declined to run is not a check that
      // passed**. Here alone it was applied in the destructive direction, and
      // `reject` is what `acceptance.ts` turns into `discard` — no proposal, no
      // attention item, no refusal, no trace.
      //
      // It needs no caller mistake to fire. An ordinary sliding "last N
      // messages" window that has moved past the cited message produces exactly
      // this, on a proposal that is still staged and still waiting for somebody:
      // the projection computed nothing, reported nothing, and
      // `reconcileAttention` read the absence as completion. Both halves of that
      // are fixed; this is the half that says *why* the item went missing.
      //
      // Not `reclassify`: nothing about the attribution changed. The reading may
      // be perfectly good and nothing here can tell, which is the definition of
      // the third severity.
      problems.push({
        kind: 'unknown_message',
        severity: 'refer',
        detail: `cites message "${id}", which is not in the window — the window supplied does not reach that message, so nothing about this citation was checked either way; an unread window is not a clean one, and a check that declined to run is not a check that passed`,
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
      // ── The cap is a refusal to look, not a finding, and it says so ────────
      //
      // r7. `quoteSpansWholeSentences` returns `false` in two situations that
      // are opposite facts about the world: the quote really is cut out of the
      // middle of a sentence, and *the body has more sentences than the scan
      // will read* (`maxScannedSentences`). Both produced the fragment message,
      // so a quote that is the **entire body** of a 201-sentence message was
      // told it had been "cut out of the middle of a sentence". Right
      // disposition — an unread body is not a clean one, and `refer` is what
      // this file gives an unanswered question everywhere else — and a sentence
      // a person reads that is simply false about their own message.
      //
      // Checked here rather than inside `quoteSpansWholeSentences`, because the
      // predicate's answer is genuinely "no" in both cases; what differs is
      // *why*, and why is what the room is shown.
      if (sentencesOf(ownText).length > policy.maxScannedSentences) {
        problems.push({
          kind: 'quote_span_unscanned',
          severity: 'refer',
          detail: `message "${bearing.id}" holds more than the ${policy.maxScannedSentences} sentences this check will read, so whether the quote is whole sentences of it or a span cut out of the middle of one was never established — an unread message is not a clean one, and a check that declined to run is not a check that passed`,
          messageId: bearing.id,
        });
      } else if (!quoteSpansWholeSentences(quote, ownText, policy)) {
        problems.push({
          kind: 'quote_is_a_fragment',
          severity: 'refer',
          detail: `the quote is a span cut out of the middle of a sentence in message "${bearing.id}" rather than one or more whole sentences of it — the words on either side of the cut may qualify or reverse it ("it is not true that …"), and nothing here can read them, so this reading is not accepted on a machine's word`,
          messageId: bearing.id,
        });
      } else if (!quoteCoversOwnText(quote, bearing.body)) {
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
    // `hasContent` is r7 and it is about *not reporting twice*, not about
    // safety. A proposal with no statement is already `statement_uncheckable` /
    // `reject` a few lines down; since r7 `laterRevision` answers `unscanned`
    // rather than a false `none` for that input, so without this guard the room
    // would be told a second time, in different words, that a check it could
    // never have run did not run. The function is honest on its own and the
    // caller does not ask a question it has already refused.
    if (fromModel && cited.length > 0 && hasContent(subject.statement)) {
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
            revisited.why === 'window_ends_at_the_citations'
              ? `the window carries nothing after the newest message this proposal cites, so the correction scan read no evidence about what came after the quoted sentence — whether a later message takes it back was never established, and a window that ends at the citations cannot answer that (see \`AcceptanceContext.messages\`)`
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
    // question into their position.
    //
    // The r5 text here argued from `RECEIPT_POLICY.droppableTokens` — "`?` is
    // kept out of the set the bearing check will forgive" — in the present
    // tense. **That set no longer exists.** r6 emptied it and r6's own policy
    // test asserts its absence by name (`boundary.test.ts`, "is exactly this
    // table"), because every entry it ever held was broken by a reviewer. The
    // argument outlived the set that used to carry it and is now the whole
    // rule: nothing may differ between a quote and its statement, `?` included,
    // so a question mark is never forgiven by the comparison. Here the mark is
    // *read* rather than compared, which is the part the comparison cannot do.
    if (
      fromModel &&
      subject.type !== 'open_question' &&
      !isAssertion(normalizeForReceipt(subject.statement ?? ''))
    ) {
      problems.push({
        kind: 'statement_is_not_an_assertion',
        severity: 'refer',
        detail: `the ${subject.type} being minted carries a question mark — a question quoted verbatim is an open question or a referral, never an assertion about what somebody holds, and nothing here can tell a rhetorical question from a real one`,
        messageId: bearing?.id ?? null,
      });
    }

    // ── …and the mirror, which was the cheaper half of the same laundering ──
    //
    // r7. The check above is one-directional, and `type` is model-supplied, so
    // the direction it does not cover is the direction with a *lower bar*:
    // `open_question` carries θ_auto **0.6** against a claim's 0.7 and a
    // commitment's 0.75 (`DEFAULT_ACCEPTANCE_RULES`). An ordinary declarative
    // sentence — no question mark anywhere in it — minted as an `open_question`
    // at confidence 0.65 auto-accepted, where the same sentence as a `claim`
    // landed in `theta_band / pending`. **The proposer picked the rule that
    // judged it**, and the receipt had nothing to say because a receipt
    // certifies provenance and this is a question about the kind of act.
    //
    // This half is certifiable, and that is why it ships as a refusal rather
    // than as the disposition below it: an interrogative is a property of the
    // text, `QUESTION_MARKS` already enumerates every mark that makes one across
    // every script, and `isAssertion` is the instrument the other direction
    // already runs on. A statement with no question mark in it is not a
    // question, in the same sense and by the same measurement that a statement
    // with one is not an assertion.
    //
    // `refer`, matching its mirror: the disposition on a mistyped reading is
    // that a person decides what it was, not that the words are thrown away.
    // **`readsAsQuestion`, not `!isAssertion` — r8.** These two checks are
    // mirrors and their safe directions are opposite: the one above refuses when
    // a mark is *found*, so over-inclusion costs a referral; this one refuses
    // when none is found, so over-inclusion **auto-accepts a declarative at
    // `open_question`'s lower θ**, which is the laundering the check exists to
    // close. One set could not serve both, which is the same finding
    // `normalizeForMatch` produced in `matching.ts`, one file over. So the
    // generous set refuses an assertion and the strict set certifies a question,
    // and a mark nobody can verify sits in the first and not the second.
    if (
      fromModel &&
      subject.type === 'open_question' &&
      !readsAsQuestion(normalizeForReceipt(subject.statement ?? ''))
    ) {
      problems.push({
        kind: 'statement_is_not_a_question',
        severity: 'refer',
        detail: `the open question being minted carries no question mark — an open question is the type with the lowest bar a machine may accept at (θ_auto ${DEFAULT_ACCEPTANCE_RULES.open_question.thetaAuto} against a claim's ${DEFAULT_ACCEPTANCE_RULES.claim.thetaAuto}), and a declarative sentence filed under it is a reading routed around its own threshold rather than an unresolved question`,
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

      // ── …in the author's words *and the author's punctuation* — r10 ────────
      //
      // `borne` is exactly `normalizeForReceipt(quote) ===
      // normalizeForReceipt(statement)`, and the fold unfolds `[label](dest
      // "title")` into `label dest title`. r4 and r7 closed the direction where a
      // message carrying a link is reduced to a statement that hides where it
      // goes; the mirror — a statement that *builds* link markup out of words the
      // author wrote in prose — folds to the identical normal form and passed
      // every check in this file.
      //
      //   alice wrote : Read the runbook at https://safe.example do not run step 4.
      //   record says : Read the runbook at [https://safe.example]( "do not run step 4").
      //
      // Both `auto_accept` before this check. The click happens in the rendering
      // lane and the record is written here, which makes this the only place that
      // can refuse it. `reject`: the statement is not the quoted sentence, it is
      // the quoted sentence with punctuation nobody wrote, and that is a wrong
      // receipt rather than an unanswerable question.
      //
      // Run outside the `borne` branch on purpose — an invariant asserted on one
      // branch of a dispatch does not constrain the others, which is r10's other
      // finding one file over.
      //
      // ── …and the thing it is compared against is the *message* — r12 ───────
      //
      // r10 and r11 both read this guard against `quote`, and **`quote` is a
      // proposal field**. `Proposal` carries it beside `payload.statement`, one
      // proposer writes both, so putting the fabricated markup in the quote as
      // well as the statement cancelled the difference to empty and the whole
      // package looked at nothing else. Measured: with an honest quote both
      // forgeries are refused, with a forged one both take a clean receipt, land
      // `auto_accept`, and survive replay.
      //
      // Validating the quote does not already stop it. The quote is checked
      // against the body twice — `normalizeForReceipt(body).includes(...)` above
      // and `quoteCoversOwnText` — and **both run through the receipt fold,
      // which was designed to ignore exactly the dimension these guards depend
      // on**: a whitespace run is one space, and `[label](dest "title")` is
      // `label dest title`. Two mechanisms, each correct alone, and the defect
      // was the seam. `significant`'s docblock, which promised the opposite in
      // the word "verbatim", is repaired in the same round.
      //
      // So the anchor is `bearing.body` — the only text in this function an
      // author actually wrote. Comparing two fields the same caller filled in
      // proves nothing whatever either of them says. **And `''` when there is no
      // bearing message**, which is fail-closed rather than a skip: every
      // structure in the statement is then unattributed and reported. That
      // branch is already `quote_not_found`, `ambiguous_quote` or
      // `quote_only_in_reply_blockquote` — all `reject` — so the extra problem
      // cannot change a verdict; it is written this way so the guard never
      // depends on another check having fired, which is the reasoning `RETRO.md`
      // records as fail-open twice over.
      const authored = bearing?.body ?? '';
      const wrote = bearing ? `message "${bearing.id}"` : 'any message in this window';
      const added = addedLinkStructure(authored, statement);
      if (added.length > 0) {
        problems.push({
          kind: 'statement_adds_link_structure',
          severity: 'reject',
          detail: `the ${subject.type} being minted carries link markup ${wrote} does not — ${added.map((link) => `\`${clip(link, 60)}\``).join(', ')} — so the record would store markup its named author never wrote, assembled out of their own words: a link's text, destination and title normalize to the same words whether or not the brackets are there, which is why every other check on this receipt passes`,
          messageId: where,
        });
      }

      // ── …and the author's line breaks are the author's too — r11 ──────────
      //
      // The mirror of the rule above at the *other* entry in the fold that can
      // build structure rather than delete one. `foldProse` collapses
      // `\p{White_Space}+` to a single space, in both directions, so a statement
      // may put a **line break where its author put a space**, normalize to the
      // identical text, be `borne`, and land:
      //
      //   alice wrote : Latency > 200ms is unacceptable for the search API.
      //   record says : Latency\n> 200ms is unacceptable for the search API.
      //
      // The record then holds a block quote alice never wrote, out of alice's
      // own characters. `- `, `# `, `| `, a four-column indent and the rest of
      // the block-start inventory do the same thing; `blockStructures` is the
      // list and says why it is a closed one.
      //
      // **The whitespace entry itself is not narrowed, and must not be.** It has
      // the best argument of the four the fold admits — a client wraps a message
      // and a quote copied out of it carries different line breaks — and r10's
      // 1.7M-sample collision search found nothing else wrong with it. What is
      // refused is not "a line break moved" but "a line break moved *and* the
      // author's next character became a block marker because of it", which is
      // the same shape `addedLinkStructure` has: markup the statement carries and
      // the quote does not.
      //
      // Outside the `borne` branch, for r10's reason and in r10's words: an
      // invariant asserted on one branch of a dispatch does not constrain the
      // others.
      //
      // `reject`, matching its sibling: the statement is not the quoted
      // sentence, it is the quoted sentence re-broken into lines by something
      // that was not its author, and that is a wrong receipt rather than an
      // unanswerable question.
      //
      // ── …at the message, and at the breaks a marker cannot carry — r12 ────
      //
      // Anchored to `authored` for the reason above: the quote is the proposer's
      // field, and a forged one cancelled every marker in `BLOCK_MARKER`'s
      // inventory. And `addedBlockStructure` now reads `breakStructures` too,
      // because `blockStructures` reports **line beginnings** and the two
      // rendered breaks that carry no marker were clean even with an honest
      // quote: a blank line splits one paragraph into two, and two trailing
      // spaces make a `<br>` everywhere. Same fold entry, same author's
      // characters, shapes the r11 reader was structurally unable to see. A bare
      // re-wrapped newline stays free and stays stated residue — see
      // `breakStructures` for where that line is drawn and why.
      const built = addedBlockStructure(authored, statement);
      if (built.length > 0) {
        problems.push({
          kind: 'statement_adds_block_structure',
          severity: 'reject',
          detail: `the ${subject.type} being minted carries Markdown structure ${wrote} does not — ${built.map((line) => `\`${clip(line, 60)}\``).join(', ')} — so the record would store block structure its named author never wrote, built by putting a line break where they put a space: a run of whitespace normalizes to one space whichever characters it is made of, which is why every other check on this receipt passes`,
          messageId: where,
        });
      }
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
          // ── …and the sentence a person reads has to be true, r7 ────────────
          //
          // `unmatchedInStatement` is *what the aligner could not pair*, which
          // is not the same as *what the quote does not contain*, and the
          // difference is visible to anyone reading the refusal. The
          // resynchroniser recovers a single insertion or substitution exactly;
          // a **transposition of a repeated token** knocks both sides out of
          // step, and the leftovers are words the quote plainly holds:
          //
          //   quote     "We deploy production Friday and we deploy staging Monday."
          //   statement "We deploy staging Friday and we deploy production Monday."
          //   → asserts "Friday", "and", "we", "deploy", "production", *which the
          //     quote does not say* — all five of which it says.
          //
          // Brute-forced over 200k random pairs by r7's blind review: **56,559
          // refusals named a token the quote does contain.** The verdict was
          // right every time and no mislabel ever reached an accepting branch —
          // the message was the defect, and a refusal shown to a room that is
          // false about the room's own words is worse than a vaguer true one,
          // because it points at the wrong thing to fix.
          //
          // So the two cases are told apart by asking the quote directly. Words
          // genuinely absent are named as absent; when every unpaired word is
          // present, the refusal says what actually happened — the same words in
          // a different order, which is one of the ways a sentence is reversed.
          // The verdict does not move: either way this statement is not the
          // quoted sentence.
          const quoteTokens = new Set(orderedTokens(quote));
          const absent = bearingResult.unmatchedInStatement.filter(
            (word) => !quoteTokens.has(word),
          );
          problems.push({
            kind: 'quote_does_not_bear_statement',
            severity: 'reject',
            detail:
              absent.length > 0
                ? `"${clip(statement, 60)}" asserts ${absent.map(token).join(', ')}, which the quote does not say — the quoted span is from a cited message but it is not this sentence, so the citation leads a reader somewhere that does not say this`
                : `"${clip(statement, 60)}" uses only words the quote contains and puts them in a different order — ${bearingResult.unmatchedInStatement.map(token).join(', ')} could not be lined up against ${bearingResult.unmatchedInQuote.length > 0 ? bearingResult.unmatchedInQuote.map(token).join(', ') : 'the quote'} — and swapping two words is one of the ways a sentence is reversed, so this is not the sentence that was quoted`,
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
          // The same non-whitespace marks, in the same order, spaced differently.
          //
          // **The refusal names the fact and not the cause, and three of this
          // round's adversarial passes are why.** Draft one said the difference
          // could only be inside a code span; a brute force over generated pairs
          // produced 21,344 counterexamples in plain prose. Draft two named two
          // causes — a code literal and a dropped full stop; the next pass
          // produced a third (`wa 'z` against `wa' z`, a space and a mark trading
          // places). Draft three said a code span was the only survivor once
          // `droppableTokens` was emptied; `w .z` against `w. z` says otherwise.
          // A list of the ways a thing can happen is the instrument `RETRO.md`
          // has now recorded four times, and it does not stop being one for being
          // written in prose. What is true of every case is the sentence above,
          // and it is the only thing claimed.
          //
          // `reject` and not `refer`: this is a verdict, not a hesitation. The
          // statement carries a text its author did not write, and no reading of
          // the neighbouring words can make it the one that is in the message.
          problems.push({
            kind: 'statement_respaces_the_quote',
            severity: 'reject',
            detail: `"${clip(statement, 60)}" holds the marks of the quote in the same order and spaces them differently, so it is not the text that is in the message — a code literal respaced is a literal changed (\`rm -rf / tmp/cache\` is not \`rm -rf /tmp/cache\`), and in prose the spacing is the only thing the fold has already forgiven, so what is left is a difference the author did not write`,
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
  // DERIVED, NOT LISTED. This read `type === 'claim' || type === 'commitment'`
  // until #22 r10 — a *third* place answering "does this type name a person". It
  // omitted `decision.decidedBy` exactly as the other two did, so a machine
  // could file "the victim decided X" citing nothing that says so. One
  // classification, in `attribution.ts`, and a payload that grows a name field
  // nobody classified does not compile.
  //
  // It is declared HERE rather than beside `fromModel` above, where the realtime
  // lane put it, because it now has exactly one use. That lane's other use was
  // the missing-quote gate — `fromModel && namesAPerson && normalizedQuote.length
  // === 0` — and the core lane widened that gate to EVERY type in the same
  // window this was being derived in: "the receipt is not only about
  // attribution; it answers which sentence, in which message, for every type".
  // Both changes survive. The gate is unconditional (core's, and stricter), and
  // the question "does this type name a person" is answered from the
  // classification (realtime's, and the only correct answer) at the one place
  // that still asks it.
  const namesAPerson = ATTRIBUTION_FIELDS[subject.type].length > 0;
  if (attributed && cited.length > 0 && namesAPerson) {
    const supported = bearing
      ? bearing.authorId === attributed
      : fromModel
        ? false
        : cited.some((message) => message.authorId === attributed);
    if (!supported) {
      /**
       * `reject` discards; `reclassify` surfaces it to the person named.
       *
       * The split is **whether naming somebody starts a flow that asks them**,
       * and it is not the same as "which type is it":
       *
       *  - A `commitment` names an owner, and a third-party one waits for that
       *    owner's confirm (`awaitingConfirmFrom`, and `attention.ts`'s
       *    `owned_commitment` confirm item). Discarding it would delete the
       *    confirm flow rather than trigger it.
       *  - A `decision` names a decider, and a decision *never auto-accepts* —
       *    it goes to Needs-you, routed by `attention.ts` to `decidedBy`. So the
       *    same argument holds, and it holds for the same reason. This arrived
       *    here for the first time in r10, when `namesAPerson` stopped being a
       *    hand-written pair and became the derived set: before that, "the
       *    victim decided to cancel the audit" cited nothing that had to say so.
       *  - A `claim` asserts *that this person said this*. There is nothing to
       *    confirm — if the receipt does not support it, the reading is simply
       *    wrong, and a wrong citation is worse than no reading.
       */
      const asksTheNamedPerson = subject.type === 'commitment' || subject.type === 'decision';
      const field = ATTRIBUTION_FIELD[subject.type] ?? 'the named person';
      const where = bearing
        ? `the message bearing it ("${bearing.id}") was written by "${bearing.authorId}"`
        : ambiguous
          ? 'more than one cited author carries the quote, so no message can be said to bear it'
          : fromModel
            ? 'no cited message bears the quote, so nothing identifies the message that named them'
            : `authored none of the cited messages (${cited.map((message) => `"${message.authorId}"`).join(', ')})`;
      problems.push({
        kind: 'attributed_person_not_author',
        severity: asksTheNamedPerson ? 'reclassify' : 'reject',
        detail: asksTheNamedPerson
          ? `${field} "${attributed}" ${where} — this is third-party attribution, not a self-statement, so it needs their confirm`
          : `${field} "${attributed}" ${where} — the receipt does not support "X said Y"`,
        messageId: bearing?.id ?? null,
      });
    }
  }

  return sealed();
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
      why: // r7: the three that used to be `scanned(0)`, which claimed a completed
      // scan for a call that read nothing.
        | 'no_statement_to_scan_for'
        | 'no_citation_in_the_window'
        | 'statement_too_long'
        | 'window_ends_at_the_citations'
        | 'too_many_messages'
        | 'too_many_sentences'
        | 'too_many_tokens_in_a_sentence';
    }
  /**
   * The scan ran to the end of the window and found nothing.
   *
   * `scannedAfterCitations` records **how far it read** — the count nothing kept
   * before r6, which is half of why a truncated window was invisible.
   *
   * **This sentence is now true, and r7 is why it was not.** Three paths
   * returned `scanned(0)` without scanning — a blank statement, a statement with
   * no routing tokens, and a citation list none of whose ids are in the window —
   * so the value meaning *"checked, clean"* was also the value meaning *"never
   * looked"*, which is the one merge this union exists to prevent. All three are
   * `unscanned` with their own reason, and `scannedAfterCitations` is `0` only
   * if the scan genuinely read nothing after the citations — which the window
   * gate makes unreachable.
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
  // ── Three ways to read nothing, and none of them is a clean scan ─────────
  //
  // **r7, found by the round's own foreign-lineage pass, in the code r7 wrote
  // the union for.** These lines returned `scanned(0)` — the value whose
  // docblock says *"the scan ran to the end of the window and found nothing"* —
  // for a statement with no words in it, a statement with no routing tokens, and
  // a citation list none of whose ids are in the window. The scan ran to the end
  // of nothing. r6 built this tagged union precisely so *nothing corrects this*
  // and *nothing read the window* could not merge, and then three paths merged
  // them.
  //
  // Not reachable as an acceptance today: `validateProposalProvenance` calls
  // this only with a resolved citation and a statement, and has already pushed
  // `unknown_message` (`refer` since r10) or `statement_uncheckable` on the
  // inputs that get here. **That is the whole objection.** The guard is in a different
  // function, so the safety of `laterRevision`'s answer is a property of its
  // caller, and this file's standing lesson is that a rule applied at one site
  // is not a rule. Each path now says which question it declined to answer.
  if (isBlank(statement)) return unscanned('no_statement_to_scan_for');
  const wanted = routingTokens(statement);
  if (wanted.length === 0) return unscanned('no_statement_to_scan_for');
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
  let lastCited = -1;
  for (const [index, message] of messages.entries()) {
    if (!cited.has(message.id)) continue;
    if (firstCited === -1) firstCited = index;
    lastCited = index;
  }
  // Not one cited id is in this window, so there is no sentence to find a
  // correction *of* and nothing was read. See the paragraph at the top of this
  // function: `unknown_message` refers this upstream (`reject` until r10), and
  // that is a fact about the caller rather than about this answer.
  if (firstCited === -1) return unscanned('no_citation_in_the_window');

  // ── …and the floor is where the SENTENCE is, not where a citation is — r8 ──
  //
  // The paragraph above ends *"that floor being proposal-controlled only ever
  // makes the scan read more"*, and r8's blind review produced the window where
  // it does the opposite. Two messages carrying the **same body**:
  //
  //   m1 "The migration completed cleanly…"
  //   m2 "Correction: the migration did not…"
  //   m3 <byte-identical to m1>
  //   m4 <uncited>
  //
  // cite `['m1']` and the scan starts at index 1, reads the correction, and the
  // reading is `pending / receipt_not_certifiable`. Cite `['m3']` — equally true,
  // equally verbatim, and the receipt cannot tell the two apart because the
  // bodies are the same text — and `firstCited` is 2, so the correction sits
  // *behind the scan's start* and the same reading `auto_accept`s. The floor was
  // proposal-controlled downward after all; it just needed a duplicate body to
  // show it.
  //
  // The repair is to stop asking the citation list where the sentence is. The
  // sentence's earliest possible position is a fact about the **window's text**:
  // the first message whose own words carry the statement. Padding, dropping or
  // swapping citations cannot raise it, because it is not computed from them —
  // and it can only ever be at or before `firstCited`, so this strictly widens
  // what gets read, which is the direction the paragraph above was claiming for
  // the wrong reason.
  const normalizedStatement = normalizeForReceipt(statement);
  const earliestBearing = messages.findIndex((message) =>
    normalizeForReceipt(stripReplyBlockquotes(message.body)).includes(normalizedStatement),
  );
  const scanFloor = earliestBearing === -1 ? firstCited : Math.min(firstCited, earliestBearing);

  // ── The window has to reach past the sentence, and that is checkable ──────
  //
  // r6. Nothing required `messages` to extend past the citations, so a caller
  // supplying "the messages this receipt cites" — the natural reading, and what
  // `commitmentAttribution` does one function over — silently turned this whole
  // scan off: whole room ⇒ `receipt_not_certifiable`, cited only ⇒
  // `auto_accept`. The contract is written on `AcceptanceContext.messages`; this
  // is the part of it a pure function can enforce.
  //
  // **The test is "did this scan read anything the proposal did not choose",
  // and grok's blind pass is why it is not "does the window hold anything the
  // proposal did not choose".** The first repair asked the second question, and
  // a window of `[uncited, cited]` — an earlier message that cannot possibly
  // correct a later one — satisfied it while the scan read exactly zero
  // messages. A boundary the proposal controls is the shape of every padding
  // attack this file has been through, and "the caller happened to include some
  // earlier chatter" is not evidence about what came after.
  //
  // The cost, stated as a disposition: **a reading whose newest citation is the
  // newest message in the window is never auto-accepted.** Nothing later exists
  // to have corrected it, and core cannot tell that from a window that stops
  // early — it has no message table and no clock. The honest answer to a
  // question this function cannot ask is the one it gives everywhere else, and
  // `refer` keeps the reading staged for a person rather than destroying it.
  //
  // ── Who supplies `citedIds`: the proposal. Why this is still a check ──────
  //
  // r7, and the third time this one boundary has moved. r6 asked the existence
  // question from `firstCited + 1` — the same index the scan starts at — and a
  // window of `[cited, uncited, cited]` answered it *yes* while every message
  // the scan read sat at or before the sentence. `provenance` is model-supplied,
  // so **citing one extra earlier message turned the gate off**: cite only the
  // bearing message and the reading is `pending`; add the standup chatter three
  // lines above it and the same reading is `auto_accept`. That is not an
  // adversarial shape. An extraction drawn from two messages, in a window
  // ending at the newest one — the ordinary case — hits it on the first try.
  //
  // The question the gate has to ask is **"was anything read after the
  // sentence?"**, and the only bound on where the sentence sits that this
  // function can compute is `lastCited`: `validateProposalProvenance` rejects a
  // proposal whose quote is in no *cited* message (`quote_not_found`), so the
  // bearing message is always one of the cited ones, so nothing after
  // `lastCited` can be the sentence. Hence the existence test runs from
  // `lastCited + 1`.
  //
  // **And it is the one index in this function the proposal cannot profit from
  // moving.** Padding the citation list with a *later* message raises
  // `lastCited` and makes the gate stricter; padding it with an *earlier* one —
  // the r6 exploit — no longer moves it at all; dropping a citation is refused
  // upstream the moment it is the one carrying the quote. Every direction the
  // proposer can push this value pushes toward a referral. The *scan* still
  // starts at `firstCited + 1`, for the reason the paragraphs above give: a
  // correction sitting between two citations must be read, and that floor being
  // proposal-controlled only ever makes the scan read more.
  //
  // The `!cited.has` predicate is redundant — every index past `lastCited` is
  // uncited by construction — and it is written out anyway, because the property
  // being asserted is *"the scan read evidence the proposal did not choose"* and
  // not *"the array is longer than an index"*. If a later reader makes
  // `lastCited` mean something else, this reads as the claim it is making.
  const readSomethingUnchosenAfterTheSentence = messages
    .slice(lastCited + 1)
    .some((message) => !cited.has(message.id));
  if (!readSomethingUnchosenAfterTheSentence) {
    return unscanned('window_ends_at_the_citations');
  }

  // **Cited messages are scanned, not skipped.** The first repair filtered them
  // out, and the next review pass used that: put the correction in a message the
  // proposal *cites*, and the scan that exists to find corrections stepped over
  // it. A citation is chosen by the proposal, so anything a citation can exclude
  // is a boundary the proposal controls — which is the shape of every padding
  // attack this file has been through. A cited message aligned against its own
  // statement is exact, and an exact restatement is not a revision, so scanning
  // them costs nothing.
  const later = messages.slice(scanFloor + 1);
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
    // Over the same representation its sibling above reads, r8 — the round's
    // foreign-lineage sweep found these two lines one apart and disagreeing
    // about what text they were looking at. Every other member of this loop
    // consumes `normalizeForRouting(own)`; this one consumed the raw body, so a
    // `s/deploy/rollback/` written with a fullwidth solidus, inside emphasis, or
    // in a different case was invisible to it while the retraction markers next
    // to it saw through all three. A detector reading a rawer form than the
    // detectors beside it is the same misalignment as the headline, in the
    // direction that misses corrections.
    if (SED_CORRECTION.test(normalized)) return revision(message, ['s/…/…/']);

    const sentences = sentencesOf(own);
    if (sentences.length > policy.maxScannedSentences) return unscanned('too_many_sentences');
    // ── A correction in the sentence NEXT to the restatement — r8 ────────────
    //
    // The loop below compares one sentence at a time, and an exact restatement
    // `continue`s as agreement. So *"<S> Unless CI is red."* — S repeated
    // verbatim, with the qualifier in its own sentence — matched nothing: S was
    // borne, "Unless CI is red." aligned with nothing, and the reading
    // auto-accepted. The identical qualifier *inside* S's sentence referred.
    //
    // Those are the exact strings `quote_omits_surrounding_text` cites, one
    // message earlier, to justify refusing that construction: *"a neighbouring
    // line can reverse, condition or withdraw the one being quoted ('… Not.',
    // 'Unless CI is red.', 'Correction: …')"*. The rule was applied to the
    // bearing message and not to the messages after it, which is this file's own
    // standing lesson about a rule with one enforcement point.
    let restated = false;
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
      if (aligned.borne) {
        restated = true;
        continue;
      }
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
    // The sentence came back and the message says more around it. Whether the
    // surrounding line qualifies, reverses or merely adds is not something a
    // machine may decide from the words — which is `quote_omits_surrounding_text`
    // verbatim, and the same disposition: `refer`, with the added words named.
    if (restated && !quoteCoversOwnText(statement, own)) {
      const around = sentences.filter(
        (sentence) => !alignTokens(routingTokens(sentence), wanted, policy).borne,
      );
      const added = around.flatMap((sentence) => routingTokens(sentence));
      return revision(message, added.length > 0 ? added : ['surrounding text']);
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
