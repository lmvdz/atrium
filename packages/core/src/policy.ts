import { z } from 'zod';
import { AcceptedObjectType } from './objects.js';

/**
 * **The acceptance policy: the floors a machine-made reading must clear, and the
 * minima its receipt must meet.** One copy of each number, read by everything
 * that decides whether a reading becomes a fact.
 *
 * r1's gauntlet found the same defect from two directions: the reducer's floor
 * and the acceptance engine's θ were two numbers for one rule (0.5 vs 0.7 on a
 * claim), and the attention projection held a third opinion about which
 * proposals were live enough to raise. Three readings of "is this reading strong
 * enough" is three chances to disagree, and the disagreement is invisible — a
 * model acceptance the engine would never have emitted folds cleanly, and a
 * proposal the engine discarded still lights up somebody's Needs-you.
 *
 * So the numbers live here, above everyone who reads them:
 *
 *  - `reduce.ts` refuses a non-human acceptance below `θ_auto` — the *trust
 *    boundary*, enforced where nothing can route around it.
 *  - `acceptance.ts` decides what a worker should emit, using the same θ.
 *  - `attention.ts` asks `acceptance.ts`, so the panel and the engine cannot
 *    disagree about a proposal in the band.
 *  - `escalation.ts` validates a receipt against `RECEIPT_POLICY` below, and
 *    both the engine and the reducer run that validator.
 *
 * A config may make the engine **stricter**. Nothing can make it looser: the
 * reducer reads `MODEL_ACCEPTANCE_FLOOR`, which is derived from the defaults
 * below and is not configurable at all.
 *
 * ## What deliberately does *not* live here
 *
 * r2's write-up said "one θ table" in a way that read as "every tunable number
 * in the package", and r2's gauntlet was right that this was overstated. The
 * claim is scoped, and the scope is the sentence above: **acceptance floors and
 * receipt minima**. The escalation *routing* knobs — `decisionOverlapThreshold`,
 * `decisionOverlapMinTokens`, `maxScanChars`, `maxHistoryScanned`,
 * `maxComparedDecisions` — stay in `escalation.ts`, because they decide which
 * model reads a window, never whether a reading becomes a fact. Getting one
 * wrong costs a model call; getting one of these wrong mints something false.
 *
 * One of the two r2's gauntlet named as strays *was* acceptance policy and moved
 * here: the minimum quote length, which is enforced on the acceptance path and
 * not only on blockquote detection. The other, the dedup similarity threshold,
 * is **gone entirely as of r5** — `findDuplicate` no longer scores similarity at
 * all, because a threshold over stopword-filtered tokens discarded a reading
 * that said the *opposite* of the accepted object it was compared against. There
 * is no number to place because there is no score.
 *
 * Pure: no clock, no I/O, no state.
 */

/**
 * One type's rule.
 *
 * θ_auto is the **confident** line, and `autoAccept` says what crossing it
 * buys. For four types it buys acceptance. For a decision it buys a place in
 * Needs-you and nothing else, because a decision cannot be auto-accepted at any
 * confidence (#4: "inference is banned at exactly this point").
 *
 * Encoding that as `thetaAuto: 1.01` instead would have been shorter and wrong
 * twice over: it would make the rule look tunable, and it would collapse "the
 * pass is sure about this decision" into "the pass is unsure about this
 * decision", which are the two cells #4 and #6 disagree about. Keeping the
 * threshold real and the permission separate is what lets a confident decision
 * proposal reach a person while an uncertain one stays quiet.
 */
export const AcceptanceRule = z.object({
  /** At or above this, the pass is "confident". */
  thetaAuto: z.number().min(0).max(1),
  /** Below this, the reading is discarded, not shown. */
  thetaMin: z.number().min(0).max(1),
  /** Whether crossing θ_auto may accept, rather than only surface. */
  autoAccept: z.boolean(),
});
export type AcceptanceRule = z.infer<typeof AcceptanceRule>;

