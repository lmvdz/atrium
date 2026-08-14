/* ---------------------------------------------------------------------------
 * THE DOORS AGREE WITH EACH OTHER. The COUNT moved out of this file.
 *
 * This file used to hold the sweep as well, and its denominator was the set of
 * elements carrying `data-voice="system"`. Its own header named the recurring
 * failure — "the address came from a receipt instead of from a count" — and then
 * committed it one level in: **the set of page-authored string sinks is not the
 * set of elements the page chose to mark.** The blind cross-lineage review of
 * round 6's fix walked out of that denominator and found four sinks outside it,
 * two of them in the receipt:
 *
 *   `ProvenanceEntry.note`     printed inside the same `<button>` as a resolved
 *                              quotation, on the line immediately after the
 *                              quoted words, under one `data-attribution`.
 *   `CorrectionEntry.heading`  in the exact layout slot round 6 had just deleted
 *                              `HappenedLine.who` from.
 *   `RowTag.label`             welded onto the end of a person's own sentence.
 *   `AttentionItem.facts`      the open card's meta line.
 *
 * A denominator taken from an attribute the page writes is "a denominator
 * supplied by the claim", which is what CONVENTIONS' harness section condemns.
 * The sweep is now `test/printed-strings.test.tsx`, whose denominator is every
 * `{…}` the page renders and every announced-text attribute it sets, in every
 * file under `src/components` and `app`, read off the filesystem — with the
 * provenance of each traced back to a literal, the record register, or a door.
 *
 * WHAT STAYS HERE is the part that sweep cannot check: that the doors mean the
 * same thing. A statement one door refuses and another accepts is the exemption
 * this whole class of defect is made of, and no amount of counting call sites
 * finds it.
 * ------------------------------------------------------------------------- */

import { describe, expect, it } from 'vitest';
import {
  FILE_TEXT_MAX,
  fileText,
  offeredText,
  systemStatement,
  systemText,
  systemVoiceDefect,
} from '../src/components/model';

describe('the doors that page-authored strings reach the screen through', () => {
  /* CATCHES: `systemText` becoming a pass-through — the door with no constructor
     behind it, so it is the whole guarantee for the strings that go through it. */
  it('the system door applies the same rule as the constructor', () => {
    expect(() => systemText('priya said the drop is fine', 'test')).toThrow(/no "X said"/);
    expect(() => systemText('I approve the drop', 'test')).toThrow(/no first person/);
    expect(() => systemText('“approved”', 'test')).toThrow(/no quotation marks/);
    expect(systemText('12:29', 'test')).toBe('12:29');
    expect(systemText('identity-service', 'test')).toBe('identity-service');
  });

  /* CATCHES: the doors drifting apart. They exist because the values have
     different shapes, not because the rule differs — a statement refused by one
     and accepted by another is the exemption this class of defect is made of. */
  it('the doors agree on what the system’s voice is', () => {
    for (const bad of ['priya said the drop is fine', 'I approve', 'we agreed', '“x”']) {
      expect(systemVoiceDefect(bad), `${bad} is not refused`).not.toBeNull();
      expect(() => systemText(bad, 'test')).toThrow();
      expect(() => systemStatement(bad)).toThrow();
    }
  });

  /* ---------------------------------------------------------------------------
   * THE SECOND DOOR, AND THE EXACT SIZE OF ITS EXEMPTION.
   *
   * `offeredText` is the copy ON a control — a button's label, its tooltip. It
   * keeps its pronouns for the reason CONVENTIONS records after round 4: the
   * first-person ban applied to an option payload threw at render on "Keep it
   * behind our retention window", "Give us another day", "Yes — I approve" and
   * "Ship it, we agreed", which is every reversible one-click answer in the
   * product. What it may NOT do is wear quotation marks.
   *
   * The exemption is exactly one ban wide, and that is asserted here rather than
   * left to a reader comparing two functions. `test/printed-strings.test.tsx`
   * asserts the other half — that no call site is anywhere but a control.
   * ------------------------------------------------------------------------- */
  it('the offered door keeps pronouns and still refuses quotation marks', () => {
    expect(offeredText('Keep it behind our retention window', 'test')).toBe(
      'Keep it behind our retention window',
    );
    expect(offeredText('Give us another day', 'test')).toBe('Give us another day');
    expect(offeredText('Yes — I approve', 'test')).toBe('Yes — I approve');
    expect(offeredText('Ship it, we agreed', 'test')).toBe('Ship it, we agreed');
    /* …and the one thing that makes offered copy read as an utterance. */
    expect(() => offeredText('“I approve”', 'test')).toThrow(/no quotation marks/);
    expect(() => offeredText('he said "yes"', 'test')).toThrow(/no quotation marks/);
  });

  /* CATCHES: `offeredText` widening into `systemText`'s job — the two doors
     becoming one, in the lax direction. Every string the SYSTEM door refuses for
     quotation marks the OFFERED door must refuse too, and the difference between
     them is the other two bans and nothing else. */
  it('the offered door is weaker than the system door in exactly two bans', () => {
    const quoted = '“approved”';
    expect(() => systemText(quoted, 'test')).toThrow();
    expect(() => offeredText(quoted, 'test')).toThrow();
    /* first person and speech reports: refused by one, kept by the other */
    for (const payload of ['I approve', 'we agreed', 'she said it was fine']) {
      expect(() => systemText(payload, 'test')).toThrow();
      expect(offeredText(payload, 'test')).toBe(payload);
    }
  });

  /* ---------------------------------------------------------------------------
   * THE THIRD DOOR — VERBATIM FILE CONTENT (#145).
   *
   * `fileText` is for a line of a source diff, a hunk header, a changed path — the
   * record's own bytes, rendered inside the monospace diff treatment. It is NOT
   * held to any speech ban: real code is full of quotation marks, first person and
   * the word "said", and a speech rule would throw an ordinary diff (the same
   * failure the codebase records for the `next` URL parameter). Its job is a
   * provenance-and-shape assertion, not a voice check.
   *
   * CATCHES: `fileText` being "hardened" into a speech ban — which would crash the
   * review pane on the first real diff — and the length cap being dropped.
   * ------------------------------------------------------------------------- */
  it('the file door passes verbatim code that the speech doors would refuse', () => {
    for (const line of [
      '+const msg = "I approve dropping users_legacy";',
      '-  // we said this would ship on Friday',
      '@@ -1,4 +1,6 @@ function said(quote: string) {',
    ]) {
      // The speech doors would throw on every one of these…
      expect(() => systemText(line, 'test')).toThrow();
      // …and the file door passes them through unchanged.
      expect(fileText(line, 'test')).toBe(line);
    }
  });

  it('the file door caps an over-long line as a defensive second lock', () => {
    const huge = `+${'x'.repeat(FILE_TEXT_MAX + 500)}`;
    const out = fileText(huge, 'test');
    expect(out.length).toBeLessThanOrEqual(FILE_TEXT_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});
