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

/** Short enough to survive the pin's line budget; a clipped reason is not one. */
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
      `rationale: ${trimmed.length} characters will be clipped by the pin; a rationale that gets clipped is not a rationale (max ${RATIONALE_MAX})`,
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
