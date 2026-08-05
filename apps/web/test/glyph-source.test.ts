/* ---------------------------------------------------------------------------
 * A HAND-WRITTEN GLYPH IS UNSPELLABLE — ROUND 10, D1.
 *
 * The defect: `Rail.tsx:149` printed a literal `<span aria-hidden="true">◆</span>`
 * beside `room.owed`. On `/` that chip read `◆4` in amber forty pixels from a pin
 * head reading `■` over the same four items, whose open card says "destructive,
 * and not undoable"; on `/gallery/pin/34` it read `◆34` beside a pin headed `✗`.
 * It is the one report of what is owed in a room you are NOT standing in, so
 * nothing else on screen could correct it.
 *
 * `records.ts:809` already said "Every aggregate glyph below is derived from the
 * items it counts", and that comment is TRUE — it scopes itself to its own file
 * and holds there. The rail lives elsewhere and was never brought in.
 * `pin-bound.test.tsx:122` and `mutations.mjs:258` guard exactly this on the pin
 * head; nothing guarded the rail. A rule enforced at the addresses somebody
 * remembered is a rule with an unbounded set of addresses nobody has.
 *
 * SO THE RULE IS ENFORCED THREE WAYS, AND THIS FILE IS THE THIRD.
 *
 *   1. TYPE. `RoomSummary.owed` is an `OwedSummary` — a branded tagged union
 *      carrying the count AND the hardest owed item's state, whose only
 *      constructor is `owedSummary(items)`. The rail cannot draw a glyph beside a
 *      number any more, because there is no number to draw it beside; it is
 *      handed a state and `<Glyph>` derives the character, the tone and the
 *      tooltip from it. `ComposerBinding`'s bound arm is the same shape via
 *      `boundTo(item, objective)`. And `NoGlyph` already makes `<X glyph="◆" />`
 *      a compile error at every component that renders one.
 *   2. RENDER. `glyph-render.test.tsx` flips the hardest item in a set and asserts
 *      every aggregate glyph on the page moves with it — the pin head, the rail
 *      chip, the composer banner and the feed tag. A derived glyph that ignores
 *      its input is not derived.
 *   3. SOURCE, HERE. The characters may not be written down outside the module
 *      that owns the vocabulary.
 *
 * WHAT THIS ENUMERATES FROM: every file Next compiles into the app — the shared
 * `test/app-sources.ts` denominator, the same one `printed-strings.test.tsx`
 * uses and asserts equal to tsc's project parse, the module graph and Next's
 * route conventions. Within each file it reads the AST and looks at STRING
 * LITERALS, TEMPLATE LITERALS and JSX TEXT: everything that can become a
 * character on screen. `node.text` rather than `getText()`, so `'◆'` is
 * caught as readily as `'◆'`.
 *
 * WHAT IT CANNOT SEE, stated because a check that does not say this is a check
 * whose gaps get found by a critic instead:
 *
 *   - COMMENTS ARE NOT LITERALS, and that is deliberate: half the docblocks in
 *     this repo quote the glyphs they are about, including this one. A comment
 *     does not render.
 *   - THREE OF THE SEVEN GLYPHS ARE ALSO PUNCTUATION IN THIS CORPUS, and are
 *     therefore outside the character rule: `·` is the separator between every
 *     pair of facts on the page (`list()` joins with it, `'claim · unverified'`
 *     contains it, `initials()` falls back to it), `?` ends questions, and `~`
 *     appears in prose. A rule banning those characters would report thirty
 *     honest separators and be turned off within a round, which is worse than a
 *     narrower rule that is believed. The four it DOES cover — `✓ ✗ ◆ ■` — have
 *     no other use in this product, so for them the rule is absolute and has no
 *     exemption list at all. For the other three, layers 1 and 2 above are what
 *     hold: a component cannot construct a mark position without `<Glyph>`,
 *     and the r9 pin's `{headGlyph ?? '·'}` — the one real instance — is gone
 *     with `AggregateGlyph`, which renders nothing for an empty set.
 *   - A CHARACTER COMPUTED AT RUNTIME. `String.fromCharCode(9670)`,
 *     `atob(…)`, a glyph arriving from a server. Nothing in this app does that
 *     and this sweep would not see it if it did.
 *   - THE STYLESHEETS. `content: '◆'` in CSS is not a TypeScript literal. No rule
 *     in this app uses `content` for anything but the empty string today; the
 *     CSS sweep in `printed-strings.test.tsx` derives its `attr()` set from the
 *     stylesheets and reports none, which is the measurement, not an assumption.
 * ------------------------------------------------------------------------- */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { GLYPHS } from '../src/components/model';
import { SOURCES, WEB } from './app-sources';
import { glyphLiterals, UNAMBIGUOUS } from './glyph-literals';

/**
 * THE MODULE THAT OWNS THE VOCABULARY. The one place the characters exist.
 *
 * Not a list of allowed files — a list of one, which is the point. Adding a
 * second entry here is a diff a reviewer sees; adding a `<span>◆</span>` to a
 * component was not.
 */
const VOCABULARY = 'src/components/model/glyph.ts';

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const FOUND = SOURCES.flatMap((path) => glyphLiterals(parse(path), relative(WEB, path)));

