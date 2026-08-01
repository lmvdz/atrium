import { RECEIPT_POLICY, type ReceiptPolicy } from './policy.js';

/**
 * **What may differ between a quote and the text it was taken from.**
 *
 * ## Why this is a policy and not a `.replace()` chain
 *
 * Until r5 one function — `normalizeForMatch` — served two jobs with opposite
 * risk profiles. It decided which model reads a window (routing), and it decided
 * whether a quote and a message are the same text (the receipt). Getting routing
 * wrong costs one model call. Getting the receipt wrong mints something false
 * about a named person. One function cannot be tuned for both, and the version
 * that was tuned for routing was doing measured semantic damage on the receipt
 * path — r4's blind review found three separate cuts:
 *
 * | it deleted            | so this became certifiable                                        |
 * | --------------------- | ----------------------------------------------------------------- |
 * | backticks             | `` `Deploy production Friday.` `` — a sample — as its author's assertion |
 * | link destinations     | `[https://safe.example](https://evil.example)` accepted as naming the safe URL |
 * | NFKC compatibility    | `ｅｖｉｌ.example` and `evil.example` as one hostname               |
 *
 * Each deletion was individually defensible ("a model drops formatting while
 * quoting correctly") and collectively it meant the receipt was comparing two
 * texts neither author wrote.
 *
 * `packages/ingest/src/text.ts` had already answered the same question the other
 * way for message bodies — stored verbatim, because "determinism does not need
 * normalisation" and round 1's NFC pass was lossy. This file makes the core
 * agree with the corpus.
 *
 * ## The shape of the answer
 *
 * Not a list of things to delete. **A list of the differences a quote is allowed
 * to have from its source, each with the argument that admits it.** This is the
 * third arrival of that principle in this repo (`RETRO.md`: denylists of
 * evasions are unbounded; allowlist the compliant forms), and it is the same move
 * `RECEIPT_POLICY.droppableTokens` made for the bearing check.
 *
 * The bar for an entry is the bar r4 set for `droppableTokens`: **an argument
 * nobody can break.** Two candidates failed it and are recorded here so they are
 * not re-added:
 *
 *  - **Case folding.** `US` / `us`, `Bill` / `bill`, `March` / `march` are
 *    different words, and a quote is supposed to be verbatim. A model that
 *    re-cases a sentence has edited it, and an edited reading goes to a person.
 *  - **Underscore emphasis.** `_x_` is Markdown emphasis and `__init__` is an
 *    identifier, and no rule separates them. Asterisk emphasis stays, because
 *    `*` is not an identifier character in anything this product reads.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * Emptiness
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * **Is there anything here at all?** — the one emptiness test, used before every
 * required receipt input.
 *
 * r3's gauntlet, as a polish note that is really a principle: zero-width
 * characters were refused only *incidentally*. `"​"` is not `""`, so it walked
 * past every `trim()` check marked "required" and died three checks later as
 * not-found or too-short. An accidental refusal is one code change away from an
 * accidental acceptance.
 *
 * The fix is not a list of invisible characters — that list is unbounded in
 * exactly the way a stopword list is. It is the complement: **content is a
 * letter, a digit, a pictograph, or a flag.**
 *
 * **The pictograph is r5.** Until r5 this read `[\p{L}\p{N}]`, and a message
 * that is a row of 🚫 reduced to "nothing" — so `proposal.ts` refused it as a
 * *blank quote* and the acceptance engine refused its window as *absent*. Both
 * refusals were right about the outcome and lying about the cause, which is the
 * shape r4's tokenizer defect had with Cyrillic: a failure wearing another
 * failure's clothes. It also contradicted this package's own tokenizer, which
 * has said since r4 that "every script, every mark and every emoji is content".
 * Two answers to "is this text?" in one package is one answer too many.
 *
 * `\p{Regional_Indicator}` is beside it because a flag is not a pictograph:
 * 🇺🇸 is two regional-indicator letters and matches `\p{Extended_Pictographic}`
 * nowhere, so the first draft of this fix still called a flag-only message
 * nothing. Found by the second pass of this round's own blind review, which is
 * the argument for re-running a critic on what it made you change.
 *
 * Everything else — spaces of every width, zero-width joiners, format and
 * control codes, unassigned code points, lone combining marks, punctuation on
 * its own — is still absence, whether or not anybody has enumerated it. A quote
 * of `"…"`, a message body of `"​"`, and `""` are the same fact about the world
 * and get the same answer.
 */