/**
 * #4's thresholds, per type.
 *
 * The shape of the table is #4's argument, restated: acceptance thresholds
 * follow the **cost of being wrong**, not the model's confidence in being
 * right.
 *
 *  - **Claim** — "X said Y" with its truth carried separately in `verification`.
 *    Cheap to correct, so recall wins. θ_auto is low, and it auto-accepts.
 *  - **OpenQuestion** — a spurious one is one click to dismiss and a missed one
 *    is a question nobody ever revisits. The cost asymmetry is the strongest
 *    here, so this is the lowest bar in the table, and it auto-accepts.
 *  - **Commitment** — an obligation with a name on it. **Never, at any
 *    confidence, since r5.**
 *  - **Objective** — a grouping noun; a wrong one mis-files things quietly,
 *    which is worse than a wrong claim because nobody notices. **Never, since
 *    r5.**
 *  - **Decision** — never, at any confidence.
 *
 * ## What r5 moved out of the auto-accept column, and why
 *
 * #44's fact-check drove a model actor through the whole stack with
 * `{statement: 'Bob will deploy production Friday', owner: 'user_bob'}` and it
 * landed with zero issues. Every gate held: the quote was real, the author was
 * real, the attribution rules agreed it was self-stated because the bearing
 * message's author id equalled the owner. What nothing asked was whether a
 * *machine* may put an obligation on a named person at all.
 *
 * #4's row reads "Commitments: self-stated auto-accepts, third-party waits", and
 * that row was written about who the sentence is *about*. It is silent on who is
 * doing the accepting, and the silence read as permission. A commitment is the
 * one accepted type that creates an expectation of somebody — the whole of #4's
 * "nobody gets committed by someone else's sentence" — and a machine's reading
 * of a sentence is exactly somebody else's sentence. An objective joins it for
 * the reason its own bullet already gave and `decideSupersession` already
 * enforces on the way out: retiring one needs a person, so minting one does too,
 * or the gate is a front door with the back door open.
 *
 * `open_question` staying model-acceptable is deliberate and unchanged: a
 * question puts nothing on anybody, and the cost of missing one is the highest
 * asymmetry in the table.
 *
 * θ_min is the discard line. Below it the reading is not shown at all, because
 * a `~` a person has to evaluate is not free: the product's scarcest resource
 * is the attention of the people in the room. **A receipt fault is not
 * weakness**, and `acceptance.ts` says why it is ruled on above this line.
 */
export const DEFAULT_ACCEPTANCE_RULES: Readonly<Record<AcceptedObjectType, AcceptanceRule>> =
  Object.freeze({
    decision: Object.freeze({ thetaAuto: 0.7, thetaMin: 0.5, autoAccept: false }),
    commitment: Object.freeze({ thetaAuto: 0.75, thetaMin: 0.5, autoAccept: false }),
    open_question: Object.freeze({ thetaAuto: 0.6, thetaMin: 0.4, autoAccept: true }),
    claim: Object.freeze({ thetaAuto: 0.7, thetaMin: 0.5, autoAccept: true }),
    objective: Object.freeze({ thetaAuto: 0.75, thetaMin: 0.5, autoAccept: false }),
  });

/**
 * The confidence a non-human actor must clear for the reducer to fold its
 * acceptance — **the same θ_auto the engine runs on**, derived from the table
 * above rather than restated beside it.
 *
 * r1's gauntlet routed this: the floor used to be a separate, lower set of
 * numbers ("a malformed acceptance rather than a debatable one"), which meant a
 * model could land a claim at 0.55 that the engine would never emit — θ was
 * policy in the layer that mints events, and a policy in the minting layer holds
 * exactly as long as that layer is the only writer. It is a trust boundary now.
 *
 * A type a machine may not mint gets `+Infinity`: unreachable by construction,
 * so the table stays total over the five types and cannot silently acquire a
 * hole if the human-only gate above it is ever moved.
 *
 * **Since r7 that is `modelMayMint`, not `autoAccept`** — a type whose *kind of
 * act* the text cannot certify is one the proposal named for itself, and the
 * floor is the reducer's half of refusing that. See `typeCertifiableFromText`.
 */
