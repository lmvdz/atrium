export type MessageReferenceKind = 'human' | 'attachment' | 'proposal' | 'object';

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
    .map((reference, ordinal) => ({ ...reference, ordinal }))
    .filter((reference) => body.slice(reference.start, reference.end) === reference.surface);
}
