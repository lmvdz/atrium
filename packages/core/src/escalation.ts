import type { AcceptedObjectType } from './objects.js';

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
 * Fold away the formatting both tiers drop when they quote.
 *
 * Markdown links collapse to their text, emphasis/code/strike markers vanish,
 * whitespace collapses, case folds. Measured need, not defensiveness: three of
 * the eight apparent provenance failures in the spike were pure formatting
 * artifacts — the model had dropped `**` or `[…](…)` while quoting correctly —
 * and without this the checker generates false failures on correct output.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, ' ')
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
  minQuoteLength: 24,
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

/** Words carrying no topic signal — dropped before overlap is measured. */
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
  /** The quote is in no cited message at all. */
  | 'quote_not_found'
  /**
   * The quote is only in a cited message's *reply-blockquote* — text the cited
   * author did not write. The spike's worst error, at 0.98 confidence.
   */
  | 'quote_only_in_reply_blockquote'
  /** The quote was silently shortened with `…` and does not appear verbatim. */
  | 'elided_quote'
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
): ProvenanceProblem[] {
  const problems: ProvenanceProblem[] = [];
  const byId = new Map(messages.map((message) => [message.id, message]));

  if (subject.provenance.length === 0) {
    if (subject.proposer?.kind === 'model') {
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

  const quote = subject.quote?.trim();
  if (quote && cited.length > 0) {
    const normalizedQuote = normalizeForMatch(quote);
    const inFullText = cited.filter((message) =>
      normalizeForMatch(message.body).includes(normalizedQuote),
    );
    const inOwnText = cited.filter((message) =>
      normalizeForMatch(stripReplyBlockquotes(message.body)).includes(normalizedQuote),
    );

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
  // With no bearing message — no quote, or a quote that is nowhere (the quote
  // problems above have already fired) — it falls back to the citation list.
  // That fallback can only be *more* likely to report a problem, never less.
  const attributed = subject.attributedTo;
  if (
    attributed &&
    cited.length > 0 &&
    (subject.type === 'claim' || subject.type === 'commitment')
  ) {
    const bearing = quote ? bearingMessage(quote, cited) : null;
    const supported = bearing
      ? bearing.authorId === attributed
      : cited.some((message) => message.authorId === attributed);
    if (!supported) {
      const claim = subject.type === 'claim';
      const where = bearing
        ? `the message bearing it ("${bearing.id}") was written by "${bearing.authorId}"`
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
 * The cited message that actually carries a quoted span — the one whose *own*
 * text contains it once reply-blockquotes are stripped.
 *
 * This is the function that makes attribution answerable. "Did the owner say
 * this?" is a question about one message, and every version of it that ranges
 * over the citation list instead is answerable by padding the list.
 */
export function bearingMessage(
  quote: string,
  messages: readonly ProvenanceMessage[],
): ProvenanceMessage | null {
  const normalized = normalizeForMatch(quote);
  if (normalized.length === 0) return null;
  for (const message of messages) {
    if (normalizeForMatch(stripReplyBlockquotes(message.body)).includes(normalized)) return message;
  }
  return null;
}

/** True when nothing is wrong with the receipt. */
export function provenanceIsClean(problems: readonly ProvenanceProblem[]): boolean {
  return problems.length === 0;
}

/** The problems that mean "throw this reading away". */
export function rejectingProblems(problems: readonly ProvenanceProblem[]): ProvenanceProblem[] {
  return problems.filter((problem) => problem.severity === 'reject');
}