export const MODEL_ACCEPTANCE_FLOOR: Readonly<Record<AcceptedObjectType, number>> = Object.freeze(
  Object.fromEntries(
    AcceptedObjectType.options.map((type) => [
      type,
      modelMayMint(type) ? DEFAULT_ACCEPTANCE_RULES[type].thetaAuto : Number.POSITIVE_INFINITY,
    ]),
  ) as Record<AcceptedObjectType, number>,
);

/** May a non-human actor ever accept this type, at any confidence? */
export function autoAcceptable(type: AcceptedObjectType): boolean {
  return DEFAULT_ACCEPTANCE_RULES[type].autoAccept;
}

/**
 * **Can the text certify that it was this kind of act?**
 *
 * r7, and it is the axis this package did not have. Everything the receipt
 * proves is about *provenance*: these words are in the record, this person wrote
 * them, nothing later took them back. `type` is not in that set — it is supplied
 * by the proposal, and until r7 **it selected the rule that judged the
 * proposal**. One body, one quote, one author, and the verdict moved with a
 * field the model filled in:
 *
 * | minted as                             | verdict                         |
 * | ------------------------------------- | ------------------------------- |
 * | `commitment`, owner Bob, conf 0.95    | `pending / never_auto_accepts`  |
 * | `claim`, claimant Bob, conf 0.95      | **`auto_accept`**               |
 * | `claim`, conf 0.65                    | `pending / theta_band`          |
 * | `open_question`, conf 0.65            | **`auto_accept`** (θ_auto 0.6)  |
 *
 * So the question a type has to answer before its rule is applied: **is being
 * this type a property of the text, or of the proposal?**
 *
 *  - `open_question` — a property of the text. An interrogative carries a
 *    question mark, `QUESTION_MARKS` enumerates every mark that makes one in
 *    every script, and `escalation.ts` refuses both directions: a question minted
 *    as an assertion, and a declarative minted as an open question. Certified.
 *  - `claim`, `commitment`, `decision`, `objective` — **not**. All four are
 *    assertions. "Bob will land the fix Friday" is a claim about the world, a
 *    commitment Bob made, a decision the room took, or an objective, and nothing
 *    in the characters says which. Telling them apart is reading intent, which is
 *    what a model is for and what `#8`'s escalation tier is where a model belongs.
 *
 * The three uncertified types that never auto-accept lose nothing by this,
 * because a person was already deciding. `claim` is the one where it bites, and
 * that is exactly where the laundering paid: a commitment nobody confirmed,
 * filed as a claim, machine-accepted.
 *
 * ## Why this is the axis and not a receipt problem, measured
 *
 * The first implementation put it in `validateProposalProvenance` as a
 * `refer`-severity problem, which is where the adjudication's words point. It
 * was run: **78 of 1027 tests fell, and the shape of the fall is the argument
 * against it.** A `refer` outranks θ, so a claim at 0.4999 — a reading the table
 * says to *discard* — came back `pending`, and the θ band came back
 * `receipt_not_certifiable`. That does not stage uncertified readings for a
 * person; it empties the discard cell into Needs-you and makes the whole θ table
 * unreachable for claims. The gap is that the type picked the rule, so the
 * repair belongs where the rule is picked: **below θ_min still discards, the
 * band still bands, and only the auto-accept cell is refused.**
 */
export function typeCertifiableFromText(type: AcceptedObjectType): boolean {
  switch (type) {
    case 'open_question':
      return true;
    case 'claim':
    case 'commitment':
    case 'decision':
    case 'objective':
      return false;
    default: {
      const exhaustive: never = type;
      // A type nobody has classified is not a type whose kind a machine may assert.
      return JSON.stringify(exhaustive) === '' ? false : false;
    }
  }
}

/**
 * The one predicate both enforcement points read: a machine may mint this type
 * only if the table lets it **and** the text can certify the type is what the
 * proposal says it is.
 *
 * Derived rather than restated, because the whole D1/#1 class in this package is
 * one rule written at two sites drifting apart.
 */