const CONTENTFUL = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

/**
 * True when `text` carries at least one letter, digit or pictograph.
 *
 * A type predicate, and that is r5 too: `tsc` refuses `fix/core-engine-r4` as
 * committed, on two errors this narrowing is half of. `commitmentAttribution`
 * guarded a `string | null | undefined` with `isBlank` and then handed it to a
 * function taking `string`, which reads correctly and does not compile — the
 * guard proves the value is a string and the signature threw the proof away.
 */
export function hasContent(text: string | null | undefined): text is string {
  return text !== null && text !== undefined && CONTENTFUL.test(text);
}

/** `hasContent`, negated — reads better at the gates, which are all refusals. */
export function isBlank(text: string | null | undefined): boolean {
  return !hasContent(text);
}

/* ─────────────────────────────────────────────────────────────────────────
 * The allowlist
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The characters that reorder text rather than disappearing from it: the marks,
 * embeddings, overrides and isolates of the Unicode bidirectional algorithm.
 *
 * **Excluded from the fold, and this round's own blind review is why.** The
 * comment that used to sit below claimed deleting a format character "cannot map
 * two texts a reader sees as *different* onto one — a bidi override that
 * reverses a sentence is deleted, and the reversed bytes stay reversed, so the
 * comparison still refuses." That is confidently wrong, and the reviewer built
 * the input: a message body of `Bob will \u202Eton\u202C deploy production
 * Friday.` **renders as** *"Bob will not deploy production Friday."* Deleting the
 * override normalized the source to `ton`, a quote of `ton` matched it, and the
 * record minted the affirmative of what its author visibly wrote.
 *
 * These are not invisible. They are instructions about what the reader sees, so
 * dropping them is the one thing this file forbids everywhere else: comparing
 * two texts neither author wrote. Kept, they are ordinary tokens, and a quote
 * that omits them is simply not the text in the message.
 */
const BIDI = '\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069';

/**
 * Format and control characters that render as nothing at all, which must not
 * survive into a comparison. `\p{Cf}` covers U+200B–U+200D, U+2060–U+2064,
 * U+00AD and U+FEFF; `\p{Cc}` covers the C0/C1 controls. Whitespace of every
 * width is handled by `\s`, which in JavaScript already includes NBSP, the en/em
 * spaces and U+3000. The bidi set above is subtracted.
 *
 * Admitted because a character with **no rendering at all** cannot carry an
 * assertion: deleting one maps texts a reader sees as identical onto each other.
 * That argument is about characters nobody can see, and it never covered
 * characters that decide the order of the ones they can.
 */
const INVISIBLE = new RegExp(`(?![${BIDI}])[\\p{Cf}\\p{Cc}]`, 'gu');

/**
 * A **paired** run of asterisks around a non-empty span — Markdown emphasis, in
 * the only form Markdown itself accepts.
 *
 * Paired rather than "any asterisk", so `2 * 3 * 4` survives: an unpaired
 * asterisk is arithmetic or a glob, not a typeface. Admitted because emphasis
 * changes how a sentence is set, never who, whether, how many or when.
 */
const PAIRED_EMPHASIS = /(\*{1,3})(?=\S)([\s\S]*?\S)\1/g;

