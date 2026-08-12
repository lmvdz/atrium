import { existsSync } from 'node:fs';
import { chromium, expect, test } from '@playwright/test';
import type { AgreementReport } from './agreement';
import { agreementScript } from './agreement';

/* ---------------------------------------------------------------------------
 * NO TWO ELEMENTS SIMULTANEOUSLY ON SCREEN MAY STATE DIFFERENT ANSWERS TO THE
 * SAME QUESTION — driven, at four widths, in states a person can reach.
 *
 * The analysis is e2e/agreement.ts; the header there is the argument for it and
 * the honest statement of what it cannot see. This file is the part that has to
 * be a real browser: layout decides what is rendered (the pin's budget is
 * measured from the viewport), and round 8's defects reproduced from the 1024
 * floor to 1920. A check pinned at one viewport is a check about one viewport.
 *
 * WHAT FIRED HERE ON r8, and is silent on r9:
 *   / → #identity-service                the card's source control says the
 *                                        room on screen is elsewhere (D3)
 *   / → #identity-service → Answer it    six surfaces, two answers (D1)
 *   / → Mark signed off                  the rail chip against everything else
 *                                        in its own room (D2)
 *   /gallery/pin/60                      four surfaces, two answers, zero
 *                                        clicks (D2)
 *   /gallery frame 5                     a still whose rail contradicts its own
 *                                        pin (D2)
 * ------------------------------------------------------------------------- */

function browserAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/* The floor the r8 critic drove, the two common desktop widths, and the top of
   the supported range. The defects reproduced at every one of them. */
const WIDTHS = [1024, 1280, 1440, 1920] as const;

interface Screen {
  readonly name: string;
  readonly path: string;
  /** independent screens on the page; `/gallery` renders six frames */
  readonly roots: string | null;
  /** what a person does before the check looks */
  readonly drive?: (page: import('@playwright/test').Page) => Promise<void>;
}

/* THE RAIL IS FOLDED BY DEFAULT NOW, so reaching a room is two acts rather than
   one: open the fold, then choose. This helper is why every rail-driven screen
   below says `openRail` instead of repeating the control's name — and it is the
   step whose absence made all twelve of these cases time out at every width
   against a button that was in the DOM and could never be seen. */
async function openRail(page: import('@playwright/test').Page): Promise<void> {
  const fold = page.getByRole('button', { name: 'Show rooms and participants' });
  await fold.click();
  await expect(page.locator('[data-frame][data-rail="open"]').first()).toBeVisible();
}

const SCREENS: readonly Screen[] = [
  { name: 'the room as it loads', path: '/', roots: null },
  {
    name: 'another room, chosen from the rail',
    path: '/',
    roots: null,
    drive: async (page) => {
      await openRail(page);
      await page.locator('nav button', { hasText: 'identity-service' }).click();
    },
  },
  {
    name: 'the last owed item in a room, answered',
    path: '/',
    roots: null,
    drive: async (page) => {
      await openRail(page);
      await page.locator('nav button', { hasText: 'identity-service' }).click();
      await page.locator('[data-attention-id] button', { hasText: 'Answer it' }).click();
    },
  },
  {
    name: 'one of four owed items, settled',
    path: '/',
    roots: null,
    drive: async (page) => {
      await page.locator('button', { hasText: 'Mark signed off' }).first().click();
    },
  },
  {
    name: 'a room with nothing owed',
    path: '/',
    roots: null,
    drive: async (page) => {
      await openRail(page);
      await page.locator('nav button', { hasText: 'design' }).click();
    },
  },
  { name: 'the pin under load', path: '/gallery/pin/60', roots: null },
  { name: 'the pin at the budget', path: '/gallery/pin/4', roots: null },
  { name: 'every gallery still', path: '/gallery', roots: '[data-gallery-frame]' },
];

test.describe('two elements on one screen, one question', () => {
  test.skip(
    !browserAvailable(),
    'chromium is not installed — pnpm exec playwright install chromium',
  );

  for (const width of WIDTHS) {
    for (const screen of SCREENS) {
      test(`${screen.name} @ ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: width <= 1024 ? 768 : 900 });
        await page.goto(screen.path);
        await page.waitForSelector('[data-region="needs-you"]');
        if (screen.drive !== undefined) {
          await screen.drive(page);
          await page.waitForTimeout(80);
        }
        const report = (await page.evaluate(
          agreementScript({ roots: screen.roots }),
        )) as AgreementReport;

        /* THE DENOMINATOR, ASSERTED. A sweep that found nothing to compare
           reports exactly like one that found everything in agreement — which
           is the failure mode every instrument in this repo has had at least
           once. These floors are what makes the silence mean something. */
        expect(report.elements, 'the sweep saw almost no elements').toBeGreaterThan(150);
        expect(report.strings, 'the sweep read almost no reader-visible strings').toBeGreaterThan(
          100,
        );
        expect(
          report.claims.length,
          'no element on this screen answers any question this check knows',
        ).toBeGreaterThan(6);
        /* AND THE SENTENCE WITH NO FIELD WORD IN IT. The prototype lane's
           equivalent check was defeated by a badge whose whole text was "3";
           these two numbers are the proof that this one reaches them. */
        expect(
          report.wordlessCounts,
          'no wordless counts found, so that path is untested',
        ).toBeGreaterThan(2);
        expect(
          report.unlabelledCounts,
          'a number is on screen with no string anywhere near it saying what it counts',
        ).toEqual([]);
        /* ALLOWLIST, NOT DENYLIST. A number standing beside this product's owed
           vocabulary that no form parses is a claim the comparison never saw —
           the way a reworded surface would drop out of it silently. */
        expect(
          report.unparsed,
          'a string states a count of owed attention in a form this check cannot read, so it is outside the comparison',
        ).toEqual([]);

        expect(
          report.contradictions,
          'two elements on one screen state different answers to one question',
        ).toEqual([]);
      });
    }
  }

  /* BOTH DIRECTIONS: the analysis reports a contradiction when there is one.
     A check that has only ever been observed passing is a check nobody has seen
     work — and this one's whole claim is that it would have caught r8. The
     screen is mutated in the page (the rail chip is given back the stale number
     r8 painted) and the same analysis is run against it. */
  test('the analysis fails on the screen r8 shipped', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForSelector('[data-region="needs-you"]');
    await openRail(page);
    await page.locator('nav button', { hasText: 'identity-service' }).click();
    await page.locator('[data-attention-id] button', { hasText: 'Answer it' }).click();
    await page.waitForTimeout(80);
    const clean = (await page.evaluate(agreementScript({ roots: null }))) as AgreementReport;
    expect(clean.contradictions).toEqual([]);

    /* r8's screen exactly: the pin, the tab and the footer at 0 while the rail
       chip for the room you are standing in still says 1 owed. */
    await page.evaluate(() => {
      const chip = document.querySelector(
        'nav[aria-label="Rooms and participants"] [aria-current="true"]',
      );
      if (chip === null) throw new Error('no current room chip to mutate');
      chip.setAttribute('aria-label', '#identity-service — 1 owed to you');
    });
    const dirty = (await page.evaluate(agreementScript({ roots: null }))) as AgreementReport;
    expect(
      dirty.contradictions.map((c) => c.question),
      'the rail was given back r8’s stale count and the analysis did not notice',
    ).toContain('owed:here == owed:#identity-service');
  });
});