export function modelMayMint(type: AcceptedObjectType): boolean {
  return autoAcceptable(type) && typeCertifiableFromText(type);
}

/**
 * The whole config, with the invariants that keep it coherent checked at parse
 * time rather than discovered in a room:
 *
 *  1. `thetaMin ≤ thetaAuto` — otherwise the pending band is inverted and a
 *     reading can be simultaneously too weak to show and strong enough to
 *     accept.
 *  2. `thetaAuto ≥ MODEL_ACCEPTANCE_FLOOR[type]` for any type that auto-accepts
 *     — the engine may be stricter than the reducer's floor and may never be
 *     looser, or it emits events the reducer refuses.
 *  3. `autoAccept` may not be switched **on** for a type whose default is off.
 *     The reducer's floor is `+Infinity` for those, so a config that turned one
 *     on would emit acceptances nothing can fold. Stated separately for
 *     `decision` because that is #4's one absolute and deserves its own words.
 */
export const AcceptanceConfig = z
  .record(AcceptedObjectType, AcceptanceRule)
  .superRefine((rules, ctx) => {
    for (const type of AcceptedObjectType.options) {
      const rule = rules[type];
      if (!rule) {
        ctx.addIssue({
          code: 'custom',
          path: [type],
          message: `acceptance config is missing a rule for "${type}" — the table must be total over the five object types`,
        });
        continue;
      }
      if (rule.thetaMin > rule.thetaAuto) {
        ctx.addIssue({
          code: 'custom',
          path: [type, 'thetaMin'],
          message: `θ_min (${rule.thetaMin}) is above θ_auto (${rule.thetaAuto}) for "${type}" — the pending band would be inverted`,
        });
      }
      if (rule.autoAccept && !autoAcceptable(type)) {
        ctx.addIssue({
          code: 'custom',
          path: [type, 'autoAccept'],
          message:
            type === 'decision'
              ? 'a decision may never auto-accept at any confidence (#4) — accepted only by a human, or by answer-binding'
              : `"${type}" may never auto-accept — the reducer's floor for it is unreachable, so the acceptance would be refused`,
        });
      }
      const floor = MODEL_ACCEPTANCE_FLOOR[type];
      if (rule.autoAccept && Number.isFinite(floor) && rule.thetaAuto < floor) {
        ctx.addIssue({
          code: 'custom',
          path: [type, 'thetaAuto'],
          message: `θ_auto (${rule.thetaAuto}) for "${type}" is below the reducer's acceptance floor (${floor}) — the engine may be stricter than the floor, never looser, or it emits acceptances the reducer refuses`,
        });
      }
    }
  });
export type AcceptanceConfig = Record<AcceptedObjectType, AcceptanceRule>;

/** The default table, parsed — so the defaults are held to their own invariants. */
export const defaultAcceptanceConfig: AcceptanceConfig = AcceptanceConfig.parse(
  DEFAULT_ACCEPTANCE_RULES,
) as AcceptanceConfig;

/** Merge per-type overrides onto the defaults and re-check the invariants. */
export function resolveAcceptanceConfig(
  overrides: Partial<Record<AcceptedObjectType, Partial<AcceptanceRule>>> = {},
): AcceptanceConfig {
  const merged: Record<string, AcceptanceRule> = {};
  for (const type of AcceptedObjectType.options) {
    merged[type] = { ...DEFAULT_ACCEPTANCE_RULES[type], ...(overrides[type] ?? {}) };
  }
  return AcceptanceConfig.parse(merged) as AcceptanceConfig;
}