/**
 * `[text](destination)`, and the image form.
 *
 * **The destination is content.** r4's blind review: a message reading
 * `Use [https://safe.example/app](https://evil.example/app) today.` normalized
 * to a sentence naming the *safe* URL, so a statement naming the safe URL was
 * certifiable against a record whose actionable link goes elsewhere. That is a
 * security defect, not a fidelity one — the reader clicks the record, not the
 * statement.
 *
 * So a link normalizes to its text **and** its destination, and the destination
 * only disappears when the text already states it. A statement that drops the
 * destination is then a statement that drops words the quote carries, which is
 * the case `refer` exists for: a person looks at where the link actually goes.
 */
const MARKDOWN_LINK = /!?\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g;

/**
 * Code, in every spelling Markdown gives it: a fence, a double-backtick span, a
 * single-backtick span.
 *
 * Split on rather than folded away, because the prose rules above are wrong
 * inside code — `*` is a glob, `_` is an identifier, `[a](b)` is a literal — and
 * because **the backticks themselves are content**. A backticked span is
 * *mention, not use*: `` `Deploy production Friday.` `` is a string its author
 * displayed, not a sentence its author asserted, and r4's normalization deleted
 * exactly the two characters that carry that distinction. `~~` was excluded from
 * folding in r4 for the same class of reason (strikethrough is retraction, not
 * emphasis); this is that argument applied to the delimiter that separates
 * quoting a thing from saying it.
 */
const CODE_SPAN = /(```[\s\S]*?```|``[\s\S]*?``|`[^`\n]*`)/;

/**
 * The differences a quote may have from the text it was taken from — **and no
 * others.**
 *
 * In order, with the argument that admits each:
 *
 *  1. **Whitespace runs collapse, and the ends are trimmed.** A client wraps a
 *     message and a quote copied out of it carries different line breaks. A run
 *     of horizontal space is not a token in any script.
 *  2. **Characters with no rendering are dropped.** See `INVISIBLE`.
 *  3. **A typographic apostrophe is an apostrophe.** `won’t` and `won't` are one
 *     word entered two ways; treating them as two produces a refusal that has
 *     nothing to do with what was said.
 *  4. **Paired asterisk emphasis may be absent.** See `PAIRED_EMPHASIS`.
 *  5. **A link contributes its destination.** See `MARKDOWN_LINK`.
 *
 * Not admitted, and each one used to be: NFKC compatibility folding, case
 * folding, backtick deletion, underscore emphasis, bare link-text substitution.
 * The header of this file says why.
 */
export function normalizeForReceipt(text: string): string {
  const out: string[] = [];
  for (const [index, segment] of text.split(CODE_SPAN).entries()) {
    // `String.split` with one capture group alternates: prose, delimiter, prose…
    //
    // **A code segment is passed through byte for byte.** Not even the whitespace
    // collapse and the invisible-character drop apply inside one, and that is
    // this round's own blind cross-lineage review: the first draft collapsed
    // whitespace across the whole string after rejoining, so
    // `` `Set the deployment password to `a  b` immediately.` `` and the same
    // sentence with `` `a b` `` compared equal. Two spaces in prose are a line
    // wrap; two spaces in a password are a different password. Every argument in
    // the allowlist above is an argument about *prose*, and none of them survives
    // being carried into a literal.
    const isCode = index % 2 === 1;
    out.push(isCode ? segment : foldProse(segment));
  }
  return out.join('').trim();
}

function foldProse(text: string): string {
  let folded = text.replace(INVISIBLE, '').replace(/[’ʼ]/g, "'");
  // Emphasis nests (`**bold *and italic* **`), so run to a fixed point rather
  // than once. Bounded: every pass removes at least two characters.
  for (let previous = ''; previous !== folded; ) {
    previous = folded;
    folded = folded.replace(PAIRED_EMPHASIS, '$2');
  }
  return folded
    .replace(MARKDOWN_LINK, (_match, label: string, destination: string) => {
      const text = label.trim();
      const target = destination.trim();
      if (target.length === 0) return text;
      // The destination disappears only when the text already states it, so an
      // autolink does not turn into a stutter that nothing can bear.
      return text === target ? text : `${text} ${target}`;
    })
    .replace(/\s+/g, ' ');
}

