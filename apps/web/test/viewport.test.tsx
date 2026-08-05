/* ---------------------------------------------------------------------------
 * THE VIEWPORT IS A DENOMINATOR — r8 D10.
 *
 * RETRO.md already records "bare numerals evade word-keyed checks; viewport is a
 * denominator", and this round found the next instance of it. `.app` has
 * declared `min-width: 1024px` since round 3; the e2e suite measures 1124, 1240,
 * 1280, 1340 and 1440; and 1024, 1440 and 1920 are clean. Everything below the
 * floor was outside every measurement in the repo, and the r8 blind review found
 * 664px of horizontal overflow at a 360px viewport and 304px at 720 — with no
 * breakpoint below 1279 anywhere and nothing on screen stating or refusing a
 * minimum.
 *
 * A shell that only works above a width is fine. A shell that only works above a
 * width and does not say so is the same defect as an analysis over an incomplete
 * input set: correct where it was measured, silent everywhere else.
 *
 * So the floor is STATED, and this file is what keeps the statement true. Three
 * sources, and the assertion is that they are one number:
 *
 *   1. the stylesheet's `min-width` on the layout root
 *   2. the media query that reveals the notice, one pixel below
 *   3. the number in the sentence the reader actually sees
 *
 * WHAT THIS ENUMERATES FROM: every `.css` under `apps/web` and `design/`, walked
 * off the filesystem, and the rendered DOM of `AppFrame`. WHAT EXECUTES THAT IT
 * DOES NOT SEE: whether the notice is VISIBLE at a given width — JSDOM does not
 * evaluate media queries, so this file proves the rule exists and states the
 * right number, and `e2e/smoke.spec.ts` is where a real engine at a real width
 * proves it appears. Also not seen here: touch, zoom, forced-colors, and every
 * engine that is not Chromium, all of which remain unmeasured in this repo.
 * ------------------------------------------------------------------------- */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppFrame, MINIMUM_WIDTH } from '../src/components/frame/AppFrame';
import { EMPTY_SLOT, slot } from '../src/components/model/slot';

function find(path: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, path);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`${path} not found above ${process.cwd()}`);
}

const WEB = find('apps/web/package.json').replace(/\/package\.json$/, '');
const REPO = dirname(dirname(WEB));

/** Every stylesheet that reaches the page, read off the filesystem. */
function stylesheets(): readonly { readonly path: string; readonly css: string }[] {
  const out: { path: string; css: string }[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.css')) out.push({ path: full, css: readFileSync(full, 'utf8') });
    }
  };
  walk(WEB);
  walk(join(REPO, 'design'));
  return out;
}

const SHEETS = stylesheets();
const FRAME_CSS = readFileSync(find('apps/web/src/components/frame/frame.module.css'), 'utf8');

/**
 * A `min-width` big enough to be a PAGE-LEVEL FLOOR rather than a column's
 * business. 320 CSS px is the narrowest phone in common use, so any rule that
 * refuses to go below it is refusing a real window — which is a thing the page
 * owes the reader a sentence about.
 */
const FLOOR_THRESHOLD = 320;

interface Floor {
  readonly file: string;
  readonly px: number;
}

/* A DECLARATION IS NOT A SENTENCE ABOUT ONE. The first version of this
   enumerator read `min-width: 1024px` out of the prose explaining `min-width:
   1024px` and reported two floors — a comment counted as code, which is the
   measuring instrument inventing a defect rather than missing one (RETRO: "a
   wrong instrument invents defects, not just misses them"). */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

