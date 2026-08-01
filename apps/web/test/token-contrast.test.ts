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

function block(selector: string): Readonly<Record<string, string>> {
  const start = TOKENS.indexOf(selector);
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

describe('the filter cannot fade a row under AA', () => {
  /* CATCHES: reintroducing opacity-based dimming. The weakest thing a row can
     carry is an amber needs-you tag, --amb2 on --ambbg, which is already at the
     shell's floor at FULL opacity — so any fade at all puts it under AA, and
     the caption "a row you cannot see is a row you cannot check" becomes false.
     This test states why the filter lifts matches instead. */
  it.each(THEMES)('the weakest row token has no headroom to fade — %s', (name, theme) => {
    const ratio = contrast(theme.amb2 as string, theme.ambbg as string);
    console.info(`weakest row token ${name}: --amb2 on --ambbg = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(5.6);
  });
});