/* ─────────────────────────────────────────────────────────────────────────
 * The receipt minima
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * **`droppableTokens` is gone, and this is its obituary.**
 *
 * It was the answer to "what may differ between a quote and the statement it is
 * supposed to carry", and the answer is now **nothing**. Kept here rather than
 * deleted silently, because a field that has been removed is a rule somebody
 * will otherwise re-derive.
 *
 * r3 answered "does this quote bear this sentence" with lexical overlap over a
 * de-duplicated content-word set, with `not` on the stopword list, and r3's
 * gauntlet inverted the product with it. The lesson was not that `not` was on
 * the wrong list — it was that **a list of dangerous words is unbounded**. So r4
 * built the other kind of list: not the tokens that must match, but the only
 * ones that may differ. Four entries. Each one has now been broken by a
 * reviewer, and each break had the same shape — the *justification* was about a
 * context the *membership test* could not see:
 *
 * | entry        | round | the input that broke its argument                       |
 * | ------------ | ----- | ------------------------------------------------------- |
 * | `a`, `an`    | r4    | "**A** maintainer will deploy" bearing "**The** maintainer will deploy" — indefinite reference laundered into definite |
 * | `the`        | r4    | "**A** will deploy production Friday" bearing "will deploy production Friday" — a one-letter name is spelled like an article |
 * | `.`          | **r6** | ``Load `.env` before the deploy tonight.`` bearing ``Load `env` …``; ``cd to `..` `` bearing ``cd to `` ``; "We ship. Then we celebrate." bearing "We ship Then we celebrate." |
 *
 * The argument for `.` was *"a full stop terminates a sentence and carries no
 * other meaning"*. True of a sentence-final full stop, and the check was a
 * `Set.has` over every `.` token anywhere — including inside the code spans
 * `normalizeForReceipt` preserves byte for byte precisely because they are
 * literals. A hidden file, a parent directory, a trailing method dot, a decimal
 * point and the period between two sentences are all "no other meaning" to a
 * set-membership test. Found by grok's blind pass on r6, and independently by
 * codex before its run was cut short.
 *
 * **What is left needed no justification: the statement is the quote.** `borne`
 * is now exactly `normalizeForReceipt(quote) === normalizeForReceipt(statement)`
 * — one sentence, no exceptions, and `bearing.test.ts` asserts the equivalence
 * directly rather than sampling it.
 *
 * The cost, stated as a disposition and not as a residue: **a model that drops
 * the trailing full stop from a sentence it otherwise quotes perfectly is no
 * longer auto-accepted.** It is referred — `quote_carries_more_than_statement` —
 * so a person reads two nearly identical sentences and clicks once. The cost is
 * small for the reason r5 gave when it retired asterisk emphasis: since
 * `quoteCoversOwnText`, a quote must be the **whole message body**, and a model
 * reproducing a whole body verbatim carries its final full stop along.
 */

export interface ReceiptPolicy {
  /**
   * Shortest quoted span (normalized) that can serve as a receipt.
   *
   * r2's gauntlet, major 1: "any normalized substring anywhere in a cited
   * message satisfies it — cite Bob's unrelated 'yes' and mint 'Bob will
   * deploy'". A one-word quote identifies nothing; it is a token that happens to
   * occur, and the citation it produces is a permission slip rather than
   * evidence. The number was already in `defaultEscalationConfig` for blockquote
   * detection and is the same judgement — "below this, a quoted span is not
   * quoting anything" — so it is one constant now, read by both.
   */
  minQuoteLength: number;
  /**
   * The most tokens the bearing alignment will compare on either side.
   *
   * The alignment resynchronises with a lookahead, so it is O(n·m) in the worst
   * case and `quote` arrives from the same untrusted place every other field
   * does. Above this the check does not degrade, it **refuses** — an input too
   * large to align is an input that has not been checked, and the honest answer
   * to that is the same as every other unanswerable question here. The refusal
   * is `refer` and not `reject` since r6: `escalation.ts` says why an
   * unjudgeable input is referred rather than destroyed.
   *
   * **800 and not 400, and the reach is unchanged.** r6 made `orderedTokens`
   * exhaustive — the spaces between words are tokens now, because a token stream
   * that drops them cannot prove the statement is the quote. A message therefore
   * costs about twice as many tokens as it did in r5 for exactly the same words,
   * so the number doubled to keep the *limit* where it was. It is stated in
   * tokens because that is what the loop counts, and pinned in words by
   * `bearing.test.ts`, which writes out a 401-word input rather than deriving
   * one from this table.
   */
  maxAlignedTokens: number;
  /**
   * Sentences of one message the quote-anchoring check will scan.
   *
   * Same argument as `maxAlignedTokens`: the check is quadratic in the sentence
   * count and the message body is somebody else's input. Above this it refuses.
   */
  maxScannedSentences: number;
  /**
   * Messages *after* the cited ones that the later-correction scan will read.
   *
   * r5: `ProvenanceMessage` carried `id`, `authorId` and `body`, and validation
   * constructed and inspected only the **cited** messages — so a window holding
   * `"We will deploy production Friday."` followed by `"Correction: we will not
   * deploy production Friday."`, with the proposal citing only the first,
   * auto-accepted. The message schema being append-only prevents a literal edit;
   * it does not make a later correction part of acceptance.
   *
   * Bounded for the same reason every other scan here is: the window is somebody
   * else's input and the scan is linear in it times the sentences in each.
   *
   * **Above this the scan refuses, and this comment used to say the opposite.**
   * It argued that stopping was safe "in the direction that matters — it can
   * only miss a correction", which is precisely the sentence `escalation.ts`
   * quotes as the argument r5 deleted from `laterRevision`: a window with more
   * messages in it than this is a window the check did not read, an unread
   * window is not a clean one, and an input inside a documented limit was
   * auto-accepting. The code has refused since r5; this paragraph is r6 catching
   * up with it. A stated limit is not a disposition, and a rationale for a
   * disposition the code no longer has is worse than no rationale.
   */
  maxLaterMessagesScanned: number;
}

