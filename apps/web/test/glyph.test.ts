import { describe, expect, it } from 'vitest';
import type { EpistemicState, Glyph, ObjectKind, Verification } from '../src/components/model';
import { glyphFor, glyphTone, isClaim, needsViewer } from '../src/components/model';

function state(input: Partial<EpistemicState>): EpistemicState {
  return {
    kind: 'claim',
    verification: 'unverified',
    owedToViewer: false,
    irreversible: false,
    ...input,
  };
}

describe('glyphFor — the derivation table', () => {
  /* CATCHES: any reordering or rewriting of the branches in glyphFor(). Each
     row is a state the app actually renders, so a mutation that (say) lets
     `owedToViewer` win over `failed`, or drops the `question` special case,
     turns exactly one row red and names it. */
  const table: readonly (readonly [string, Partial<EpistemicState>, Glyph])[] = [
    ['a failure outranks everything', { verification: 'failed', owedToViewer: true }, '✗'],
    [
      'an irreversible owed decision is ■, not ◆',
      { kind: 'decision', verification: 'proposed', owedToViewer: true, irreversible: true },
      '■',
    ],
    [
      'a reversible owed decision is ◆',
      { kind: 'decision', verification: 'proposed', owedToViewer: true },
      '◆',
    ],
    [
      'an owed question is ?, not ◆',
      { kind: 'question', verification: 'open', owedToViewer: true },
      '?',
    ],
    ['an unowed open question is ?', { kind: 'question', verification: 'open' }, '?'],
    ['verified is ✓', { verification: 'verified' }, '✓'],
    ['accepted is ✓', { kind: 'decision', verification: 'accepted' }, '✓'],
    ['proposed is ~', { verification: 'proposed' }, '~'],
    ['unverified is ~', { verification: 'unverified' }, '~'],
    ['self-reported is ~', { verification: 'self_reported' }, '~'],
    ['routine is ·', { kind: 'event', verification: 'routine' }, '·'],
  ];

  for (const [name, input, expected] of table) {
    it(name, () => {
      expect(glyphFor(state(input))).toBe(expected);
    });
  }

  /* CATCHES: removing the `!SETTLED.has(...)` guard from needsViewer(). Without
     it, a caller that leaves a stale `owedToViewer: true` on an accepted object
     turns a settled ✓ back into an amber ◆ — a settled thing demanding
     attention it no longer needs. */
  it('a settled object is never owed, whatever the caller says', () => {
    expect(glyphFor(state({ verification: 'accepted', owedToViewer: true }))).toBe('✓');
    expect(glyphFor(state({ verification: 'verified', owedToViewer: true }))).toBe('✓');
    expect(needsViewer(state({ verification: 'accepted', owedToViewer: true }))).toBe(false);
  });

  /* CATCHES: deriving the dotted underline from the GLYPH instead of from the
     verification — the round-2 defect the prototype recorded. A proposal that
     is also a gate renders ◆, and if isClaim() read the glyph it would stop
     being dotted, so an unchecked proposal would dress as settled prose. */
  it('a proposal that is also a gate is still a claim', () => {
    const gate = state({ kind: 'decision', verification: 'proposed', owedToViewer: true });
    expect(glyphFor(gate)).toBe('◆');
    expect(isClaim(gate)).toBe(true);
  });

  /* CATCHES: widening the claim set. `open` and `routine` are not claims — an
     open question is explicitly unanswered, not somebody's unchecked account —
     and dotting them would make the underline mean nothing. */
  it('only the three unsettled verifications are claims', () => {
    const claims: readonly Verification[] = ['proposed', 'unverified', 'self_reported'];
    const notClaims: readonly Verification[] = [
      'verified',
      'accepted',
      'open',
      'failed',
      'routine',
    ];
    for (const verification of claims) {
      expect(isClaim(state({ verification }))).toBe(true);
    }
    for (const verification of notClaims) {
      expect(isClaim(state({ verification }))).toBe(false);
    }
  });

  /* CATCHES: a hue picked by hand. The tone is a pure function of the glyph, so
     green can never land on anything but ✓, and amber can never land on a
     failure. If someone adds a `tone` prop to a component, this is the contract
     it would have to break. */
  it('the tone is derived from the glyph and nothing else', () => {
    expect(glyphTone('✓')).toBe('verified');
    expect(glyphTone('◆')).toBe('needs');
    expect(glyphTone('?')).toBe('needs');
    expect(glyphTone('■')).toBe('destructive');
    expect(glyphTone('✗')).toBe('failed');
    expect(glyphTone('~')).toBe('neutral');
    expect(glyphTone('·')).toBe('neutral');
  });

  /* CATCHES: adding a verification or an object kind without extending the
     derivation. Every combination must produce one of the seven glyphs; a new
     enum member that falls through to `undefined` fails here rather than
     rendering a blank column in the feed. */
  it('every kind × verification pair produces a glyph in the vocabulary', () => {
    const kinds: readonly ObjectKind[] = ['decision', 'commitment', 'question', 'claim', 'event'];
    const verifications: readonly Verification[] = [
      'verified',
      'accepted',
      'proposed',
      'unverified',
      'self_reported',
      'open',
      'failed',
      'routine',
    ];
    const vocabulary: readonly Glyph[] = ['✓', '~', '?', '·', '◆', '■', '✗'];
    for (const kind of kinds) {
      for (const verification of verifications) {
        for (const owedToViewer of [false, true]) {
          for (const irreversible of [false, true]) {
            const glyph = glyphFor({ kind, verification, owedToViewer, irreversible });
            expect(vocabulary).toContain(glyph);
          }
        }
      }
    }
  });
});
