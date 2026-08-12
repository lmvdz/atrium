import { isHuman } from './authority.js';
import type { Actor, Timestamp } from './common.js';
import type { ObjectRecord } from './state.js';

/**
 * `~` vs `✓` — whether a thing on screen is the room's word or a machine's.
 *
 * The research brief's glyph distinction, and init.md §5's rule that nothing
 * model-accepted ever renders as a fact. There is exactly one predicate:
 *
 *   **an object is confirmed once a human has touched it, and not before.**
 *
 * Touched means accepted by a person, or corrected by one afterwards. That
 * second clause matters: a model-accepted claim a person amends is a claim a
 * person has now read and taken responsibility for, and leaving it at `~`
 * forever would mean corrections cannot promote anything — the room would keep
 * being asked about something it already settled.
 *
 * Confidence is deliberately absent. The interpretation spike measured
 * self-reported confidence as *anti*-correlated with correctness (0.937 mean on
 * the objects judged wrong, 0.928 on the ones judged right, n=90). A `✓` earned
 * by clearing a threshold would be a `✓` that means nothing.
 *
 * `verification` on a claim is a different axis and stays separate: `~`/`✓` says
 * whether the *room* has confirmed the reading, `verification` says whether the
 * claim is true. A human-accepted claim is `✓ unverified` — we are sure someone
 * said it, not that it is so.
 */
export type EpistemicState =
  /** `~` — a machine's reading, staged. No person has touched it. */
  | 'unconfirmed'
  /** `✓` — a person accepted or corrected it. */
  | 'confirmed';

/**
 * The two fields the one predicate reads, and the only two. An `ObjectRecord`
 * has them (with `acceptedBy` a full `Actor`); so does a row of the read model,
 * once `accepted_by_kind` and `human_touched_at` are projected. Naming the
 * minimum is what lets both call it — the reducer's gate and the rendered glyph
 * are then one function, not two predicates that agree by luck.
 */
export interface EpistemicInputs {
  /** Who accepted it. Only the `kind` bears on the predicate — see `isHuman`. */
  readonly acceptedBy: Pick<Actor, 'kind'>;
  /** When a human first touched it, or `null` while it is only a machine's reading. */
  readonly humanTouchedAt: Timestamp | null;
}

/** The one predicate. */
export function epistemicStateOf(record: EpistemicInputs): EpistemicState {
  return isHuman(record.acceptedBy) || record.humanTouchedAt !== null ? 'confirmed' : 'unconfirmed';
}

/**
 * The one predicate, read off the projected read-model columns rather than an
 * in-memory `ObjectRecord`. The read model stores who accepted as an
 * `actor_kind` (`accepted_by_kind`) and a nullable `human_touched_at` — exactly
 * the two inputs above. This adapts that shape and **delegates to
 * `epistemicStateOf`**, so a mutation of the predicate moves the rendered `✓`
 * the same way it moves the reducer's gate: there is one answer, and this is how
 * the web asks it.
 */
export function epistemicStateFromAcceptance(
  acceptedByKind: Actor['kind'],
  humanTouchedAt: Timestamp | null,
): EpistemicState {
  return epistemicStateOf({ acceptedBy: { kind: acceptedByKind }, humanTouchedAt });
}

/** The glyph the UI renders. Never invent a third one. */
export function epistemicGlyph(record: ObjectRecord): '~' | '✓' {
  return epistemicStateOf(record) === 'confirmed' ? '✓' : '~';
}

/**
 * When the object became a fact, or `null` while it is still a reading.
 * `acceptedAt` when a human accepted it outright — including the answer-binding
 * path, which is a human writing a decision directly — otherwise the moment a
 * human first corrected it.
 */
export function confirmedAt(record: ObjectRecord): string | null {
  if (isHuman(record.acceptedBy)) return record.acceptedAt;
  return record.humanTouchedAt;
}