/**
 * The lossy normalization, for the questions where being lossy is the safe
 * direction: **which model reads this window**, and **is this reading a
 * duplicate of one the room already accepted**.
 *
 * Everything `normalizeForReceipt` refuses to do is done here, on purpose. A
 * trigger that fires on a fullwidth spelling costs one model call. A dedup that
 * treats `Deploy` and `deploy` as one word discards a re-proposal, which is what
 * it is for. Neither can mint a fact, and `escalation.ts` states in its own
 * stopword comment that the routing list "has not decided whether a reading
 * becomes a fact since r4, and it must never do so again".
 *
 * The one call this makes on the receipt path is the later-correction scan, and
 * it is deliberate: that scan is a *detector*, its false positives cost a
 * referral rather than an acceptance, so it wants the loose comparison.
 */
export function normalizeForRouting(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[’ʼ]/g, "'")
    .replace(MARKDOWN_LINK, '$1')
    .replace(/[*_`]+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ─────────────────────────────────────────────────────────────────────────
 * Tokens and sentences
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * A word in any script: letters, digits and combining marks, with apostrophes
 * *inside* it. Anything else visible is one token of its own.
 *
 * The alternation is the whole design. r4's first version split on
 * `/[^a-z0-9']+/`, which is a **denylist of the characters that may carry
 * meaning** wearing a tokenizer's clothes, and r4's own blind review walked
 * through it four ways in one pass: `Bob will ｎｏｔ deploy` (fullwidth — not
 * `[a-z]`, so deleted), `Bob will не deploy` (Cyrillic — deleted), `❌ Bob will
 * deploy` (emoji — deleted), and `Bob will deploy Friday?` (the question mark —
 * deleted). Each one bore its own affirmative and auto-accepted. A Russian
 * sentence, meanwhile, tokenized to *nothing at all* and was refused as empty.
 *
 * So the rule is inverted: a token is a word, or it is a visible character, and
 * `RECEIPT_POLICY.droppableTokens` is the only thing that may go missing.
 */
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:'[\p{L}\p{N}\p{M}]+)*|[^\s']/gu;

/**
 * Every token of a text, in the order it was written.
 *
 * Deliberately unlike `contentTokens` in all four ways that matter, and each
 * one is a defect the gauntlets exploited or could have:
 *
 *  - **No stopword list.** `not`, `all`, `some`, `will`, `might`, `unless` and
 *    every word nobody has thought of yet are content here. There is no list to
 *    get wrong because there is no list.
 *  - **No de-duplication.** "not not" is two tokens. A `Set` cannot tell double
 *    negation from single.
 *  - **No length floor.** `no` is two characters and inverts a sentence.
 *  - **No character class of "real" words.** Every script, every mark and every
 *    emoji is content; see `TOKEN`.
 *
 * Apostrophes are kept *inside* a word, so `won't` is one token and is not
 * `will`. A standalone apostrophe is dropped rather than tokenized — it is a
 * quotation mark, `'online'` is the word `online`, and an apostrophe cannot
 * negate, quantify, or change a modal.
 */
export function orderedTokens(text: string): string[] {
  return normalizeForReceipt(text).match(TOKEN) ?? [];
}

/** `orderedTokens` under the lossy fold — for detectors, never for a receipt. */
export function routingTokens(text: string): string[] {
  return normalizeForRouting(text).match(TOKEN) ?? [];
}

/**
 * A text split into sentences: on a terminator followed by space, or a newline.
 *
 * Deliberately crude, and crude in the safe direction — it splits *less* than a
 * linguist would (an abbreviation keeps its sentence whole), and every check
 * that uses it requires the quote to cover whole sentences, so under-splitting
 * can only make that harder to satisfy.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…。？！])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Does the quote bear the statement?
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * What the bearing check found. **`borne` is the only affirmative answer** —
 * every other shape of this result is a refusal, and the two lists say which
 * refusal it is.
 */
export interface StatementBearing {
  /**
   * True only when the statement is the quote with nothing removed but
   * `RECEIPT_POLICY.droppableTokens`, in the order it was written.
   */
  borne: boolean;
  /** Tokens the statement asserts that the quote does not contain, in order. */
  unmatchedInStatement: string[];
  /** Tokens the quote contains that the statement drops, in order. */
  unmatchedInQuote: string[];
  /** Set when the check declined to run at all, rather than running and failing. */
  undecidable: 'empty_quote' | 'empty_statement' | 'too_long' | null;
}

const declined = (undecidable: StatementBearing['undecidable']): StatementBearing => ({
  borne: false,
  unmatchedInStatement: [],
  unmatchedInQuote: [],
  undecidable,
});

/**
 * The alignment itself, over tokens somebody else produced.
 *
 * Split out from `statementBearing` in r5 so the later-correction detector can
 * run the same comparison over *routing* tokens without a second implementation
 * of the alignment. One alignment, two tokenizations, and the caller says which
 * — rather than two alignments that can drift.
 *
 * Greedy, with a one-sided lookahead so a single extra word resynchronises
 * instead of scrambling the rest of the comparison. Deterministic, total, and
 * bounded by `RECEIPT_POLICY.maxAlignedTokens` — an input too big to align is
 * refused, not approximated.
 */
export function alignTokens(
  q: readonly string[],
  s: readonly string[],
  policy: ReceiptPolicy = RECEIPT_POLICY,
): StatementBearing {
  if (q.length === 0) return declined('empty_quote');
  if (s.length === 0) return declined('empty_statement');
  if (q.length > policy.maxAlignedTokens || s.length > policy.maxAlignedTokens) {
    return declined('too_long');
  }

  const droppable = (token: string | undefined): boolean =>
    token !== undefined && policy.droppableTokens.has(token);

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
    // A full stop on either side may be skipped silently — that is the entire
    // licence this check grants, and `droppableTokens` says why.
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

/**
 * **Is the asserted statement a word-for-word reduction of this quote?**
 *
 * ## What this proves, stated in the terms it actually holds
 *
 * `borne === true` means exactly one thing, and it is worth writing out because
 * the check it replaced claimed something it could not deliver:
 *
 * > Every token of the statement appears in the quote, in the same order, and
 * > every token of the quote appears in the statement, in the same order, except
 * > for the full stop in `RECEIPT_POLICY.droppableTokens`. A token is a word in
 * > any script, or a visible mark, after the differences `normalizeForReceipt`
 * > admits.
 *
 * That is a **structural** claim about two strings. It is not entailment, and
 * nothing here can establish entailment — but combined with the checks around it
 * (the quote is the whole of a cited author's own text in a message no later
 * message revisits, and it is written by exactly one identifiable person) it
 * supports the sentence the product actually needs to be able to say: *the
 * sentence being asserted is one somebody in this room wrote, in these words,
 * and nothing around it in the record changes it.*
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
 */
export function statementBearing(
  quote: string,
  statement: string,
  policy: ReceiptPolicy = RECEIPT_POLICY,
): StatementBearing {
  if (isBlank(quote)) return declined('empty_quote');
  if (isBlank(statement)) return declined('empty_statement');
  return alignTokens(orderedTokens(quote), orderedTokens(statement), policy);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Where the scissors may cut
 * ───────────────────────────────────────────────────────────────────────── */

/** The quote's tokens, with the ones a receipt may lose taken out. */
function significant(text: string, policy: ReceiptPolicy): string[] {
  return orderedTokens(text).filter((token) => !policy.droppableTokens.has(token));
}

const sameRun = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((token, index) => token === b[index]);

/**
 * **Is the quote a run of whole sentences of this text, rather than a span cut
 * out of the middle of one?**
 *
 * r4's own blind review found the defect this exists for. Making the *statement
 * vs quote* comparison exact does nothing if the *quote vs message* relation is
 * still "any substring", because the model chooses the span:
 *
 * | message body                                              | quote = statement                         |
 * | --------------------------------------------------------- | ----------------------------------------- |
 * | It is not true that Bob will deploy production Friday …    | Bob will deploy production Friday …       |
 * | Nobody thinks Bob will deploy production Friday this week   | Bob will deploy production Friday this week |
 * | I doubt Bob will deploy production Friday this coming week  | Bob will deploy production Friday this coming week |
 *
 * Every one of those quotes is verbatim, correctly attributed, long enough, and
 * borne word-for-word by its own statement — because the inverter was left
 * outside the span. Quote-mining is the same defect as the stopword list with
 * the scissors moved.
 *
 * This answers the narrower of the two questions r5 asks about the scissors;
 * `quoteCoversOwnText` answers the other one, and the two report different
 * problems because they tell a reader different things about the receipt.
 */
export function quoteSpansWholeSentences(
  quote: string,
  ownText: string,
  policy: ReceiptPolicy = RECEIPT_POLICY,
): boolean {
  const wanted = significant(quote, policy);
  if (wanted.length === 0) return false;

  const sentences = sentencesOf(ownText);
  // Bounded, and refusing rather than degrading, for the same reason the
  // alignment is: the body is somebody else's input.
  if (sentences.length > policy.maxScannedSentences) return false;
  const tokenized = sentences.map((sentence) => significant(sentence, policy));

  for (let start = 0; start < tokenized.length; start += 1) {
    const run: string[] = [];
    for (let end = start; end < tokenized.length; end += 1) {
      run.push(...(tokenized[end] ?? []));
      if (run.length > wanted.length) break;
      if (run.length === wanted.length && sameRun(run, wanted)) return true;
    }
  }
  return false;
}

/**
 * **Is the quote the whole of what this author wrote here?**
 *
 * ## The residue r4 documented and then accepted anyway
 *
 * r4 closed the scissors *inside* a sentence and wrote the leftover down in its
 * own prose: *"polarity that lives in a different sentence ('I will deploy
 * Friday. Not.') is not visible to this and is not visible to any span rule …
 * it is why the guarantee is written as 'somebody wrote this sentence', not
 * 'somebody meant it'."*
 *
 * Every word of that is true and the code auto-accepted the sentence anyway,
 * while the same round built the third severity the case needs. A limit written
 * into a comment changes nothing about what the program does with an input that
 * lands in it. So the limit is now a disposition: an input inside it is
 * **referred**.
 *
 * ## Why the rule is "all of it" and not a list of inverters
 *
 * The obvious fix is to look at the neighbouring sentence for the things that
 * change the force of the quoted one — a negation, `unless`, `if`, `was going
 * to`, `instead`, a question mark, a retraction verb. That is a denylist, it is
 * unbounded by construction, and this repo has now paid for that lesson three
 * times (`RETRO.md`). Each candidate allowlist was tried and each one leaves the
 * model holding the scissors:
 *
 * | candidate                                            | breaks on                                  |
 * | ---------------------------------------------------- | ------------------------------------------ |
 * | neighbour must be ≥ n words                          | `Unless CI is red.`                        |
 * | neighbour must end in a full stop                    | `Not.`                                     |
 * | neighbour must not open with a linking word          | a denylist of linking words, unbounded     |
 * | quote must reach the end of the text                 | `Hypothetically. We will deploy Friday.`   |
 *
 * The only form with no scissors left in it is the one this function checks:
 * **the quote is the entirety of the author's own text in the bearing message**
 * (reply-blockquotes already removed, since those are somebody else's words).
 * Then there is no neighbouring sentence, so there is nothing for a neighbouring
 * sentence to do, and the guarantee strengthens from *somebody wrote this
 * sentence* to *somebody wrote this message and it says exactly this*.
 *
 * The cost is stated rather than hidden, and it is large: a reading drawn from
 * one sentence of a multi-sentence message is no longer auto-acceptable. It is
 * not discarded — it is `refer`, so it stays staged with its quote beside its
 * statement for a person to read, which is the disposition the whole third
 * severity exists for.
 */
export function quoteCoversOwnText(
  quote: string,
  ownText: string,
  policy: ReceiptPolicy = RECEIPT_POLICY,
): boolean {
  const wanted = significant(quote, policy);
  if (wanted.length === 0) return false;
  return sameRun(significant(ownText, policy), wanted);
}

/**
 * **Is this text offered as an assertion?**
 *
 * A question quoted verbatim is an OpenQuestion or a referral, never a Claim.
 * Until r5 nothing asked: `objects.ts` requires a nonempty string and the
 * receipt proves string equality, so `"Would we deploy production Friday?"`
 * minted as a `claim` with an identical quote auto-accepted — the receipt was
 * perfect and the reading turned somebody's question into their position.
 *
 * The test is the mark, and it is the same argument `RECEIPT_POLICY`'s
 * `droppableTokens` makes for keeping `?` out of the set it will forgive:
 * *"Bob will deploy Friday?" is a question and minting it as an assertion is the
 * same defect in different clothes.* Here the mark is read rather than compared.
 *
 * ## The limit, and what the code does with an input inside it
 *
 * Deliberately only the mark. An interrogative without one — *"I wonder whether
 * we should deploy production Friday."* — reads as an assertion to any string
 * check, and inventing a grammar to catch it would be the guess this file
 * refuses to make everywhere else. That input **auto-accepts**, and this is
 * stated as a disposition rather than as a residue, because r4 was failed for
 * writing a limit down and leaving the disposition wrong:
 *
 * By the time anything reaches here, `quoteCoversOwnText` has established that
 * the statement is **the whole of one message, verbatim, by an identified
 * author**. So the object this limit admits is a real sentence somebody wrote,
 * filed under the wrong type — a mis-typed `claim` where an `open_question`
 * belonged. That is a different class from the ones this file exists to refuse:
 * the record does not attribute to anybody a sentence they did not write, and
 * the recovery is the ordinary one (a person re-types it, and #5/#17's
 * correction-rate telemetry counts it), rather than a false statement nobody can
 * see is false.
 *
 * What is claimed is exactly what is checked: **a sentence carrying a question
 * mark is not an assertion.**
 *
 * ## Which characters are question marks
 *
 * This round's own blind review: the first draft compared tokens against the
 * ASCII `?` alone, and `Would we deploy production Friday？` — U+FF1F, the
 * fullwidth form — was minted as a claim. Removing NFKC from the receipt fold
 * was right (it made distinct hostnames compare equal) and it left this check
 * reading one spelling of a mark that has several.
 *
 * The fix is NFKC **here**, and the distinction is the point: the receipt asks
 * *are these two texts the same*, where compatibility folding destroys evidence;
 * this asks *what kind of character is this*, which is exactly what compatibility
 * folding answers. NFKC maps U+FF1F, U+FE56 and the ligatures U+2047–U+2049 onto
 * `?`. `QUESTION_MARKS` then carries the ones Unicode gives no decomposition —
 * a **closed, published inventory**, not an open-ended list of things somebody
 * might try, which is the distinction `RETRO.md` draws between an enumeration
 * that is safe and one that is not. `¿` is on it because a Spanish interrogative
 * opens with one and need carry no other mark at all — the review's second pass
 * found that omission after its first pass found the fullwidth form, which is
 * the argument for running the critic again after fixing what it found.
 */
const QUESTION_MARKS = /[?¿؟፧⸮꘏\u{11143}]/u;

export function isAssertion(text: string): boolean {
  return !QUESTION_MARKS.test(text.normalize('NFKC'));
}
