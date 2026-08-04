import { describe, expect, it } from 'vitest';
import { typedReferenceBody } from '../lib/replay-view';
import {
  normalizeMessageReferences,
  reconcileMessageReferences,
} from '../src/lib/typed-references';

describe('typed reference spans', () => {
  /* CATCHES: counting Unicode code points instead of the UTF-16 offsets used by
     textarea selection and String#slice, shifting a reference after emoji. */
  it('uses UTF-16 offsets and preserves the exact authored surface', () => {
    const text = '👋 ask @sam';
    const reference = normalizeMessageReferences(text, [
      { kind: 'human', targetId: 'u2', start: 7, end: 11, surface: '@sam' },
    ]);
    expect(reference[0]).toMatchObject({ start: 7, end: 11 });
    expect(text.slice(reference[0]?.start, reference[0]?.end)).toBe('@sam');
  });

  /* CATCHES: dropping a selected stable target when ordinary text is inserted
     strictly before it instead of shifting both offsets by the edit delta. */
  it('shifts an intact reference after an earlier edit', () => {
    const before = 'ask @sam';
    const after = 'please ask @sam';
    expect(
      reconcileMessageReferences(before, after, [
        { ordinal: 0, kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@sam' },
      ]),
    ).toEqual([{ ordinal: 0, kind: 'human', targetId: 'u2', start: 11, end: 15, surface: '@sam' }]);
  });

  /* CATCHES: treating the one computed edit delta as applicable to every
     reference, moving an earlier token when the user only appends text. */
  it('leaves a reference unchanged when the edit is wholly after it', () => {
    const reference = {
      ordinal: 0,
      kind: 'human' as const,
      targetId: 'u2',
      start: 4,
      end: 8,
      surface: '@sam',
    };
    expect(reconcileMessageReferences('ask @sam', 'ask @sam please', [reference])).toEqual([
      reference,
    ]);
  });

  /* CATCHES: retaining a stable target after the person edits its authored
     token, leaving metadata that identifies words the stored body no longer
     contains. */
  it('invalidates a reference when an edit touches its surface', () => {
    expect(
      reconcileMessageReferences('ask @sam today', 'ask @pam today', [
        { ordinal: 0, kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@sam' },
      ]),
    ).toEqual([]);
  });

  /* CATCHES: shifting every reference after an edit even when some references
     precede it, or applying the delta to only the first later reference. */
  it('updates multiple references independently around one edit', () => {
    expect(
      reconcileMessageReferences('ask @sam then @plan', 'ask @sam and then @plan', [
        { ordinal: 0, kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@sam' },
        {
          ordinal: 1,
          kind: 'proposal',
          targetId: 'p1',
          start: 14,
          end: 19,
          surface: '@plan',
        },
      ]),
    ).toEqual([
      { ordinal: 0, kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@sam' },
      {
        ordinal: 1,
        kind: 'proposal',
        targetId: 'p1',
        start: 18,
        end: 23,
        surface: '@plan',
      },
    ]);
  });

  /* CATCHES: deduplicating references by target id. Mentioning the same stable
     person twice is two authored spans even though it routes one attention. */
  it('retains duplicate targets at distinct spans and assigns authored order', () => {
    const body = '@sam ask @sam';
    expect(
      normalizeMessageReferences(body, [
        { kind: 'human', targetId: 'u2', start: 9, end: 13, surface: '@sam' },
        { kind: 'human', targetId: 'u2', start: 0, end: 4, surface: '@sam' },
      ]),
    ).toEqual([
      { ordinal: 0, kind: 'human', targetId: 'u2', start: 0, end: 4, surface: '@sam' },
      { ordinal: 1, kind: 'human', targetId: 'u2', start: 9, end: 13, surface: '@sam' },
    ]);
  });

  /* CATCHES: assigning an ordinal before checking the authored slice and then
     sending a mismatched surface as a trusted reference. */
  it('drops a mismatched surface during normalization', () => {
    expect(
      normalizeMessageReferences('ask @sam', [
        { kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@pat' },
      ]),
    ).toEqual([]);
  });

  /* CATCHES: assigning ordinals before invalid surfaces are removed, leaving
     the first valid reference numbered 1 and making the server refuse it. */
  it('numbers the valid references only after invalid metadata is removed', () => {
    expect(
      normalizeMessageReferences('@bad then @sam', [
        { kind: 'object', targetId: 'o1', start: 0, end: 4, surface: '@nope' },
        { kind: 'human', targetId: 'u2', start: 10, end: 14, surface: '@sam' },
      ]),
    ).toEqual([{ ordinal: 0, kind: 'human', targetId: 'u2', start: 10, end: 14, surface: '@sam' }]);
  });

  /* CATCHES: using a renamed target's current label as message text. Resolution
     may change; the authored token under the author's name may not. */
  it('renders authored text while exposing current resolution separately', () => {
    const body = typedReferenceBody(
      'ask @sam',
      [{ ordinal: 0, kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@sam' }],
      () => ({ kind: 'human', targetId: 'u2', label: 'Samuel' }),
    );
    expect(body).toEqual([
      { kind: 'text', text: 'ask ' },
      {
        kind: 'mention',
        text: 'sam',
        referenceKind: 'human',
        targetId: 'u2',
        resolution: 'Samuel',
      },
    ]);
  });

  /* CATCHES: partially applying corrupt reference metadata and presenting it as
     verified markup. A mismatched span falls back to the unmodified raw body. */
  it('refuses markup for a stored span whose surface does not match', () => {
    expect(
      typedReferenceBody(
        'ask @sam',
        [{ ordinal: 0, kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@pat' }],
        () => undefined,
      ),
    ).toBeUndefined();
  });

  /* CATCHES: reconstructing the message from resolved labels, omitting the text
     between references, or ordering segments by target id instead of ordinal. */
  it('segments multiple references without changing any authored character', () => {
    const body = 'Ask @sam about @plan.\nSee @image';
    const segments = typedReferenceBody(
      body,
      [
        {
          ordinal: 2,
          kind: 'attachment',
          targetId: 'a1',
          start: 26,
          end: 32,
          surface: '@image',
        },
        { ordinal: 0, kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@sam' },
        {
          ordinal: 1,
          kind: 'proposal',
          targetId: 'p1',
          start: 15,
          end: 20,
          surface: '@plan',
        },
      ],
      (kind, targetId) => ({ kind, targetId, label: `current:${targetId}` }),
    );
    expect(segments).toEqual([
      { kind: 'text', text: 'Ask ' },
      {
        kind: 'mention',
        text: 'sam',
        referenceKind: 'human',
        targetId: 'u2',
        resolution: 'current:u2',
      },
      { kind: 'text', text: ' about ' },
      {
        kind: 'mention',
        text: 'plan',
        referenceKind: 'proposal',
        targetId: 'p1',
        resolution: 'current:p1',
      },
      { kind: 'text', text: '.\nSee ' },
      {
        kind: 'mention',
        text: 'image',
        referenceKind: 'attachment',
        targetId: 'a1',
        resolution: 'current:a1',
      },
    ]);
    expect(
      segments
        ?.map((segment) => (segment.kind === 'mention' ? `@${segment.text}` : segment.text))
        .join(''),
    ).toBe(body);
  });

  /* CATCHES: rendering two overlapping spans as if both were independently
     verified, duplicating or re-attributing some of the person's words. */
  it('refuses overlapping stored spans rather than partially segmenting them', () => {
    expect(
      typedReferenceBody(
        'ask @sam',
        [
          { ordinal: 0, kind: 'human', targetId: 'u2', start: 4, end: 8, surface: '@sam' },
          { ordinal: 1, kind: 'object', targetId: 'o1', start: 6, end: 8, surface: 'am' },
        ],
        () => undefined,
      ),
    ).toBeUndefined();
  });
});
