/* ---------------------------------------------------------------------------
 * THE EPISTEMIC GLYPH — derived, never hand-set.
 *
 * design/CONVENTIONS.md: "Every rendered fact carries exactly one glyph. The
 * glyph is derived from the data's provenance, never hand-set. A claim never
 * dresses as a fact."
 *
 * This module is the single derivation. Components take an `EpistemicState` and
 * ask for the glyph; the `NoGlyph` brand below makes handing one in a *type*
 * error rather than a code-review note.
 * ------------------------------------------------------------------------- */

/** The seven glyphs in the vocabulary. There is no eighth. */
export type Glyph = '✓' | '~' | '?' | '·' | '◆' | '■' | '✗';

/**
 * What kind of thing this is. `event` covers timeline rows that are not a
 * semantic object at all — a routine deploy line, a system notice.
 */
export type ObjectKind = 'decision' | 'commitment' | 'question' | 'claim' | 'event';

/**
 * How well-checked the thing is.
 *
 * `verified` — checked by something other than the claimant.
 * `accepted` — a human took it and put their name on it.
 * `proposed` / `unverified` / `self_reported` — nothing outside the claimant
 *   has checked it. These three are the claim states.
 * `open` — an explicitly unanswered question.
 * `failed` — it did not work.
 * `routine` — no attention owed; a fact with no epistemic weight.
 */
export type Verification =
  | 'verified'
  | 'accepted'
  | 'proposed'
  | 'unverified'
  | 'self_reported'
  | 'open'
  | 'failed'
  | 'routine';

/**
 * The three verification states that mean "nothing outside the claimant has
 * checked this". They drive the dotted underline INDEPENDENTLY of the glyph: a
 * proposal that is also a gate is still a claim, so it renders ◆ *and* dotted.
 * Deriving the underline from the glyph lets being-owed-to-you silently dress a
 * proposal as settled prose.
 */
const UNSETTLED: ReadonlySet<Verification> = new Set<Verification>([
  'proposed',
  'unverified',
  'self_reported',
]);

const SETTLED: ReadonlySet<Verification> = new Set<Verification>(['verified', 'accepted']);

/** Everything the glyph derivation is allowed to look at. */
export interface EpistemicState {
  readonly kind: ObjectKind;
  readonly verification: Verification;
  /** true when this specific item is owed to the person reading the page */
  readonly owedToViewer: boolean;
  /**
   * true when settling it is destructive or otherwise not undoable. Drives the
   * ■ glyph and, per CONVENTIONS' asymmetric-friction rule, press-and-hold
   * rather than one click at the call site.
   */
  readonly irreversible: boolean;
}

/**
 * The derivation. Order matters: failure outranks everything, being owed
 * outranks being merely unverified, and settled outranks unsettled.
 */
export function glyphFor(state: EpistemicState): Glyph {
  if (state.verification === 'failed') return '✗';
  if (needsViewer(state)) {
    if (state.irreversible) return '■';
    return state.kind === 'question' ? '?' : '◆';
  }
  if (state.verification === 'open') return '?';
  if (SETTLED.has(state.verification)) return '✓';
  if (UNSETTLED.has(state.verification)) return '~';
  return '·';
}

/** A settled thing is not owed, whatever the caller's `owedToViewer` says. */
export function needsViewer(state: EpistemicState): boolean {
  return state.owedToViewer && !SETTLED.has(state.verification);
}

/**
 * Whether the text gets the dotted underline. Independent of the glyph on
 * purpose — see UNSETTLED above.
 */
export function isClaim(state: EpistemicState): boolean {
  return UNSETTLED.has(state.verification);
}

/**
 * The colour class a glyph wears. Derived from the glyph, so a component never
 * picks a hue: green = verified, amber = needs you, red = destructive/failed,
 * neutral = claim/routine (the dotted underline is what flags a claim).
 */
export type GlyphTone = 'verified' | 'needs' | 'destructive' | 'failed' | 'neutral';

export function glyphTone(glyph: Glyph): GlyphTone {
  switch (glyph) {
    case '✓':
      return 'verified';
    case '◆':
    case '?':
      return 'needs';
    case '■':
      return 'destructive';
    case '✗':
      return 'failed';
    case '~':
    case '·':
      return 'neutral';
  }
}

/** The tooltip is part of the vocabulary, not decoration. */
export function glyphMeaning(glyph: Glyph): string {
  switch (glyph) {
    case '✓':
      return 'verified — checked by something other than the claimant';
    case '~':
      return "a claim — the claimant's own account, nothing has checked it";
    case '?':
      return 'an open question — explicitly unverified';
    case '·':
      return 'routine — no attention owed';
    case '◆':
      return 'needs you — a reversible gate waiting on a human';
    case '■':
      return 'needs you — destructive, and not undoable';
    case '✗':
      return 'failed';
  }
}

/**
 * RULE ENFORCEMENT, TYPE LEVEL.
 *
 * Every component that renders a glyph intersects its props with this. The
 * `?: never` members mean `<TimelineRow glyph="✓" …/>` and its cousins do not
 * compile: the only way to get a glyph on screen is to hand over the state and
 * let `glyphFor` decide. TypeScript rejects `never`-typed props on a JSX
 * element the same way it rejects an unknown one, and unlike excess-property
 * checking this survives a spread of a wider object.
 */
export interface NoGlyph {
  readonly glyph?: never;
  readonly mark?: never;
  readonly icon?: never;
  readonly symbol?: never;
  readonly tone?: never;
}