function floorsIn(source: string, file: string): readonly Floor[] {
  const css = withoutComments(source);
  const out: Floor[] = [];
  /* BOTH SPELLINGS. `min-inline-size` is the logical-property name for the same
     declaration and the platform treats them identically — a floor written that
     way would be a floor this enumerator could not see, which is the r6
     case-sensitivity finding in the axis of a property name. */
  for (const hit of css.matchAll(/min-(?:width|inline-size):\s*(\d+)px/g)) {
    const raw = hit[1];
    if (raw === undefined) continue;
    const px = Number(raw);
    /* Inside a `@media` block a `min-width` is a QUERY, not a declaration — the
       regex would read `@media (min-width: 900px)` as a floor. Only the ones
       that are declarations count, and a declaration is preceded by a `{` with
       no `@media` between. */
    const before = css.slice(0, hit.index ?? 0);
    const query = /\(\s*$/.test(before);
    if (query) continue;
    if (px >= FLOOR_THRESHOLD) out.push({ file, px });
  }
  return out;
}

const FLOORS = SHEETS.flatMap((sheet) => floorsIn(sheet.css, relative(REPO, sheet.path)));

describe('the layout states the narrowest window it works in', () => {
  /* CATCHES: the enumeration going blind. A sweep that finds no floors reports
     exactly like one that finds them all stated — the failure mode this repo has
     now shipped four times. */
  it('there is a floor to state', () => {
    expect(FLOORS.length, 'no page-level minimum width found, which cannot be true').toBe(1);
    expect(FLOORS[0]?.file).toBe('apps/web/src/components/frame/frame.module.css');
    expect(FLOORS[0]?.px).toBe(MINIMUM_WIDTH);
  });

  /* CATCHES the r8 defect: a floor with nothing on screen about it. Both
     directions — a second floor added anywhere in any stylesheet lands in
     `FLOORS` and fails the count above, and a floor whose number drifts from the
     component's fails here. */
  it('every page-level floor is the number the component states', () => {
    expect(
      FLOORS.filter((floor) => floor.px !== MINIMUM_WIDTH),
      'a stylesheet declares a minimum width the shell does not state to the reader',
    ).toEqual([]);
  });

  /* THE MEDIA QUERY IS ONE PIXEL BELOW THE FLOOR. A notice that appears at 900
     when the layout breaks at 1024 leaves a 124px band that overflows in
     silence, which is the defect with a smaller number in it. */
  it('the notice is revealed exactly below the floor, not somewhere near it', () => {
    const reveal = new RegExp(
      `@media \\(max-width: ${MINIMUM_WIDTH - 1}px\\)\\s*\\{[^@]*\\.belowMin`,
    );
    expect(
      FRAME_CSS,
      'the below-minimum notice is revealed at a width that is not the floor',
    ).toMatch(reveal);
    /* …and it is hidden by default, so it never appears above the floor. */
    expect(FRAME_CSS).toMatch(/\.belowMin\s*\{\s*display:\s*none;\s*\}/);
  });

  /* THE SENTENCE THE READER ACTUALLY GETS. Read off the rendered DOM, not off
     the source — the number in the copy is the claim, and a constant
     interpolated into a string nobody renders states nothing. */
  it('the shell renders the floor as a sentence, with the number in it', () => {
    const { container } = render(
      <AppFrame lens={EMPTY_SLOT} rail={EMPTY_SLOT} strip={slot(null)} workspace={EMPTY_SLOT} />,
    );
    const notice = container.querySelector('[data-below-minimum-width]');
    expect(notice, 'the shell renders no statement of its minimum width').not.toBe(null);
    expect(notice?.getAttribute('data-below-minimum-width')).toBe(String(MINIMUM_WIDTH));
    expect(notice?.textContent).toContain(String(MINIMUM_WIDTH));
    /* It says what happens, not only that something does — "needs a wider
       window" with no consequence is a shrug. */
    expect(notice?.textContent).toMatch(/scrolls sideways/);
  });

  /* AND THE FLOOR IS REAL RATHER THAN DECORATIVE: the grid's own tracks at the
     narrowest breakpoint have to FIT inside the number the notice states, or the
     sentence is stating a width the layout still overflows. Read off the
     stylesheet, summed, rather than trusted to the comment beside it. */
  it('the declared floor is wide enough for the narrowest track set', () => {
    const sets = [...FRAME_CSS.matchAll(/grid-template-columns:\s*([^;]+);/g)]
      .map((hit) => hit[1] ?? '')
      .filter((value) => /minmax\(\s*\d+px/.test(value));
    expect(sets.length, 'no four-column track set found in the frame stylesheet').toBeGreaterThan(
      0,
    );
    const widths = sets.map((set) =>
      [...set.matchAll(/(\d+)px/g)].reduce((total, hit) => total + Number(hit[1] ?? 0), 0),
    );
    expect(
      Math.min(...widths),
      'the narrowest track set is wider than the minimum the page states',
    ).toBeLessThanOrEqual(MINIMUM_WIDTH);
  });
});
