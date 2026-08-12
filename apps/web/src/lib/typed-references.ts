export type MessageReferenceKind = 'human' | 'agent' | 'attachment' | 'proposal' | 'object';

/** Authored reference metadata sent on the wire. Offsets are JavaScript UTF-16 indices. */
export interface MessageReference {
  readonly ordinal: number;
  readonly kind: MessageReferenceKind;
  readonly targetId: string;
  readonly start: number;
  readonly end: number;
  readonly surface: string;
}

export interface ReferenceTarget {
  readonly kind: MessageReferenceKind;
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

/**
 * The composer's mention candidates, derived from the room roster.
 *
 * A candidate is any NAMEABLE participant — a person OR an agent (#100) — and the
 * filter ALLOWLISTS those two identity kinds rather than denylisting the rest. So
 * `'unknown'` — the fail-closed rendering of a participant whose kind could not be
 * read — is never offered as a mention target, and a later identity kind added to
 * the roster stays out until it is named here on purpose (never fails open). Each
 * candidate keeps its own kind, so the reference that lands records whether a
 * person or an agent was named.
 *
 * This is the ONE definition of that rule, so the live composer and its test read
 * the same computation. A test that re-implements the filter locally proves only
 * that it can copy the code; it must call this.
 */
export function mentionCandidateTargets(
  participants: readonly { readonly kind: string; readonly id: string; readonly name: string }[],
): readonly ReferenceTarget[] {
  return participants.flatMap((participant) =>
    participant.kind === 'human' || participant.kind === 'agent'
      ? [{ kind: participant.kind, id: participant.id, label: participant.name }]
      : [],
  );
}

/**
 * Carry references across a single textarea edit. A change wholly before a
 * reference shifts it; a change wholly after it leaves it alone; touching any
 * byte of its authored surface invalidates it. The body remains exactly what
 * the person typed either way.
 */
export function reconcileMessageReferences(
  before: string,
  after: string,
  references: readonly MessageReference[],
): readonly MessageReference[] {
  if (before === after) return references;
  let prefix = 0;
  const shared = Math.min(before.length, after.length);
  while (prefix < shared && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldEnd = before.length - suffix;
  const delta = after.length - before.length;
  return references.flatMap((reference) => {
    if (reference.end <= prefix) return [reference];
    if (reference.start >= oldEnd) {
      const start = reference.start + delta;
      const end = reference.end + delta;
      return [{ ...reference, start, end }];
    }
    return [];
  });
}

export function normalizeMessageReferences(
  body: string,
  references: readonly Omit<MessageReference, 'ordinal'>[],
): readonly MessageReference[] {
  return [...references]
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter((reference) => body.slice(reference.start, reference.end) === reference.surface)
    .map((reference, ordinal) => ({ ...reference, ordinal }));
}
