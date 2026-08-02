/* ---------------------------------------------------------------------------
 * "WHY DOES THIS NEED YOU" — required, at the type level.
 *
 * BRIEF concept 8: every needs-you item carries a machine-stated reason naming
 * the person and the authority gap. Attention routing is only trusted if it can
 * justify itself.
 *
 * The ticket's rule is "AttentionCard's rationale is required and non-empty at
 * the type level; there is no way to render an attention item without one." A
 * required `rationale: string` prop gets you half of that — you can still pass
 * `''`. So `Rationale` is a branded string with a throwing smart constructor:
 * required by the prop, non-empty by the only constructor.
 *
 * The rationale is always SYSTEM VOICE. It is a synthesized sentence about the
 * authority gap, so per the no-synthesized-speech invariant it may never be
 * quoted or attributed to a person — which is why it is its own type rather
 * than a `Quotation`.
 * ------------------------------------------------------------------------- */

import { systemVoiceDefect } from './quotation';

declare const rationaleBrand: unique symbol;

/** A non-empty, system-voice reason this item is owed to this person. */
export type Rationale = string & { readonly [rationaleBrand]: 'rationale' };

/**
 * A BOUND ON THE SENTENCE, NOT A CLAIM ABOUT THE LAYOUT.
 *
 * This constant used to be documented as "short enough to survive the pin's line
 * budget; a clipped reason is not one", and its throw said so: "a rationale that
 * gets clipped is not a rationale". Round 6 measured it: every shipped rationale
 * is under the cap and every compressed row clips anyway — 321 of 777px, 199 of
 * 801px, 379 of 680px at 1440, three of three. The cap guarded a QUANTITY OF
 * CHARACTERS and the clip happens at a NUMBER OF PIXELS in a flex track whose
 * width the constructor cannot see. A guard that cannot observe the thing it
 * claims to prevent is decoration.
 *
 * So the cap stays for what it can honestly say — a reason nobody reads to the
 * end explains nothing, and 240 characters is the length past which this is
 * prose rather than a reason — and the CLIPPING guarantee moved to where the
 * clipping happens: `AttentionCompact` clamps, marks the clamped element
 * `data-truncates`, and the full text is one non-hover click away in the open
 * card. See CONVENTIONS, "truncation owes the reader a route".
 */
const RATIONALE_MAX = 240;

export function rationale(text: string): Rationale {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'rationale: an attention item without a reason is an unexplained demand on a person',
    );
  }
  if (trimmed.length > RATIONALE_MAX) {
    throw new Error(
      `rationale: ${trimmed.length} characters is prose, not a reason — an explanation nobody reads to the end explains nothing (max ${RATIONALE_MAX}).\n` +
        '  This is a bound on the sentence. Whether it is CLIPPED is a fact about a pixel width no constructor can see, and it is guaranteed at the renderer instead.',
    );
  }
  /* IT IS SYSTEM VOICE, SO IT IS HELD TO SYSTEM VOICE. The comment above has
     said so since round 1 and nothing enforced it — `rationale('priya said: I
     approve the drop')` compiled and rendered under `data-voice="system"` in the
     pin, in the treatment that tells a reader the system checked this. Found by
     the round-5 blind review; it is the round-3 `systemStatement` finding in the
     type next door, which is what happens when doctrine is written for one
     page-authored string and applied to one page-authored string. */
  const defect = systemVoiceDefect(trimmed);
  if (defect !== null) {
    throw new Error(
      `rationale: ${defect}.\n  A rationale is the system explaining an authority gap; it is never somebody's words.`,
    );
  }
  return trimmed as Rationale;
}

export function isRationale(value: unknown): value is Rationale {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= RATIONALE_MAX &&
    systemVoiceDefect(value) === null
  );
}

/**
 * THE RENDER BOUNDARY FOR A RATIONALE — `statementText`, for the other
 * page-authored string type.
 *
 * Round 5 found four components printing `statement.text` directly and wrote
 * `statementText()` so that every system-voice string went through one checked
 * path. It applied that to ONE of the two page-authored string types. `Rationale`
 * kept its constructor check and its parser check and had no renderer check at
 * all, so `AttentionCard` and `AttentionCompact` printed `{item.rationale}` raw
 * — including into two `title=` attributes — under `data-voice="system"`, and a
 * cast or a `JSON.parse` put a first-person sentence into the mono-muted
 * treatment that tells a reader the system checked this.
 *
 * "A guarantee held at the constructor and at the parser is still not held at
 * the renderer" was already written down. It was applied to one type.
 */
export function rationaleText(value: Rationale, from: string): string {
  /* Snapshot first, then check, then return the snapshot — the same
     time-of-check/time-of-use discipline `<SystemVoice>` uses. A `Rationale` is
     a primitive string in practice, but it arrives typed as one and may not be:
     `String(value)` is what makes the thing checked and the thing painted the
     same value. */
  const painted = String(value);
  if (!isRationale(painted)) {
    throw new Error(
      `${from}: this is not a rationale — an attention item's reason is the system explaining an authority gap, in the system's own voice (no quotation marks, no first person, no "X said" framing), non-empty, and at most ${RATIONALE_MAX} characters.\n` +
        `  rejected: ${JSON.stringify(painted.slice(0, 120))}`,
    );
  }
  return painted;
}