describe('a glyph is written down in exactly one module', () => {
  /* CATCHES the sweep going blind. A rule that reads no files reports exactly
     like a rule with nothing to report — the `graphicsChecked > 10` shape. The
     vocabulary module must be IN the file set and must contain all four, or the
     denominator is wrong and the empty result below means nothing. */
  it('there is a vocabulary to enumerate, in files read off the filesystem', () => {
    expect(SOURCES.length, 'the sweep found almost no app files').toBeGreaterThan(24);
    expect(
      SOURCES.map((path) => relative(WEB, path)),
      'the vocabulary module is not in the file set this sweep reads',
    ).toContain(VOCABULARY);
    const owned = FOUND.filter((finding) => finding.file === VOCABULARY);
    expect(
      [...new Set(owned.flatMap((finding) => finding.glyphs))].sort(),
      'the vocabulary module does not spell all four unambiguous glyphs, so this rule is measuring nothing',
    ).toEqual([...UNAMBIGUOUS].sort());
    console.info(
      `glyph source: ${SOURCES.length} files · ${FOUND.length} literals carrying a glyph · ${owned.length} of them in ${VOCABULARY}`,
    );
  });

  /* CATCHES the whole class, at any address rather than at the five a critic
     names: `Rail.tsx`'s `<span aria-hidden="true">◆</span>`, `Composer.tsx`'s
     `◆` in the ANSWERING banner, `fixtures.ts`'s `'✗ failed · needs an
     explanation'` and `'resolves ◆ · …'` and `'you followed the source of ◆ P1'`,
     the gallery caption's `■`, and the ones nobody has written yet.
     There is NO exemption list. Four characters, one file. */
  it('no file outside the vocabulary spells one', () => {
    expect(
      FOUND.filter((finding) => finding.file !== VOCABULARY).map(
        (finding) =>
          `${finding.file}:${finding.line} [${finding.kind}] ${finding.glyphs.join('')} in ${JSON.stringify(finding.text)}`,
      ),
      'a glyph is written down outside model/glyph.ts — it has to be derived through glyphFor, <Glyph> or <AggregateGlyph>',
    ).toEqual([]);
  });

  /* AND THE VOCABULARY IS THE SEVEN THE MODULE DECLARES. If an eighth glyph is
     added, `UNAMBIGUOUS` is a list this file wrote and the new one would be
     outside it silently — so the relationship between the two is asserted rather
     than assumed. `GLYPHS` is derived from `GLYPH_HARDNESS`, which is
     exhaustive by type. */
  it('the four it covers are four of the seven, and the other three are named', () => {
    expect(GLYPHS.length).toBe(7);
    expect(UNAMBIGUOUS.every((glyph) => (GLYPHS as readonly string[]).includes(glyph))).toBe(true);
    expect(
      GLYPHS.filter((glyph) => !UNAMBIGUOUS.includes(glyph)).sort(),
      'a glyph is outside the character rule and is not one of the three the header explains',
    ).toEqual(['?', '~', '·']);
  });
});

/* ---------------------------------------------------------------------------
 * THE ENUMERATOR'S OWN SELF-TEST.
 * ------------------------------------------------------------------------- */
describe('the glyph sweep sees every way a character reaches the screen', () => {
  function sweep(source: string, name = 'probe.tsx'): readonly string[] {
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    return glyphLiterals(file, name).map((finding) => `${finding.kind}:${finding.glyphs.join('')}`);
  }

  it('sees the exact shape the rail shipped', () => {
    expect(sweep('export const A = () => <span aria-hidden="true">◆</span>;')).toEqual([
      'jsx-text:◆',
    ]);
  });

  it('sees a string literal, a bare template, and both ends of an interpolated one', () => {
    expect(sweep("export const a = '✗ failed · needs an explanation';")).toEqual(['string:✗']);
    expect(sweep('export const b = `resolves ◆ · answer-bound`;')).toEqual(['template:◆']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the probe source IS a template literal — the placeholder is what splits it into a head and a tail, which is the shape under test.
    expect(sweep('export const c = `head ■ ${x} tail ✓`;')).toEqual([
      'template-span:■',
      'template-span:✓',
    ]);
  });

  /* A UNICODE ESCAPE IS THE SAME CHARACTER. `node.text` is the cooked value, so
     writing it the long way is not a way around the rule. */
  it('sees a glyph written as an escape', () => {
    expect(sweep("export const d = '\\u25C6';")).toEqual(['string:◆']);
  });

  /* AND IT DOES NOT SEE COMMENTS, which is deliberate — this repo's docblocks
     are the record of what each round found and they quote the glyphs. */
  it('does not report a comment', () => {
    expect(
      sweep(`
        /* a pin holding one ■ and eight ✗ headed by a hand-written ◆ is a claim */
        // and ✓ here too
        export const e = 1;
      `),
    ).toEqual([]);
  });

  /* BOTH DIRECTIONS: a derived glyph has no character in the source at all, and
     that is exactly what the rule is asking every component to look like. */
  it('does not report a glyph that is derived', () => {
    expect(
      sweep(`
        export function Tally({ counts }: any) {
          return <span>{counts.map((c: any) => c.glyph)}</span>;
        }
        export const f = glyphFor(state);
        export const g = \`resolves \${glyphFor(item.state)} · answer-bound\`;
      `),
    ).toEqual([]);
  });

  /* …AND IT DOES NOT REPORT THE THREE THE HEADER EXCLUDES, which is the honest
     half of the limit: were it to, `list()`'s separator and every "claim ·
     unverified" tag in the corpus would be findings and the rule would be
     switched off. */
  it('does not report the separator, the question mark or the tilde', () => {
    expect(sweep("export const h = 'claim · unverified'; export const i = 'why? ~ish';")).toEqual(
      [],
    );
  });
});
