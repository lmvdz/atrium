/* ---------------------------------------------------------------------------
 * NO `undefined` IN THE RECORD.
 *
 * The ticket's fourth rule: "No optional field reaches a rendered string
 * unguarded (no `undefined` in any record text)."
 *
 * Two halves.
 *
 * TYPE LEVEL — record text is never `string | undefined`. Anything that may be
 * absent is `Maybe<string>`, i.e. `string | null`. `null` is a value the author
 * had to write; `undefined` is what you get when you forget. React renders both
 * as nothing, but only one of them survives string concatenation without
 * printing the word "undefined" into a receipt.
 *
 * VALUE LEVEL — nothing is concatenated. `text()` normalises a `Maybe<string>`
 * to `string | null` (empty and whitespace collapse to null), and `list()`
 * joins only the parts that are actually there. A `·` separator between two
 * facts is only rendered when there are two facts.
 *
 * RUNTIME BOUNDARY (added after round 1). The type level only holds for data
 * that came through TypeScript. `undefined` from a cast, a JSON payload or a
 * JavaScript caller passes `!== null` and renders as the literal string
 * "undefined" the moment anything concatenates it — the round-1 gauntlet found
 * `source in #undefined` reachable exactly that way. `text()` and `maybe()`
 * therefore treat `undefined` as absent at runtime, so the value level holds
 * even where the type level did not reach.
 * ------------------------------------------------------------------------- */

/** Explicitly absent. Never `undefined` — see the note above. */
export type Maybe<T> = T | null;

/**
 * The runtime boundary for `Maybe`. Anything absent — `null`, `undefined`, an
 * empty or whitespace-only string — becomes `null`; a non-string becomes `null`
 * rather than printing "[object Object]" into a receipt.
 */
export function maybe(value: unknown): Maybe<string> {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Normalise to renderable-or-nothing. Empty and whitespace-only become null,
 * and so does `undefined` — see the runtime-boundary note above. The parameter
 * accepts `undefined` on purpose: refusing it at the type level would only move
 * the failure to a call site that has an `any` in it.
 */
export function text(value: Maybe<string> | undefined): string | null {
  return maybe(value);
}

/**
 * Join facts with the corpus's `·` separator, dropping absent ones. Returns
 * null rather than an empty string so a caller can render nothing at all
 * instead of an empty element with padding.
 */
export function list(
  parts: readonly (Maybe<string> | undefined)[],
  separator = ' · ',
): string | null {
  const present = parts.map(text).filter((part): part is string => part !== null);
  return present.length === 0 ? null : present.join(separator);
}

/** "1 item" / "2 items" — counts in the record are never "1 items". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Two initials for an avatar. Never returns an empty string. */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '··';
  const parts = trimmed.split(/[\s._-]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return '··';
  const first = parts[0] ?? '';
  const second = parts[1];
  if (second !== undefined) {
    return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
  }
  return first.slice(0, 2).toUpperCase();
}
