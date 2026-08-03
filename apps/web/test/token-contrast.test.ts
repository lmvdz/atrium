/* ---------------------------------------------------------------------------
 * TOKEN-LEVEL CONTRAST, including the focus ring.
 *
 * The rendered audit (e2e/audit.ts) measures TEXT against the surface it landed
 * on. It has never measured the focus ring, which is how a 1.63:1 ring survived
 * a contrast pass and shipped on all 70 focusable controls per frame in both
 * themes — the note in globals.css audited text in detail and stopped there.
 *
 * This reads design/tokens.css itself, so it stays true if a token value moves.
 * It is the token half; e2e/gallery.spec.ts measures the ring as the browser
 * actually resolved it.
 * ------------------------------------------------------------------------- */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Walk up from the working directory until a marker file turns up, so paths
    resolve whether vitest ran from the repo root or from apps/web. */
function find(relative: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`${relative} not found above ${process.cwd()}`);
}

const TOKENS = readFileSync(find('design/tokens.css'), 'utf8');
const GLOBALS = readFileSync(find('apps/web/app/globals.css'), 'utf8');
/**
 * Comments are stripped before any of these rules look at a file. Every one of
 * them quotes the defect it forbids — that is the house style, and a check that
 * reads its own documentation as evidence would fail on the sentence explaining
 * why it exists.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const AUDIT_SOURCE = code(readFileSync(find('apps/web/e2e/audit.ts'), 'utf8'));

/* ---------------------------------------------------------------------------
 * ENUMERATING A CONSTRUCT: PARSE IT, DO NOT GREP IT.
 *
 * Round 6, D2, and it is a THIRD failure mode for a source-grep beyond the two
 * this file already records. The two known ones are "matched nothing" and
 * "matched the wrong occurrence". This one is MATCHED A STRICT SUBSET OF THE
 * SYNTAX: the guard enumeration read
 *
 *     /if\s*\([^)]*\)\s*continue/g
 *
 * and `[^)]*` cannot cross a `)`. Every guard whose CONDITION CONTAINS A CALL
 * was therefore invisible to it — so inserting `if (effectiveOpacity(el) < 0.999)
 * continue;` into the audit left 51 unit tests and 32 e2e contrast assertions
 * green while a real 1.36:1 string went unreported, because the one legitimate
 * guard elsewhere satisfied `guards.length > 0`. The ring-audit check twenty
 * lines below had already learned this exact lesson in round 5 ("a `\([^)]*\)`
 * condition match stops dead at that inner paren") and switched to a line scan.
 * The lesson was applied to that check and to no other.
 *
 * A line scan is a parser substitute too. The instrument is now the TypeScript
 * compiler's own parser: `if (…) continue` is an `IfStatement` whose `thenStatement`
 * is (or wraps) a `ContinueStatement`, and the condition comes back as source
 * text however it is spelled — a call, a nested paren, a ternary, a line break in
 * the middle. `guardsIn` is exercised against a synthetic source carrying each
 * of those spellings in `the enumerator sees every spelling of the construct`
 * below, which is the corollary this round adds to CONVENTIONS: a source-grep
 * that enumerates constructs must be able to see every spelling of the construct
 * it enumerates.
 * ------------------------------------------------------------------------- */
