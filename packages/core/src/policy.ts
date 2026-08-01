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
 * The two that r2's gauntlet named as strays *were* acceptance policy and have
 * moved here: the dedup similarity threshold (a duplicate is discarded, so the
 * number decides what is never shown) and the minimum quote length (which is now
 * enforced on the acceptance path, not only on blockquote detection).
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
 *    Cheap to correct, so recall wins. θ_auto is low.
 *  - **OpenQuestion** — a spurious one is one click to dismiss and a missed one
 *    is a question nobody ever revisits. The cost asymmetry is the strongest
 *    here, so this is the lowest bar in the table.
 *  - **Commitment** — an obligation with a name on it. Higher bar, and the
 *    self/third-party split matters more than the number.
 *  - **Objective** — a grouping noun; a wrong one mis-files things quietly,
 *    which is worse than a wrong claim because nobody notices.
 *  - **Decision** — never, at any confidence.
 *
 * θ_min is the discard line. Below it the reading is not shown at all, because
 * a `~` a person has to evaluate is not free: the product's scarcest resource
 * is the attention of the people in the room.
 */
export const DEFAULT_ACCEPTANCE_RULES: Readonly<Record<AcceptedObjectType, AcceptanceRule>> =
  Object.freeze({
    decision: Object.freeze({ thetaAuto: 0.7, thetaMin: 0.5, autoAccept: false }),
    commitment: Object.freeze({ thetaAuto: 0.75, thetaMin: 0.5, autoAccept: true }),
    open_question: Object.freeze({ thetaAuto: 0.6, thetaMin: 0.4, autoAccept: true }),
    claim: Object.freeze({ thetaAuto: 0.7, thetaMin: 0.5, autoAccept: true }),
    objective: Object.freeze({ thetaAuto: 0.75, thetaMin: 0.5, autoAccept: true }),
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
 * A type that never auto-accepts gets `+Infinity`: unreachable by construction,
 * so the table stays total over the five types and cannot silently acquire a
 * hole if the human-only gate above it is ever moved.
 */
export const MODEL_ACCEPTANCE_FLOOR: Readonly<Record<AcceptedObjectType, number>> = Object.freeze(
  Object.fromEntries(
    AcceptedObjectType.options.map((type) => [
      type,
      DEFAULT_ACCEPTANCE_RULES[type].autoAccept
        ? DEFAULT_ACCEPTANCE_RULES[type].thetaAuto
        : Number.POSITIVE_INFINITY,
    ]),
  ) as Record<AcceptedObjectType, number>,
);

/** May a non-human actor ever accept this type, at any confidence? */
export function autoAcceptable(type: AcceptedObjectType): boolean {
  return DEFAULT_ACCEPTANCE_RULES[type].autoAccept;
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
   * **The only words the bearing check will let differ between a quote and the
   * statement it is supposed to carry.**
   *
   * r3 answered "does this quote bear this sentence" with lexical overlap over a
   * de-duplicated content-word set, with `not` on the stopword list. r3's
   * gauntlet inverted the product with it: quote *"Bob will not deploy production
   * Friday"*, mint *"Bob will deploy production Friday"*, score 100%,
   * auto-accept. The lesson is not that `not` was on the wrong list. It is that
   * **a list of dangerous words is unbounded** — polarity, quantifiers, modals,
   * hedges, subordinators, and whatever the next reviewer thinks of — and a check
   * built on one is wrong until somebody finds the next word.
   *
   * So this is the other kind of list: not the words that must match, but the
   * *only* ones that may differ. Everything else in either text is content that
   * has to be accounted for. The three articles are here because adding or
   * removing one cannot change **who**, **whether**, **how many**, or **when** —
   * which is the whole of what the receipt claims. Nothing else has cleared that
   * bar, and adding a word here is a change to what the product guarantees, not a
   * tuning knob.
   */
  droppableWords: ReadonlySet<string>;
  /**
   * The most tokens the bearing alignment will compare on either side.
   *
   * The alignment resynchronises with a lookahead, so it is O(n·m) in the worst
   * case and `quote` arrives from the same untrusted place every other field
   * does. Above this the check does not degrade, it **refuses** — an input too
   * large to align is an input that has not been checked, and the honest answer
   * to that is the same as every other unanswerable question here.
   */
  maxAlignedTokens: number;
  /**
   * Fraction of content words two texts must share to be the same reading.
   *
   * Acceptance policy, not a formatting knob: a duplicate is *discarded*, so
   * this number decides what the room never sees. It was a default argument on
   * `findDuplicate` — r2's gauntlet counted it as a stray θ, correctly.
   */
  duplicateThreshold: number;
}

export const RECEIPT_POLICY: Readonly<ReceiptPolicy> = Object.freeze({
  minQuoteLength: 24,
  droppableWords: Object.freeze(new Set(['a', 'an', 'the'])) as ReadonlySet<string>,
  maxAlignedTokens: 400,
  duplicateThreshold: 0.8,
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
