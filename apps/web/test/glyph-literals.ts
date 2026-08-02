/* ---------------------------------------------------------------------------
 * THE GLYPH ENUMERATOR — every way a glyph character can be written into source.
 *
 * Its own module rather than the test file, for the reason `test/printed.ts` is:
 * an enumerator that is exported from a spec cannot be exercised by anything but
 * that spec, and this one has a self-test that has to be able to import it.
 * See `test/glyph-source.test.ts` for what the rule is and what it cannot see.
 * ------------------------------------------------------------------------- */

import type ts from 'typescript';
import tsm from 'typescript';

/**
 * The four glyphs that are ONLY ever glyphs. `·`, `?` and `~` are also
 * punctuation in this corpus — `list()` joins facts with the first, questions end
 * with the second — so the character rule cannot reach them and says so rather
 * than carrying an exemption list that would grow every round.
 */
export const UNAMBIGUOUS: readonly string[] = ['\u2713', '\u2717', '\u25C6', '\u25A0'];

export interface GlyphLiteral {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly text: string;
  readonly glyphs: readonly string[];
}

/**
 * Every string literal, template literal and JSX text in a source file that
 * contains one of the unambiguous glyphs.
 *
 * Exported for the self-test below: an enumerator with no self-test is a claim,
 * not a measurement (CONVENTIONS), and three of round 6's ten self-found defects
 * were holes in the enumerators that round wrote.
 */
export function glyphLiterals(file: ts.SourceFile, name: string): readonly GlyphLiteral[] {
  const out: GlyphLiteral[] = [];
  const record = (node: ts.Node, kind: string, text: string): void => {
    const glyphs = UNAMBIGUOUS.filter((glyph) => text.includes(glyph));
    if (glyphs.length === 0) return;
    out.push({
      file: name,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      kind,
      text: text.replace(/\s+/g, ' ').trim().slice(0, 100),
      glyphs,
    });
  };
  const visit = (node: ts.Node): void => {
    if (tsm.isStringLiteral(node)) record(node, 'string', node.text);
    else if (tsm.isNoSubstitutionTemplateLiteral(node)) record(node, 'template', node.text);
    else if (tsm.isTemplateHead(node) || tsm.isTemplateMiddle(node) || tsm.isTemplateTail(node)) {
      record(node, 'template-span', node.text);
    } else if (tsm.isJsxText(node)) record(node, 'jsx-text', node.text);
    tsm.forEachChild(node, visit);
  };
  visit(file);
  return out;
}