function guardsIn(source: string): readonly string[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const isContinue = (node: ts.Statement | undefined): boolean => {
    if (node === undefined) return false;
    if (ts.isContinueStatement(node)) return true;
    if (ts.isBlock(node)) return node.statements.length === 1 && isContinue(node.statements[0]);
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) &&
      node.elseStatement === undefined &&
      isContinue(node.thenStatement)
    ) {
      out.push(`if (${node.expression.getText(file).replace(/\s+/g, ' ')}) continue`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/**
 * Every early `return` guarded by an `if`, as {condition, returns}.
 *
 * Same instrument as `guardsIn`, for the ring audit's shape — a guard there
 * returns rather than continues, and what matters is WHAT it returns.
 */
function returnsIn(source: string): readonly { condition: string; returns: string }[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const out: { condition: string; returns: string }[] = [];
  const returned = (node: ts.Statement | undefined): string | null => {
    if (node === undefined) return null;
    if (ts.isReturnStatement(node)) {
      return node.expression === undefined
        ? 'undefined'
        : node.expression.getText(file).replace(/\s+/g, ' ');
    }
    if (ts.isBlock(node) && node.statements.length === 1) return returned(node.statements[0]);
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const value = returned(node.thenStatement);
      if (value !== null) {
        out.push({
          condition: node.expression.getText(file).replace(/\s+/g, ' '),
          returns: value,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The audit is a template string evaluated in the page; parse what it contains. */
function auditProgram(): string {
  const body = AUDIT_SOURCE.match(/export const AUDIT = `([\s\S]*)`;\s*$/)?.[1];
  if (body === undefined) throw new Error('e2e/audit.ts has no AUDIT program to parse');
  /* `\`` and `\${` are escapes inside the template; the page sees them unescaped
     and so must the parser. */
  return body.replace(/\\`/g, '`').replace(/\\\$\{/g, '${');
}

/** Every CSS Module in the library, so a rule can be checked wherever it lives. */
const MODULES: Readonly<Record<string, string>> = Object.fromEntries(
  ['frame', 'timeline', 'attention', 'lens', 'primitives'].map((name) => [
    name,
    code(readFileSync(find(`apps/web/src/components/${name}/${name}.module.css`), 'utf8')),
  ]),
);

/**
 * The ring token is READ OUT OF THE STYLESHEET, not restated here. A constant
 * mirroring the CSS is a constant that can drift from it, and the drift is
 * exactly the failure this test exists to catch.
 */
function focusRingToken(): string {
  const match = GLOBALS.match(/:focus-visible\s*\{[^}]*?outline:[^;]*var\(--([\w-]+)\)/s);
  if (match?.[1] === undefined) {
    throw new Error('globals.css has no :focus-visible outline colour to measure');
  }
  return match[1];
}

/**
 * The token block for a selector.
 *
 * ANCHORED AT THE START OF A LINE, which is not fussiness. This used to be a
 * bare `indexOf(selector)`, and tokens.css names both selectors in its own
 * provenance comment — "extracted verbatim from the `:root` and `html.atr-dark`
 * blocks of …" — at offsets 150 and 162. Both lookups therefore landed in the
 * same comment, both walked forward to the same `{`, and every "dark" assertion
 * in this file was measuring the LIGHT theme. It passed for two rounds, and it
 * reported `--bg3 on --red3 = 7.47:1` for dark, where the real number is 5.81.
 * A parametrised test that silently runs the same case twice is worse than one
 * case, because the second one is a claim that nothing checked.
 */
function block(selector: string): Readonly<Record<string, string>> {
  const start = TOKENS.search(new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{`, 'm'));
  if (start < 0) throw new Error(`tokens.css has no ${selector} block`);
  const open = TOKENS.indexOf('{', start);
  const close = TOKENS.indexOf('\n}', open);
  const body = TOKENS.slice(open, close);
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    if (name !== undefined && value !== undefined) out[name] = value;
  }
  return out;
}

const LIGHT = block(':root');
const DARK = block('html.atr-dark');

/* CATCHES the bug above coming back in any form: the two themes must actually
   be two themes. A `describe`-level guard rather than a test, so no assertion
   in this file can run against a pair that turned out to be the same block. */
if (LIGHT.bg1 === DARK.bg1) {
  throw new Error(
    'token-contrast: the light and dark blocks parsed to the same values — every "dark" assertion in this file would be measuring the light theme',
  );
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Every surface a focus ring can land on. Button FILLS are deliberately absent:
 * the ring sits outside the border box with a 1px offset, and the offset gap
 * shows the parent's background — an element's own fill is never adjacent to
 * its own outline.
 */
const RING_SURFACES = [
  'bg0',
  'bg1',
  'bg2',
  'bg3',
  'bg4',
  'bg5',
  'bg6',
  'bg7',
  'ambbg',
  'ambbg2',
  'ambbg3',
  'ambbg4',
  'ambbg5',
  'redbg',
  'redbg2',
  'replybg',
  'filebg',
  'grnbg',
  'grnav',
] as const;

const FOCUS_RING_TOKEN = focusRingToken();

/** Keep in step with `.hold` in primitives.module.css. */
const DESTRUCTIVE_FILL = 'red3';
const DESTRUCTIVE_TEXT = 'bg3';

const THEMES = [
  ['light', LIGHT],
  ['dark', DARK],
] as const;

describe('the focus ring clears WCAG 1.4.11', () => {
  /* CATCHES: putting the ring back on --line3 (1.63:1 light / 1.17:1 dark at
     worst), or any other token that fails on some surface. The ring is the only
     keyboard wayfinding this shell has — every other control is inert until
     activated — so a ring you cannot see is a keyboard user with no cursor. */
  it.each(THEMES)('is at least 3:1 on every surface it lands on — %s', (_name, theme) => {
    const ring = theme[FOCUS_RING_TOKEN];
    expect(ring).toBeDefined();
    for (const surface of RING_SURFACES) {
      const value = theme[surface];
      expect(value, `--${surface} is missing`).toBeDefined();
      const ratio = contrast(ring as string, value as string);
      expect(
        ratio,
        `focus ring --${FOCUS_RING_TOKEN} on --${surface} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  /* CATCHES: a token edit that quietly drops the ring below the floor. Reported
     so the number lands in the run log rather than only in a failure. */
  it.each(THEMES)('reports its worst surface — %s', (name, theme) => {
    let worst = { surface: '', ratio: Number.POSITIVE_INFINITY };
    for (const surface of RING_SURFACES) {
      const ratio = contrast(theme[FOCUS_RING_TOKEN] as string, theme[surface] as string);
      if (ratio < worst.ratio) worst = { surface, ratio };
    }
    console.info(
      `focus ring ${name}: --${FOCUS_RING_TOKEN} worst ${worst.ratio.toFixed(2)}:1 on --${worst.surface}`,
    );
    expect(worst.ratio).toBeGreaterThanOrEqual(3);
  });
});

describe('the destructive control is red and legible', () => {
  /* CATCHES: rendering the destructive primary in --amb2, byte-identical to the
     reversible gate's primary — round 1's finding. Amber and red are not
     interchangeable severities, and the check is that they are not the same
     colour. */
  it.each(THEMES)('does not render as the amber gate — %s', (_name, theme) => {
    expect(theme[DESTRUCTIVE_FILL]).not.toBe(theme.amb2);
    expect(theme[DESTRUCTIVE_FILL]).not.toBe(theme.amb);
  });

  /* CATCHES: moving the fill to --red2, which CONVENTIONS records as 4.21:1 in
     dark — the same latent bug already corrected for the ■ and ✗ glyphs. */
  it.each(THEMES)('carries its label at AA — %s', (name, theme) => {
    const ratio = contrast(theme[DESTRUCTIVE_TEXT] as string, theme[DESTRUCTIVE_FILL] as string);
    console.info(
      `destructive button ${name}: --${DESTRUCTIVE_TEXT} on --${DESTRUCTIVE_FILL} = ${ratio.toFixed(2)}:1`,
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  /* CATCHES: a progress bar that cannot be seen against the button it fills.
     Non-text contrast, so the floor is 3:1. */
  it.each(THEMES)('shows its progress bar at 3:1 — %s', (_name, theme) => {
    expect(
      contrast(theme[DESTRUCTIVE_TEXT] as string, theme[DESTRUCTIVE_FILL] as string),
    ).toBeGreaterThanOrEqual(3);
  });
});

/* ---------------------------------------------------------------------------
 * DE-EMPHASIS MUST STAY READABLE — and the harness must be able to see it.
 *
 * Round 2 shipped `.surf[disabled] { opacity: .55 }`, which measures 2.49:1
 * light and 2.98:1 dark at 10px: under AA, under the 3:1 large-text floor, and
 * below --tx4, which globals.css bans from carrying text outright. The rendered
 * audit did not catch it because the audit was written to skip anything under
 * `opacity 0.999`, naming "a disabled chip" as the justification — the rule it
 * exists to enforce, written into its own exemption list.
 *
 * Both halves are covered here. The state itself is a token step now, and the
 * harness measures fades instead of skipping them.
 * ------------------------------------------------------------------------- */
describe('a disabled control stays readable', () => {
  /* CATCHES: putting an opacity fade back on a text-bearing rule anywhere in
     the library. CONVENTIONS' measurement is that NO fade clears AA with this
     token set — the weakest thing a row can carry is already at the 4.53:1
     floor at full opacity — so a partial opacity on text is not a judgement
     call, it is arithmetic. `opacity: 0` is a different thing: it is absence,
     used by the hover strips that are invisible until hover.
     Run against r2 this fires on frame.module.css's `.surf[disabled]`. */
  it.each(Object.keys(MODULES))('%s.module.css fades no text', (name) => {
    const offenders = [...(MODULES[name] as string).matchAll(/opacity:\s*([\d.]+)/g)]
      .map((match) => Number.parseFloat(match[1] as string))
      .filter((value) => value > 0 && value < 1);
    expect(offenders, `${name}.module.css fades text to ${offenders.join(', ')}`).toEqual([]);
  });

  /* CATCHES: the disabled label being moved to a token that cannot carry text.
     The token is READ OUT OF THE STYLESHEET rather than restated, like the ring
     — a constant mirroring the CSS is a constant that can drift from it. */
  it.each(THEMES)('the disabled surface label clears AA on its surface — %s', (name, theme) => {
    const rule = (MODULES.frame as string).match(
      /\.surf\[disabled\]\s+\.surfLabel\s*\{[^}]*color:\s*var\(--([\w-]+)\)/,
    );
    expect(
      rule?.[1],
      'frame.module.css states no colour for a disabled surface label',
    ).toBeDefined();
    const ratio = contrast(theme[rule?.[1] as string] as string, theme.bg1 as string);
    console.info(`disabled surface label ${name}: --${rule?.[1]} on --bg1 = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  /* CATCHES: the disabled state becoming invisible — legible is only half of
     it. Inactive has to READ as inactive, so the disabled label must not be the
     same token as the enabled one. */
  it('disabled is a different token from enabled, not the same one', () => {
    const enabled = (MODULES.frame as string).match(
      /\n\.surfLabel\s*\{[^}]*color:\s*var\(--([\w-]+)\)/,
    );
    const disabled = (MODULES.frame as string).match(
      /\.surf\[disabled\]\s+\.surfLabel\s*\{[^}]*color:\s*var\(--([\w-]+)\)/,
    );
    expect(enabled?.[1]).toBeDefined();
    expect(disabled?.[1]).toBeDefined();
    expect(disabled?.[1], 'a disabled surface looks identical to an enabled one').not.toBe(
      enabled?.[1],
    );
  });

  /* CATCHES the guard being rewritten to excuse its own rule again. The audit
     may skip an element that is not rendered at all (opacity 0); it may not
     skip one that is merely faded, because that is the case the rule covers.
     This is the same species as the prototype's sticky-footer whitelist. */
  /* CATCHES the instrument, before the thing it measures.

     The enumerator below decides which guards the rule applies to, so a
     spelling it cannot see is a guard the rule does not cover — which is
     precisely how `if (effectiveOpacity(el) < 0.999) continue;` shipped past a
     check named "the audit harness does not exempt faded text". Every spelling
     here is one a person would plausibly write, and the ones marked were
     invisible to the regex this replaced. */
  it('the enumerator sees every spelling of the construct it enumerates', () => {
    const spellings = guardsIn(`
      for (const el of xs) {
        if (alpha === 0) continue;
        if (effectiveOpacity(el) < 0.999) continue;          // a call in the condition
        if ((alpha) < 0.5) continue;                          // a nested paren
        if (alpha < (a ? 1 : 0)) continue;                    // a ternary with parens
        if (
          alpha
          < 0.9
        ) continue;                                           // spread over lines
        if (alpha === 0) { continue; }                        // a braced body
        if (alpha === 0) break;                               // NOT a continue
        if (alpha === 0) continue; else alpha = 1;            // NOT an unconditional skip
      }
    `);
    expect(spellings).toEqual([
      'if (alpha === 0) continue',
      'if (effectiveOpacity(el) < 0.999) continue',
      'if ((alpha) < 0.5) continue',
      'if (alpha < (a ? 1 : 0)) continue',
      'if (alpha < 0.9) continue',
      'if (alpha === 0) continue',
    ]);
  });

  it('the audit harness does not exempt faded text from the contrast rule', () => {
    /* Every `continue` in the audit's element loop, narrowed to the ones that
       consult opacity. There may be exactly one, and it may only skip an
       element that is not rendered at all. `< 0.999` — round 2's guard — fails
       here, and so does any other threshold somebody reaches for. */
    const guards = guardsIn(auditProgram()).filter((guard) => /alpha|opacity/i.test(guard));
    /* EVERY such guard, not a fixed count of them. The round-3 version asserted
       the array equalled exactly one entry, which made it fail when round 4
       added a second loop with the identical legitimate guard — a test that
       breaks on a correct change is a test that gets relaxed under pressure, and
       the relaxation is where the exemption comes back. The invariant is about
       what a guard may say, so that is what is asserted; a threshold of any kind
       fails here however many loops there are. */
    expect(guards.length, 'the audit stopped consulting opacity at all').toBeGreaterThan(0);
    for (const guard of guards) {
      expect(guard, 'the audit skips elements on an opacity threshold').toBe(
        'if (alpha === 0) continue',
      );
    }
    // and the fade is folded into the measurement rather than dropped
    expect(AUDIT_SOURCE).toMatch(/parsed\.a \* alpha/);
  });

  /* CATCHES the same defect in the RING audit, which is where round 3's
     gauntlet found the third instance of it. `gallery.spec.ts` returned `null`
     for a control with no outline, dropping it out of `measured` instead of
     into `failures` — so a check named "the focus ring clears 3:1 on every
     control it lands on" could only ever be tripped by a control that already
     had a ring, and the one control in the app that tripped the skip was the
     composer. CONVENTIONS now states the general rule; this is the check that
     holds the second implementation of it.

     Comments stripped first, for the reason this file's `code()` states: the
     paragraph above quotes the very construct it forbids. */
  it('the ring audit does not exempt controls that paint no ring', () => {
    const ring = code(readFileSync(find('apps/web/e2e/gallery.spec.ts'), 'utf8'));
    const measure = ring.match(/const MEASURE = `([\s\S]*?)`;/)?.[1] ?? '';
    expect(measure, 'gallery.spec.ts has no ring MEASURE block').not.toBe('');
    /* PARSED, NOT SCANNED — the round-6 sweep of every source-grep in this repo
       for the failure mode D2 named. This was a LINE scan, adopted in round 5
       after the regex version was found to stop dead at the inner paren of
       `parseFloat(style.outlineWidth) === 0`. A line scan is a parser substitute
       with the same shape of hole one step further out: a guard wrapped across
       two lines has no single line carrying both the condition and the `return`,
       so the `return null` half becomes invisible exactly when the formatter
       breaks the line. Every `if` in the MEASURE program whose condition
       consults the outline's presence is enumerated from the AST, and none of
       them may return `null`: null means "no data", and no data is how a missing
       ring reads as a passing one. */
    const guards = returnsIn(measure).filter((guard) =>
      /outlineStyle|outlineWidth/.test(guard.condition),
    );
    expect(guards.length, 'the ring audit no longer checks whether a ring exists').toBeGreaterThan(
      0,
    );
    expect(
      guards.filter((guard) => guard.returns === 'null').map((guard) => guard.condition),
      'the ring audit drops a control with no outline instead of failing it',
    ).toEqual([]);
    // and the ring-less case has somewhere to land, and something that fails on it
    expect(measure).toMatch(/ratio:\s*null/);
    expect(ring).toMatch(/paint no focus indicator at all/);
  });
});

/* ---------------------------------------------------------------------------
 * THE COMPOSER'S RING, AND THE BINDING CUE UNDER IT.
 *
 * Round 3's gauntlet: 89 of 90 controls painted the 2px --tx1 ring; the one
 * that did not was the composer — the app's primary input, and the control
 * whose keyboard contract the footer advertises. `.cbox textarea { outline:
 * none }` is two classes deep and out-ranked the global `:focus-visible`. The
 * rendered ring audit could not see it, because that audit was written to drop
 * ring-less controls rather than fail them (fixed in e2e/gallery.spec.ts).
 * ------------------------------------------------------------------------- */
describe('the primary input paints the app’s focus ring', () => {
  /* CATCHES: `outline: none` coming back on the composer, in any block. Every
     other control in the app inherits the ring from globals.css; the only way
     to lose it is to out-rank that rule, and this is where that was done.
     Comments are stripped first — this file's house style quotes the defect it
     forbids in the comment above the fix, and a check that matched its own
     documentation would pass on the mutated file (round 3, the audit-harness
     grep that matched the comment describing the old guard). */
  it('no rule in the composer suppresses the outline', () => {
    const suppressed = [...(MODULES.frame as string).matchAll(/outline:\s*(none|0)\b/g)].map(
      (match) => match[0],
    );
    expect(suppressed, 'a frame rule suppresses the focus outline').toEqual([]);
  });

  /* CATCHES: the composer painting a ring in some OTHER colour or width — a
     1px --line3 hairline would satisfy "has an outline" and be the 2.23:1 the
     gauntlet measured. The token is read out of globals.css, so the composer's
     ring and the app's ring cannot drift apart. */
  it('the composer’s ring is the same token and width as every other control', () => {
    const rule = (MODULES.frame as string).match(/\.cbox\s+textarea:focus-visible\s*\{([^}]*)\}/);
    expect(rule?.[1], 'the composer declares no focus-visible ring').toBeDefined();
    const declaration = rule?.[1] ?? '';
    expect(declaration).toMatch(new RegExp(`var\\(--${FOCUS_RING_TOKEN}\\)`));
    const global = GLOBALS.match(/:focus-visible\s*\{[^}]*?outline:\s*([\d.]+)px/s);
    expect(declaration).toMatch(new RegExp(`outline:\\s*${global?.[1]}px`));
  });

  /* CATCHES: the ring landing on a surface it cannot clear. The composer's is
     INSET (negative offset) because the textarea fills its container, so the
     colour adjacent to it is `.cbox`'s own fill rather than the parent's — a
     different surface from every other control's, and therefore one this file
     has to name rather than assume is covered by RING_SURFACES. */
  it.each(THEMES)('the inset ring clears 3:1 on the composer’s own fill — %s', (name, theme) => {
    const fill = (MODULES.frame as string).match(
      /\n\.cbox\s*\{[^}]*background:\s*var\(--([\w-]+)\)/,
    );
    expect(fill?.[1], 'frame.module.css states no composer fill').toBeDefined();
    const ratio = contrast(theme[FOCUS_RING_TOKEN] as string, theme[fill?.[1] as string] as string);
    console.info(
      `composer ring ${name}: --${FOCUS_RING_TOKEN} on --${fill?.[1]} = ${ratio.toFixed(2)}:1`,
    );
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  /* CATCHES: `.cbox:focus-within` out-ranking the binding cue again. Focusing
     the composer used to replace the amber ANSWERING border with grey — the cue
     saying "your next message resolves this item" destroyed by focusing the
     field you are meant to answer in. Asserted as SPECIFICITY (two classes plus
     the pseudo-class, so it wins wherever it sits in the file) rather than as
     source order, because source order is what made this fragile. */
  it.each(['cboxBound', 'cboxReplying'])('the %s cue survives focus', (state) => {
    const resting = (MODULES.frame as string).match(
      new RegExp(`\\n\\.${state}\\s*\\{[^}]*border-color:\\s*var\\(--([\\w-]+)\\)`),
    );
    expect(resting?.[1], `frame.module.css states no resting border for .${state}`).toBeDefined();
    const focused = (MODULES.frame as string).match(
      new RegExp(
        `\\.cbox\\.${state}:focus-within\\s*\\{[^}]*border-color:\\s*var\\(--([\\w-]+)\\)`,
      ),
    );
    expect(
      focused?.[1],
      `.${state} has no focus-within rule, so .cbox:focus-within's grey wins`,
    ).toBe(resting?.[1]);
  });
});

/* ---------------------------------------------------------------------------
 * THE CLAIM UNDERLINE IS A MEANINGFUL NON-TEXT GRAPHIC.
 *
 * globals.css's own words: "the dotted underline is the visual difference
 * between 'someone said it' and 'the system checked it'". That is a definition
 * of a 1.4.11 graphic, and it shipped as --line3 at 1.32–2.23:1 for three
 * rounds because neither the text audit nor the ring audit had a category for
 * it.
 * ------------------------------------------------------------------------- */
describe('the claim underline clears WCAG 1.4.11', () => {
  function claimToken(): string {
    const match = code(GLOBALS).match(/\.atr-claim\s*\{[^}]*border-bottom:[^;]*var\(--([\w-]+)\)/s);
    if (match?.[1] === undefined) {
      throw new Error('globals.css has no .atr-claim underline colour to measure');
    }
    return match[1];
  }

  /* CATCHES: putting the underline back on --line3, or on any other token that
     fails against a surface a claim can land on. EVERY surface, not the ring's
     list: a claim's underline sits on the row it is in, so a claim inside a red
     failure block is on --redbg3 — the worst surface in the app and the one
     --line3 measured 1.32:1 against. */
  it.each(THEMES)('is at least 3:1 on every surface a claim lands on — %s', (name, theme) => {
    const token = claimToken();
    const surfaces = Object.keys(theme).filter((t) =>
      /^(bg|ambbg|redbg|grnbg|grnav|replybg|filebg)/.test(t),
    );
    expect(surfaces.length).toBeGreaterThan(15);
    let worst = { surface: '', ratio: Number.POSITIVE_INFINITY };
    for (const surface of surfaces) {
      const ratio = contrast(theme[token] as string, theme[surface] as string);
      if (ratio < worst.ratio) worst = { surface, ratio };
    }
    console.info(
      `claim underline ${name}: --${token} worst ${worst.ratio.toFixed(2)}:1 on --${worst.surface}`,
    );
    expect(
      worst.ratio,
      `claim underline --${token} on --${worst.surface} is ${worst.ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(3);
  });

  /* CATCHES: fixing the contrast by making the underline as loud as the words,
     which would delete the distinction it exists to draw. It has to be quieter
     than body text AND above the graphic floor; that band is the constraint. */
  it('stays quieter than the words it sits under', () => {
    const token = claimToken();
    expect(token, 'the claim underline is the same token as primary body text').not.toBe('tx0');
    expect(token).not.toBe(FOCUS_RING_TOKEN);
    expect(code(GLOBALS)).toMatch(/\.atr-claim\s*\{[^}]*border-bottom:\s*1px dotted/s);
  });

  /* CATCHES: the rendered audit losing its non-text-graphic sweep — the check
     that measures this on the page rather than in the token file. A registry
     with the claim underline removed from it is the exemption this round exists
     to stop, one indirection out. */
  it('the rendered audit measures it as a non-text graphic', () => {
    expect(AUDIT_SOURCE).toMatch(/data-claim="true"/);
    expect(AUDIT_SOURCE).toMatch(/graphicFailures/);
    expect(AUDIT_SOURCE, 'the graphic sweep uses a floor other than 1.4.11’s 3:1').toMatch(
      /ratio \+ 0\.005 < 3/,
    );
  });
});

describe('the armed state of the destructive control is measured too', () => {
  /* CATCHES: the armed fill moving to a token that cannot carry the label. The
     button switches to --red on completion — a different pairing from the
     resting --red3, uncovered by the contrast note until round 2's gauntlet
     measured it at 5.36:1. A state a control can enter is a state the audit has
     to cover. */
  it.each(THEMES)('--bg3 on --red clears AA — %s', (name, theme) => {
    const armed = (MODULES.primitives as string).match(
      /\.hold\[data-armed='true'\]\s*\{[^}]*background:\s*var\(--([\w-]+)\)/,
    );
    expect(armed?.[1], 'primitives.module.css states no armed fill').toBeDefined();
    const ratio = contrast(
      theme[DESTRUCTIVE_TEXT] as string,
      theme[armed?.[1] as string] as string,
    );
    console.info(`armed destructive ${name}: --bg3 on --${armed?.[1]} = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  /* CATCHES: the armed state being indistinguishable from the resting one —
     the whole point of the switch is that "armed" is visibly a different thing
     from "ready to arm". */
  it('armed is a different fill from resting', () => {
    const armed = (MODULES.primitives as string).match(
      /\.hold\[data-armed='true'\]\s*\{[^}]*background:\s*var\(--([\w-]+)\)/,
    );
    expect(armed?.[1]).not.toBe(DESTRUCTIVE_FILL);
  });
});

describe('the filter cannot fade a row under AA', () => {
  /* CATCHES: reintroducing opacity-based dimming. The weakest thing a row can
     carry is an amber needs-you tag, --amb2 on --ambbg, and it must clear AA at
     full opacity in both themes or the row is unreadable before any filter
     touches it. */
  it.each(THEMES)('the weakest row token clears AA at full opacity — %s', (name, theme) => {
    const ratio = contrast(theme.amb2 as string, theme.ambbg as string);
    console.info(`weakest row token ${name}: --amb2 on --ambbg = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  /* The old assertion caught a fade doctrine being softened by requiring the
     light token to have *no* headroom. The rendered replay then proved that
     premise unsafe: other legitimate amber surfaces crossed the audit's safety
     floor. Opacity is already forbidden exhaustively above; this test now
     catches regressing the light ramp below the measured safety margin while
     retaining the old upper bound that keeps amber subordinate to body text.

     The dark number was invisible until this round: `block()` was matching the
     selector names in tokens.css's own provenance comment, so this test's
     "dark" case had been re-measuring the light theme since it was written, and
     asserted `< 5.6` on a value that is really 9.65. */
  it('the binding light-theme token retains rendered-audit headroom', () => {
    const light = contrast(LIGHT.amb2 as string, LIGHT.ambbg as string);
    const dark = contrast(DARK.amb2 as string, DARK.ambbg as string);
    console.info(
      `weakest row token: light ${light.toFixed(2)}:1 · dark ${dark.toFixed(2)}:1 — the binding one is ${Math.min(light, dark).toFixed(2)}`,
    );
    expect(Math.min(light, dark)).toBe(light);
    expect(light).toBeGreaterThanOrEqual(4.9);
    expect(light).toBeLessThan(5.6);
  });
});

/* ---------------------------------------------------------------------------
 * ROUND 5 — THE NON-TEXT GRAPHICS REGISTRY, AND THE HARNESS EXCLUSIONS.
 *
 * Round 4's gauntlet found the graphics registry holding ONE entry while the
 * guard counting graphics was satisfied by that entry's own fifty instances —
 * so "50 graphics, zero failures" meant nothing, and an independent sweep
 * immediately turned up the AWAY presence ring at 1.93:1 / 1.84:1 and the
 * composer's ANSWERING border at 1.76:1 / 2.70:1.
 *
 * It also listed five harness exclusions that were clean when run without them.
 * "Clean when somebody else ran it" is not a property of this repo; every one of
 * them is removed here, and these are the checks that keep them removed.
 * ------------------------------------------------------------------------- */

const GALLERY_SPEC = code(readFileSync(find('apps/web/e2e/gallery.spec.ts'), 'utf8'));

describe('every non-text graphic that carries information is registered and clears 3:1', () => {
  /* CATCHES: the registry shrinking back towards one entry. Six graphics carry
     state in this app; the list is in e2e/audit.ts with the reason for each and
     the reason for every exclusion. A registry of one is a sweep of nothing. */
  it('the registry holds every graphic the app renders state with', () => {
    const registry = AUDIT_SOURCE.match(/const GRAPHICS = \[([\s\S]*?)\n {2}\];/)?.[1] ?? '';
    expect(registry, 'e2e/audit.ts has no GRAPHICS registry').not.toBe('');
    for (const selector of [
      '[data-claim="true"]',
      '[data-presence="here"]',
      '[data-presence="idle"], [data-presence="away"]',
      '[data-composer-box="bound"], [data-composer-box="replying"]',
      '[data-card-state="gate"], [data-card-state="destructive"]',
      '[data-surface-count][data-surface-empty="true"]',
    ]) {
      expect(registry, `the graphics registry dropped ${selector}`).toContain(selector);
    }
  });

  /* CATCHES: the coverage guard going back to counting INSTANCES. `> 10` was
     met by the claim underline alone, which is what let a registry of one look
     like a thorough sweep. Distinct registry kinds is the number that cannot be
     satisfied by a single registered graphic. */
  it('the coverage guard counts registry kinds, not instances', () => {
    /* The ASSERTION's first argument, not a mention anywhere in the file. The
       first version of this grep matched `audit.graphicKinds.length` inside the
       console.info template beside it, so swapping the assertion back to
       `audit.graphicsChecked` left it passing — a source grep whose failure mode
       is matching the wrong occurrence is the same species as one whose failure
       mode is matching nothing. */
    expect(GALLERY_SPEC).toMatch(/expect\(\s*audit\.graphicKinds\.length,/);
    expect(GALLERY_SPEC).toMatch(/registered kinds rendered/);
    /* and there is a check that every registered kind rendered somewhere: a
       selector that matches nothing reports exactly like one that passes. */
    expect(GALLERY_SPEC).toMatch(/toBe\(registrySize\)/);
  });

  /* CATCHES: a graphic being measured against the friendlier of its two
     adjacent colours — or, for a FILL, against itself. The first version of the
     round-5 sweep did the second: eighteen `here` dots reported 1.00:1 because
     `backdrop(el)` composites the element's own background in. A measurement
     that cannot fail in one direction cannot pass in the other either. */
  it('a graphic is measured against the worse of its adjacent colours', () => {
    expect(AUDIT_SOURCE).toMatch(/backdrop\(el\.parentElement\)/);
    expect(AUDIT_SOURCE).toMatch(/side === 'backgroundColor'/);
  });

  /* CATCHES the two tokens the gauntlet measured, from the tokens themselves.
     `--line3` on the rail was the THIRD place that token survived as a
     meaningful graphic; `--ambbd` and `--filebd` were the binding cues. */
  it.each(THEMES)('the presence ring clears 3:1 on the rail — %s', (name, theme) => {
    const ring = (MODULES.frame as string).match(
      /\n\.presAway\s*\{[^}]*border:\s*[\d.]+px solid var\(--([\w-]+)\)/,
    );
    expect(ring?.[1], 'frame.module.css states no away ring').toBeDefined();
    const rail = (MODULES.frame as string).match(
      /\n\.rail\s*\{[^}]*background:\s*var\(--([\w-]+)\)/,
    );
    const ratio = contrast(
      theme[ring?.[1] as string] as string,
      theme[rail?.[1] as string] as string,
    );
    console.info(`presence ring ${name}: --${ring?.[1]} on --${rail?.[1]} = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it.each(THEMES)(
    'the binding border clears 3:1 on the composer’s surfaces — %s',
    (name, theme) => {
      for (const state of ['cboxBound', 'cboxReplying'] as const) {
        const rule = (MODULES.frame as string).match(
          new RegExp(`\\n\\.${state}\\s*\\{[^}]*border-color:\\s*var\\(--([\\w-]+)\\)`),
        );
        expect(rule?.[1], `frame.module.css states no border for .${state}`).toBeDefined();
        /* --bg1 is what the composer sits on and --bg3 is what the box is
           filled with: a border has two adjacent colours and clears both. */
        for (const surface of ['bg1', 'bg3'] as const) {
          const ratio = contrast(theme[rule?.[1] as string] as string, theme[surface] as string);
          console.info(`${state} ${name}: --${rule?.[1]} on --${surface} = ${ratio.toFixed(2)}:1`);
          expect(ratio).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );

  it.each(THEMES)(
    'the attention card’s state border clears 3:1 on both sides — %s',
    (name, theme) => {
      for (const [state, fill] of [
        ['acardGate', 'ambbg5'],
        ['acardDestructive', 'redbg'],
      ] as const) {
        const rule = (MODULES.attention as string).match(
          new RegExp(`\\n\\.${state}\\s*\\{[^}]*border-color:\\s*var\\(--([\\w-]+)\\)`),
        );
        expect(rule?.[1], `attention.module.css states no border for .${state}`).toBeDefined();
        for (const surface of [fill, 'bg3'] as const) {
          const ratio = contrast(theme[rule?.[1] as string] as string, theme[surface] as string);
          console.info(`${state} ${name}: --${rule?.[1]} on --${surface} = ${ratio.toFixed(2)}:1`);
          expect(ratio).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );
});

describe('the harness runs its own checks without their exclusions', () => {
  /* CATCHES: the focus sweep going back to a constant cap. The rule says
     "every control it lands on"; the loop said 90 while the page held 337, so
     three of the six frames were never keyboard-focused by anything. */
  it('the ring sweep runs to exhaustion, not to a constant', () => {
    expect(GALLERY_SPEC, 'the ring sweep is capped at a literal 90 again').not.toMatch(/i < 90;/);
    expect(GALLERY_SPEC).toMatch(/data-ring-swept/);
    expect(GALLERY_SPEC).toMatch(/rendered controls the keyboard never reached/);
  });

  /* CATCHES: the reduced-motion filter's second clause subsuming the first
     again. `.filter(a !== 'none' || t !== 'all').filter(a !== 'none')` made the
     transition half dead code, so TRANSITIONS WERE NEVER CHECKED — and the
     check that proves the check has a subject (transitions exist without the
     preference) is asserted here too, because a suppression test with nothing
     to suppress passes for free. */
  it('reduced motion checks transitions as well as animations', () => {
    /* The measurement itself, not the word appearing somewhere. The companion
       test two blocks down also mentions `transitionDuration`, so a bare grep
       for the identifier passed with the reduced-motion measurement gutted. */
    expect(GALLERY_SPEC).toMatch(/const longest = style\.transitionDuration/);
    expect(GALLERY_SPEC).toMatch(/transitions\.push\(/);
    expect(GALLERY_SPEC).toMatch(/a transition survived prefers-reduced-motion/);
    expect(GALLERY_SPEC).toMatch(/transitions exist when they are not suppressed/);
  });

  /* CATCHES: the disabled sweep going back to `.disabled === true` (which makes
     every `aria-disabled` control invisible to it) and to reading only the
     first of a control's spans (which is how the count chip shipped at 2.43:1
     with nobody measuring it). */
  it('the disabled sweep sees aria-disabled and every span', () => {
    expect(GALLERY_SPEC).toMatch(/aria-disabled/);
    expect(GALLERY_SPEC).toMatch(/button\.querySelectorAll\('span'\)/);
    expect(GALLERY_SPEC, 'the disabled sweep reads only the first span again').not.toMatch(
      /button\.querySelector\('span'\)/,
    );
  });

  /* CATCHES: `AUDIT` going back to running on /gallery alone. `/` drives the
     same frame through a live consumer and the pin routes render it under load;
     "the gallery covers it" is a claim about six stills. */
  it('the rendered audit runs on every route the app serves', () => {
    const routes = GALLERY_SPEC.match(/const ROUTES = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
    expect(routes, 'gallery.spec.ts has no ROUTES list').not.toBe('');
    for (const path of ["'/gallery'", "'/'", "'/gallery/pin/34'", "'/gallery/pin/60'"]) {
      expect(routes, `the audit stopped running on ${path}`).toContain(path);
    }
  });

  /* CATCHES: `ownText` going back to child text nodes only. A ::before, an
     ::after and a ::placeholder are rendered strings that no node walk can see,
     so three categories of text were outside the contrast and 10px floors. */
  it('the text sweep reads generated content and placeholders', () => {
    expect(AUDIT_SOURCE).toMatch(/'::before', '::after'/);
    expect(AUDIT_SOURCE).toMatch(/::placeholder/);
    expect(AUDIT_SOURCE).toMatch(/pseudoChecked/);
  });

  /* CATCHES: the viewport height going back to a hard-coded 900 everywhere.
     `.pinList`'s belt is the thing being tested and the viewport is what it is
     tested against; one number, never varied, is not a test of a bound. */
  it('the pin harness sweeps viewport heights, not just widths', () => {
    const spec = code(readFileSync(find('apps/web/e2e/pin-bound.spec.ts'), 'utf8'));
    const heights = spec.match(/const HEIGHTS = \[([^\]]*)\]/)?.[1] ?? '';
    expect(heights, 'pin-bound.spec.ts has no HEIGHTS sweep').not.toBe('');
    expect(heights).toContain('420');
    expect(Number(heights.split(',')[0])).toBeLessThanOrEqual(420);
  });
});
