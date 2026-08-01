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
  it('the audit harness does not exempt faded text from the contrast rule', () => {
    /* Every `continue` in the audit's element loop, narrowed to the ones that
       consult opacity. There may be exactly one, and it may only skip an
       element that is not rendered at all. `< 0.999` — round 2's guard — fails
       here, and so does any other threshold somebody reaches for. */
    const guards = [...AUDIT_SOURCE.matchAll(/if\s*\([^)]*\)\s*continue/g)]
      .map((match) => match[0].replace(/\s+/g, ' '))
      .filter((guard) => /alpha|opacity/i.test(guard));
    expect(guards, 'the audit skips elements on an opacity threshold').toEqual([
      'if (alpha === 0) continue',
    ]);
    // and the fade is folded into the measurement rather than dropped
    expect(AUDIT_SOURCE).toMatch(/parsed\.a \* alpha/);
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

  /* CATCHES: the "no fade clears AA" doctrine being softened on the strength of
     a dark-theme number. ONE stylesheet serves both themes, so a fade has to
     clear AA in the WORSE of them, and light is the worse: --amb2 on --ambbg is
     4.53:1 there against 9.65:1 dark. At 4.53 there is no headroom at all —
     that is what settled the filter on lifting matches instead of dimming the
     rest, and what CONVENTIONS records.

     The dark number was invisible until this round: `block()` was matching the
     selector names in tokens.css's own provenance comment, so this test's
     "dark" case had been re-measuring the light theme since it was written, and
     asserted `< 5.6` on a value that is really 9.65. */
  it('the binding measurement is the light theme, and it has no headroom', () => {
    const light = contrast(LIGHT.amb2 as string, LIGHT.ambbg as string);
    const dark = contrast(DARK.amb2 as string, DARK.ambbg as string);
    console.info(
      `weakest row token: light ${light.toFixed(2)}:1 · dark ${dark.toFixed(2)}:1 — the binding one is ${Math.min(light, dark).toFixed(2)}`,
    );
    expect(Math.min(light, dark)).toBe(light);
    expect(light).toBeLessThan(5.6);
    // and no fade survives it: 95% of the floor is already under AA
    expect(light * 0.95).toBeLessThan(4.5);
  });
});