export const RECEIPT_POLICY: Readonly<ReceiptPolicy> = Object.freeze({
  minQuoteLength: 24,
  maxAlignedTokens: 800,
  maxScannedSentences: 200,
  maxLaterMessagesScanned: 200,
});

/* ─────────────────────────────────────────────────────────────────────────
 * Supersession
 * ───────────────────────────────────────────────────────────────────────── */

export type SupersessionAuthority =
  /** A model may land it. */
  | 'auto_accept'
  /** A person must. */
  | 'requires_human';

export interface SupersessionDecision {
  authority: SupersessionAuthority;
  reason: string;
}

/**
 * #4's supersession split, by what is being retired.
 *
 * "Auto-accept when it retires a claim or a question; requires human accept when
 * it retires an accepted Decision." The other two types are not in #4's sentence
 * and default to `requires_human`, which is the conservative reading and the
 * only one that is safe to be wrong about: a commitment is an obligation with a
 * name on it and an objective is what everything else is filed under. Retiring
 * either quietly is a change nobody sees.
 *
 * **The reducer enforces this table, not a subset of it.** r1's gauntlet found
 * the gap: this policy required a human for commitments and objectives while the
 * reducer gated decisions only, so a model could retire a human-accepted
 * commitment — and silence the attention item that went with it — through the
 * one door the policy thought it had closed.
 */
export function decideSupersession(retiredType: AcceptedObjectType): SupersessionDecision {
  switch (retiredType) {
    case 'claim':
      return {
        authority: 'auto_accept',
        reason:
          'retiring a claim is a newer reading replacing an older one, and cheap to correct (#4)',
      };
    case 'open_question':
      return {
        authority: 'auto_accept',
        reason:
          'retiring an open question is cheap to correct, and a stale question costs recall (#4)',
      };
    case 'decision':
      return {
        authority: 'requires_human',
        reason:
          'retiring an accepted decision needs the same human hand that accepting one needed (#4) — otherwise the decision gate is a front door with the back door open',
      };
    case 'commitment':
      return {
        authority: 'requires_human',
        reason:
          "a commitment is an obligation with a name on it — #4 does not put it in the auto-accept row, and dropping someone's obligation quietly is not a cheap correction",
      };
    case 'objective':
      return {
        authority: 'requires_human',
        reason:
          'an objective is what everything else is filed under — #4 does not put it in the auto-accept row, and retiring one silently re-files the room',
      };
    default: {
      const exhaustive: never = retiredType;
      return { authority: 'requires_human', reason: `unknown type ${JSON.stringify(exhaustive)}` };
    }
  }
}
