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
 *    identifier, and no rule separates them.
 *  - **Asterisk emphasis**, which survived three drafts and two reviewers before
 *    the bar caught up with it. It was admitted on the argument that emphasis
 *    "changes how a sentence is set, never who, whether, how many or when", and
 *    the spike measured a real cost for refusing it — three of eight apparent
 *    provenance failures were a model dropping `**` while quoting correctly.
 *    Then codex folded `a*b*c` to `abc`, and grok folded `2*3*4` to `234` —
 *    which changes **how many**, in the one direction the justification promised
 *    it could not. A word-boundary-flanking rule fixed both and left `*.ts*` in
 *    a glob. Every repair was narrower than the last, which is the signature of
 *    an entry that does not meet the bar: *an argument nobody can break*. Three
 *    of the four entries r4 put in `droppableTokens` went the same way, for the
 *    same reason.
 *
 *    The cost is now small, because `quoteCoversOwnText` changed what a quote
 *    is: it must be the whole message body, so a model reproducing that body
 *    verbatim carries the `**` with it and is unaffected. Only a model that
 *    *strips* formatting is refused, and a model that strips formatting has
 *    edited the text.
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
 * **The characters this fold deletes — enumerated, not subtracted.**
 *
 * This entry took three passes of blind review to get right, and the shape of
 * each failure is the same one `RETRO.md` keeps recording.
 *
 *  - r4 deleted `\p{Cf}` wholesale, on the argument that a character with no
 *    rendering cannot carry an assertion. A **bidi override** breaks it: a body
 *    of `Bob will ‮ton‬ deploy production Friday.` *renders as* "Bob
 *    will not deploy production Friday.", and deleting the override let a quote
 *    of `ton` match — the record minting the affirmative of what its author
 *    visibly wrote.
 *  - r5's first repair subtracted the bidi set from `\p{Cf}`, which is a
 *    **denylist of the exceptions somebody has thought of**, and the next pass
 *    produced two more: `re­sign` (a soft hyphen, which renders as a hyphen
 *    at a line break — *re-sign* is not *resign*) and `👩‍💻` versus
 *    `👩💻` (a zero-width joiner, which decides whether two emoji are one
 *    glyph).
 *
 * Both fixes were subtraction, and subtraction from a Unicode category is
 * unbounded in exactly the way a stopword list is. So this is the other kind of
 * list: **the characters whose removal provably cannot change what a reader
 * sees**, each named.
 *
 *  - `U+200B` ZERO WIDTH SPACE — r3's gauntlet, the reason any of this exists:
 *    a zero-width space spliced into a quote made it a different string from the
 *    message it came out of. It permits a line break and paints nothing.
 *  - `U+2060` WORD JOINER, and `U+2061`–`U+2064` the invisible mathematical
 *    operators — no glyph, no shaping effect, no joining behaviour.
 *  - `U+FEFF` ZERO WIDTH NO-BREAK SPACE / byte-order mark.
 *
 * Everything else that used to be swept up here — the bidi marks, embeddings,
 * overrides and isolates; the soft hyphen; the zero-width joiner and
 * non-joiner — is **content**, because it changes the glyphs a reader sees or
 * the order they see them in. Kept, they are ordinary tokens, and a quote that
 * omits them is simply not the text that is in the message.
 *
 * ## The control characters are gone from this list, and r6 is why
 *
 * Until r6 there was a second clause, `(?!\s)\p{Cc}`, with a docblock arguing
 * that it could not fuse two words because "Tab, newline, vertical tab, form
 * feed, carriage return **and NEL** are `\s`, and the whitespace rule already
 * owns them".
 *
 * **JavaScript's `\s` does not contain U+0085 NEL.** ECMA-262 defines `\s` as
 * *WhiteSpace* ∪ *LineTerminator*, and NEL is in neither — it is `Cc`, it is not
 * `Zs`, and it is not a LineTerminator. Nor are U+007F or U+0080–U+009F. The
 * clause therefore deleted them, and NEL is a Unicode **mandatory line break**
 * (UAX #14 class BK), so deleting it changes what a reader sees — the exact bar
 * this list is written to. `Bob will deploy<NEL>production Friday.` normalized to
 * `deployproduction`, a quote of the fused text matched it, and the receipt was
 * clean. The comment was false about the *language*, not about the code, which
 * is the one kind of comment no amount of re-reading the code will catch.
 *
 * Two repairs followed, and only the second is a rule:
 *
 *  1. Subtract the missing characters — `(?![\t\n\v\f\r ])\p{Cc}` — which is a
 *     denylist of the controls somebody has checked, and is wrong for U+0085 in
 *     exactly the same way.
 *  2. **Stop subtracting.** This list is now nothing but its enumeration, and
 *     the whitespace rule below reads `\p{White_Space}` — Unicode's own
 *     published inventory, which *does* contain U+0085 — instead of `\s`. Every
 *     other control is content: kept, tokenized, and unable to fuse anything.
 *
 * The resulting set is enumerated by brute force over U+0000–U+10FFFF in
 * `residue.test.ts` ("deletes exactly this set of code points and no others"),
 * because a comment asserting a property of the language is a factual claim and
 * must be measured rather than reasoned about.
 */
const DELETABLE = /[\u200B\u2060\u2061\u2062\u2063\u2064\uFEFF]/gu;

/**
 * **What counts as whitespace** — Unicode's own `White_Space` property, not
 * JavaScript's `\s`.
 *
 * The two differ, and the difference is r6's second major finding. `\s` is
 * *WhiteSpace* ∪ *LineTerminator* per ECMA-262, which adds U+FEFF (deleted
 * above, before this ever runs) and, crucially, **omits U+0085 NEL** — a
 * mandatory line break that every renderer breaks on. A run-collapsing rule that
 * cannot see NEL leaves a line break inside a "word", and the fold that tried to
 * compensate deleted it instead and fused the words either side.
 *
 * `\p{White_Space}` is a closed, published list, which is the distinction
 * `RETRO.md` draws between an enumeration that is safe and one that is not.
 */
const WHITESPACE_RUN = /\p{White_Space}+/gu;

/** One token that is nothing but whitespace. See `orderedTokens`. */
const WHITESPACE_TOKEN = /^\p{White_Space}+$/u;

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
 *     of horizontal space is not a token in any script. "Whitespace" is
 *     `\p{White_Space}` and not `\s`; `WHITESPACE_RUN` says why the difference
 *     cost a round.
 *  2. **Characters with no rendering are dropped.** See `DELETABLE`.
 *  3. **A typographic apostrophe is an apostrophe.** `won’t` and `won't` are one
 *     word entered two ways; treating them as two produces a refusal that has
 *     nothing to do with what was said.
 *  4. **A link contributes its destination.** See `MARKDOWN_LINK`.
 *
 * Four entries. Not admitted, and each one used to be: NFKC compatibility
 * folding, case folding, backtick deletion, underscore emphasis, **asterisk
 * emphasis**, and bare link-text substitution. The header of this file says why.
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
  const folded = text.replace(DELETABLE, '').replace(/[’ʼ]/g, "'");
  return folded
    .replace(MARKDOWN_LINK, (_match, label: string, destination: string) => {
      const text = label.trim();
      const target = destination.trim();
      if (target.length === 0) return text;
      // The destination disappears only when the text already states it, so an
      // autolink does not turn into a stutter that nothing can bear.
      return text === target ? text : `${text} ${target}`;
    })
    .replace(WHITESPACE_RUN, ' ');
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
  return (
    text
      .normalize('NFKC')
      .replace(/[’ʼ]/g, "'")
      // **The same link policy the receipt uses, and r5's third review pass is
      // why.** This fold used to collapse `[text](destination)` to its text, and
      // `laterRevision` runs over it — so a later message that changed only the
      // *destination* of a link ("Use [https://safe.example/app](https://evil.example/app)
      // …" after "Use https://safe.example/app …") reduced to the same tokens as
      // the one before it and did not read as a revision. A destination is content
      // wherever it appears; there is one answer to that question now, not two.
      .replace(MARKDOWN_LINK, (_m, label: string, destination: string) => {
        const label_ = label.trim();
        const target = destination.trim();
        return target.length === 0 || label_ === target ? label_ : `${label_} ${target}`;
      })
      .replace(/[*_`]+/g, ' ')
      .replace(DELETABLE, '')
      .replace(WHITESPACE_RUN, ' ')
      .trim()
      .toLowerCase()
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Tokens and sentences
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * A word in any script: letters, digits and combining marks, with apostrophes
 * *inside* it. **Every other single code point is one token of its own** —
 * including the spaces between words and a standalone apostrophe.
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
 * So the rule is inverted: a token is a word, or it is a code point, and
 * `RECEIPT_POLICY.droppableTokens` is the only thing that may go missing.
 *
 * ## `[\s\S]` and not `[^\s']`, which is r6's first finding
 *
 * r4 fixed the *character class* of the denylist and left the denylist. The
 * second alternative was `[^\s']`, so the tokenizer **discarded all whitespace
 * and every standalone ASCII apostrophe** — and the token comparison is the only
 * comparison the acceptance path makes between a quote and the statement being
 * minted from it. Four inputs auto-accepted with a `payload.statement` its named
 * author never wrote:
 *
 * | body, quoted verbatim                                | minted statement                          |
 * | ---------------------------------------------------- | ----------------------------------------- |
 * | ``Run `rm -rf / tmp/cache` on the box tonight.``      | ``Run `rm -rf /tmp/cache` on the box tonight.`` |
 * | ``Set the password to `a  b` today, everyone.``       | ``Set the password to `a b` today, everyone.``  |
 * | `We will deploy production Friday, promise.`          | `We will 'deploy' production 'Friday', promise.` |
 * | `'We will deploy production Friday.'`                 | the same sentence, as an assertion        |
 *
 * The first two are `normalizeForReceipt`'s own named counterexample: it passes
 * a code segment through byte for byte precisely because *two spaces in a
 * password are a different password* — and it was correct, and **nothing at the
 * comparison consulted it**. The last two are the mention/use distinction:
 * backticks and double quotes are content and were refused, and the plain
 * apostrophe was invisible, so `'…'` fell through while `‘…’` survived only
 * because `’` folds to `'` and vanished and `‘` did not. Failing closed by luck
 * is not a rule.
 *
 * The repair is not a longer character class. It is the property that makes the
 * claim checkable: **the token stream reassembles the text it came from.**
 * `orderedTokens(t).join('') === normalizeForReceipt(t)` for every `t`, which
 * `bearing.test.ts` pins over a corpus and over brute-forced code points, and
 * from which `borne ⇒ the statement is the quote` follows rather than being
 * asserted in a comment.
 */
const WORD = String.raw`[\p{L}\p{N}\p{M}]+(?:'[\p{L}\p{N}\p{M}]+)*`;
const TOKEN = new RegExp(String.raw`${WORD}|[\s\S]`, 'gu');

/**
 * The detector's tokenizer: the same word rule, **minus the whitespace**.
 *
 * One difference from `TOKEN`, written as one difference rather than as a second
 * regex, and it is not a relaxation of the receipt — it is the shape of the two
 * questions. `routingTokens` runs over `normalizeForRouting`, which has already
 * collapsed every whitespace run to a single space and deleted the markdown, so
 * a space token there carries no information at all. Carrying it anyway
 * **measurably broke the correction scan**: an inserted word arrives with an
 * inserted space, so `laterRevision` comparing *"We will not deploy production
 * Friday."* against *"We will deploy production Friday."* resynchronised on the
 * space instead of on the word, reported a difference on both sides, and read a
 * plain contradiction as an unrelated sentence.
 *
 * The receipt tokenizer cannot make that trade, because there the spacing *is*
 * the content — see `TOKEN`.
 */
const ROUTING_TOKEN = new RegExp(String.raw`${WORD}|\S`, 'gu');

/**
 * Every token of a text, in the order it was written, **losing nothing**.
 *
 * Deliberately unlike `contentTokens` in all five ways that matter, and each
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
 *  - **Nothing is discarded at all.** Not the spaces, not a lone apostrophe.
 *    `join('')` reconstructs `normalizeForReceipt(text)` exactly, so two equal
 *    token streams are two equal texts — which is what the receipt claims and,
 *    until r6, was not what it proved.
 *
 * Apostrophes are kept *inside* a word, so `won't` is one token and is not
 * `will`. A standalone apostrophe is its own token: `'online'` is three tokens,
 * because the marks that turn a sentence into a quotation of a sentence are the
 * same marks the backtick rule already calls content.
 */
export function orderedTokens(text: string): string[] {
  return normalizeForReceipt(text).match(TOKEN) ?? [];
}

/** True when a token is nothing but whitespace. See `alignTokens`. */
export function isWhitespaceToken(token: string): boolean {
  return WHITESPACE_TOKEN.test(token);
}

/** `orderedTokens` under the lossy fold — for detectors, never for a receipt. */
export function routingTokens(text: string): string[] {
  return normalizeForRouting(text).match(ROUTING_TOKEN) ?? [];
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
 * every other shape of this result is a refusal, and the three fields beside it
 * say which refusal it is.
 */
export interface StatementBearing {
  /**
   * True only when the statement is the quote with nothing removed but
   * `RECEIPT_POLICY.droppableTokens`, in the order it was written — **and,
   * since r6, that is a fact about the two texts and not only about their
   * words.** `orderedTokens` loses nothing, so equal non-droppable token
   * streams and equal spacing is equal text.
   *
   * The invariant that keeps this honest: `borne` is true exactly when all three
   * of `unmatchedInQuote`, `unmatchedInStatement` and `whitespaceDiffers` are
   * empty/false. A caller that reads the two lists and not the flag would fail
   * open on a re-spaced code literal, so `escalation.ts` branches on `borne`
   * first and names every way it can be false.
   */
  borne: boolean;
  /** Non-whitespace tokens the statement asserts that the quote does not contain, in order. */
  unmatchedInStatement: string[];
  /** Non-whitespace tokens the quote contains that the statement drops, in order. */
  unmatchedInQuote: string[];
  /**
   * **At least one space could not be paired.**
   *
   * Kept out of the two lists because a refusal that reads *the quote says `" "`*
   * is a refusal nobody can act on. It is set as collateral whenever words differ
   * too — an inserted word arrives with an inserted space — so it is *decisive*
   * only when the two lists are empty, and `escalation.ts` reads the three in
   * that order. When it is decisive it means something specific: prose spacing is
   * collapsed to one space on both sides before anything is compared, so the
   * difference is inside a code span, which is a different literal rather than a
   * different line wrap.
   */
  whitespaceDiffers: boolean;
  /** Set when the check declined to run at all, rather than running and failing. */
  undecidable: 'empty_quote' | 'empty_statement' | 'too_long' | null;
}

const declined = (undecidable: StatementBearing['undecidable']): StatementBearing => ({
  borne: false,
  unmatchedInStatement: [],
  unmatchedInQuote: [],
  whitespaceDiffers: false,
  undecidable,
});

const sameRun = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((token, index) => token === b[index]);

/**
 * **The droppable tokens taken out, and the spacing they were holding open
 * closed behind them.**
 *
 * `droppableTokens` holds one entry, `.`, and the licence it grants is *a full
 * stop may differ*. Taking the mark out and leaving its neighbours untouched
 * does not grant that licence — it grants a narrower and stranger one, because
 * the spaces around the mark are tokens now. r6's first draft skipped the mark
 * inside the alignment loop and left the spaces, so
 *
 *     quote:     "While TypeScript is correct that ... after line 6"
 *     statement: "While TypeScript is correct that after line 6"
 *
 * came back as *the same words, spaced differently* — the ellipsis was forgiven
 * three times over as three full stops, and the space it had been sitting in was
 * reported as a re-spaced code literal. A true finding with a false reason
 * attached, which is the defect class this round is for.
 *
 * So the removal happens once, up front, on both streams: drop the droppable
 * tokens, and where dropping one leaves two spaces adjacent — or a space at
 * either end, which the input could not have had, since `normalizeForReceipt`
 * trims — close the gap. Nothing else is touched: `` `a  b` `` keeps both of its
 * spaces, because no mark was removed between them.
 */
function stripDroppable(tokens: readonly string[], policy: ReceiptPolicy): string[] {
  const out: string[] = [];
  let removed = false;
  for (const current of tokens) {
    if (policy.droppableTokens.has(current)) {
      removed = true;
      continue;
    }
    const previous = out[out.length - 1];
    const closesAGap =
      removed &&
      isWhitespaceToken(current) &&
      previous !== undefined &&
      isWhitespaceToken(previous);
    removed = false;
    if (closesAGap) continue;
    out.push(current);
  }
  // A removal at either end leaves the space that was next to it exposed. The
  // input was trimmed, so any whitespace here came from the removal.
  while (out.length > 0 && isWhitespaceToken(out[out.length - 1] as string)) out.pop();
  while (out.length > 0 && isWhitespaceToken(out[0] as string)) out.shift();
  return out;
}

/**
 * The alignment itself, over tokens somebody else produced.
 *
 * Split out from `statementBearing` in r5 so the later-correction detector can
 * run the same comparison over *routing* tokens without a second implementation
 * of the alignment. One alignment, two tokenizations, and the caller says which
 * — rather than two alignments that can drift.
 *
 * Deterministic, total, and bounded by `RECEIPT_POLICY.maxAlignedTokens` — an
 * input too big to align is refused, not approximated.
 *
 * ## The verdict and the diagnosis are computed separately, and r6 is why
 *
 * `borne` is `sameRun` over the two streams with `stripDroppable` applied: two
 * lists of tokens, equal length, equal element by element. That is the whole
 * definition, it is a total function of the inputs, and no heuristic reaches it.
 *
 * The three fields beside it are a **diagnosis** — greedy, with a one-sided
 * lookahead so that one interposed word ("not") is reported as one interposed
 * word instead of knocking every later token out of alignment. A resynchronising
 * diff is a judgement call about which tokens correspond, and until r6 that
 * judgement call *was* the verdict: `borne` was "the diff found nothing", so any
 * way the diff could be fooled was a way the receipt could be fooled. Now it
 * only decides what the refusal says.
 *
 * The two cannot disagree in the affirmative direction — an elementwise-equal
 * pair produces an empty diff — and if they ever disagree the other way,
 * `escalation.ts` has a named problem for it rather than a silent pass.
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

  const quote = stripDroppable(q, policy);
  const statement = stripDroppable(s, policy);

  const unmatchedInQuote: string[] = [];
  const unmatchedInStatement: string[] = [];
  let whitespaceDiffers = false;
  /**
   * One token the diff could not pair. Whitespace sets the flag; every other
   * token is named in its list. The split is about what the refusal *says* —
   * a refusal reading *the quote says `" "`* is one nobody can act on — and it
   * cannot change the verdict, which is `sameRun` above.
   */
  const unaccounted = (token: string, into: string[]): void => {
    if (isWhitespaceToken(token)) whitespaceDiffers = true;
    else into.push(token);
  };
  let i = 0;
  let j = 0;

  while (i < quote.length && j < statement.length) {
    const qt = quote[i];
    const st = statement[j];
    if (qt === st) {
      i += 1;
      j += 1;
      continue;
    }
    // **A space never drives the resynchronisation.** The lookahead below asks
    // "can this token still be matched later", and a space can always be matched
    // later, so a stream with spaces in it made the diff ping-pong: a substituted
    // word was reported, then the space after it dragged a word off the other
    // side, and the two chased each other to the end of the sentence.
    // `we ship on Friday afternoon` vs `we ship it on Friday afternoon` named
    // `it`, `on` and `Friday` instead of `it`. Spacing that could not be paired
    // is recorded and stepped over; only real tokens steer.
    if (qt !== undefined && isWhitespaceToken(qt) && st !== undefined && !isWhitespaceToken(st)) {
      whitespaceDiffers = true;
      i += 1;
      continue;
    }
    if (st !== undefined && isWhitespaceToken(st) && qt !== undefined && !isWhitespaceToken(qt)) {
      whitespaceDiffers = true;
      j += 1;
      continue;
    }
    // A real disagreement. Resynchronise towards whichever side can still be
    // matched, so one interposed word ("not") is reported as one interposed word
    // rather than knocking every later token out of alignment.
    if (st !== undefined && quote.indexOf(st, i + 1) !== -1) {
      if (qt !== undefined) unaccounted(qt, unmatchedInQuote);
      i += 1;
    } else {
      if (st !== undefined) unaccounted(st, unmatchedInStatement);
      j += 1;
    }
  }

  // Whatever is left over on either side is unaccounted for — a trailing
  // "unless CI is red" is exactly this case, and it is why the tail is not
  // forgiven.
  for (; i < quote.length; i += 1) {
    const leftover = quote[i];
    if (leftover !== undefined) unaccounted(leftover, unmatchedInQuote);
  }
  for (; j < statement.length; j += 1) {
    const leftover = statement[j];
    if (leftover !== undefined) unaccounted(leftover, unmatchedInStatement);
  }

  return {
    borne: sameRun(quote, statement),
    unmatchedInStatement,
    unmatchedInQuote,
    whitespaceDiffers,
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
 * > any script, or **any single code point** — a mark, a space, an apostrophe —
 * > after the differences `normalizeForReceipt` admits.
 *
 * ## Which is to say: the statement *is* the quote
 *
 * That sentence was in this docblock before r6 and was not true of the code.
 * The tokenizer discarded whitespace and standalone apostrophes, and this
 * comparison is the only one the acceptance path makes between the quote and the
 * statement being minted — so ``Run `rm -rf / tmp/cache` …`` bore ``Run `rm -rf
 * /tmp/cache` …``, and `We will deploy production Friday, promise.` bore `We
 * will 'deploy' production 'Friday', promise.` `TOKEN` has the table.
 *
 * It is true now, and it is true *by construction* rather than by inspection:
 * `orderedTokens` is exhaustive, so `join('')` rebuilds the normalized text, so
 * two token streams that are equal after removing droppable tokens are two texts
 * that are equal after removing droppable tokens. `bearing.test.ts` pins the
 * reassembly property directly, which is the assertion that carries all of this.
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

/**
 * The quote's tokens, with the ones a receipt may lose taken out — **and the
 * spacing between them.**
 *
 * The two functions below ask *which marks, in which order*, over a text that
 * has been cut into sentences and reassembled; the cut throws the whitespace
 * between two sentences away, so comparing spacing here would compare an
 * artefact of the splitter. Spacing fidelity is proved twice elsewhere and
 * neither proof runs through here: `alignTokens` reports `whitespaceDiffers`
 * between the quote and the statement, and `validateProposalProvenance` requires
 * the quote to occur in the message body **verbatim** under
 * `normalizeForReceipt`, which passes code spans through byte for byte.
 */
function significant(text: string, policy: ReceiptPolicy): string[] {
  return orderedTokens(text).filter(
    (token) => !policy.droppableTokens.has(token) && !isWhitespaceToken(token),
  );
}

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
 * **the quote is the entirety of the message body** — every line of it,
 * blockquote markers included. Then there is no neighbouring sentence, so there
 * is nothing for a neighbouring sentence to do, and the guarantee strengthens
 * from *somebody wrote this sentence* to *somebody wrote this message and it
 * says exactly this*.
 *
 * ## Why the *body*, and not the "own text"
 *
 * r5's first draft compared against `stripReplyBlockquotes(body)`, which is the
 * right input for asking **who wrote the quote** (r1's finding: a reply-quote
 * reproduces somebody else's paragraph, and attributing it to the replier is the
 * spike's worst error). grok's blind pass showed it is the wrong input for
 * asking **what surrounds the quote**: `stripReplyBlockquotes` deletes every
 * line beginning with `>` whether or not anybody else ever wrote it, so an
 * author who writes
 *
 *     We will deploy production Friday.
 *     > Not.
 *
 * has their own second line deleted, the first line becomes the whole "own
 * text", and the sentence certifies. That is this round's own defect class,
 * reappearing through the helper that was supposed to prevent a different one.
 *
 * Two questions, two inputs. Authorship reads the stripped text, because a
 * blockquote is not the replier's sentence. Coverage reads the body, because
 * a blockquote is still *there*, and a machine cannot tell the author quoting
 * somebody from the author formatting an aside.
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
 * The answer is `QUESTION_MARKS`: **Unicode's own inventory of question marks,
 * enumerated.** That is a closed, published list, not an open-ended list of
 * things somebody might try, which is the distinction `RETRO.md` draws between
 * an enumeration that is safe and one that is not.
 *
 * It took three review passes to fill, and the sequence is the argument for
 * re-running a critic on what it made you change: the first found `？` (U+FF1F,
 * fullwidth), the second found `¿` (U+00BF — a Spanish interrogative opens with
 * one and need carry no other mark), the third found `᥅` (U+1945, Limbu) and
 * `꩝` (U+AA5D, Cham).
 *
 * **NFKC was here and is gone.** The second repair folded the text first, on the
 * argument that this is a classification question rather than a comparison, so
 * compatibility folding is exactly right. True, and by the time the inventory
 * was complete it was also *redundant* — every compatibility spelling NFKC
 * mapped onto `?` (U+FF1F, U+FE56, the U+2047–U+2049 ligatures) is in the list
 * above, so no input could tell the two mechanisms apart. The mutation ledger
 * said so out loud: the row that deleted the fold **escaped**, because nothing
 * pinned it. Worse, folding first *destroys* one mark — U+037E GREEK QUESTION
 * MARK canonically decomposes to an ASCII semicolon, so a check that read only
 * the folded form would see punctuation. One mechanism, pinned, reading the text
 * it was given.
 */
export const QUESTION_MARKS: readonly string[] = Object.freeze([
  '\u003F', // QUESTION MARK
  '\u00BF', // INVERTED QUESTION MARK — a Spanish interrogative opens with one
  '\u037E', // GREEK QUESTION MARK
  '\u055E', // ARMENIAN QUESTION MARK
  '\u061F', // ARABIC QUESTION MARK
  '\u1367', // ETHIOPIC QUESTION MARK
  '\u1945', // LIMBU QUESTION MARK
  '\u2047', // DOUBLE QUESTION MARK
  '\u2048', // QUESTION EXCLAMATION MARK
  '\u2049', // EXCLAMATION QUESTION MARK
  '\u203D', // INTERROBANG
  '\u2E2E', // REVERSED QUESTION MARK
  '\uA60F', // VAI QUESTION MARK
  '\uA6F7', // BAMUM QUESTION MARK
  '\uAA5D', // CHAM QUESTION MARK
  '\uFE16', // PRESENTATION FORM FOR VERTICAL QUESTION MARK
  '\uFE56', // SMALL QUESTION MARK
  '\uFF1F', // FULLWIDTH QUESTION MARK
  '\u{11143}', // CHAKMA QUESTION MARK
]);

const QUESTION_MARK = new RegExp(`[${QUESTION_MARKS.join('')}]`, 'u');

export function isAssertion(text: string): boolean {
  return !QUESTION_MARK.test(text);
}
