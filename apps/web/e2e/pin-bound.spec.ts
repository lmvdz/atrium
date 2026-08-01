import { existsSync } from 'node:fs';
import { chromium, expect, test } from '@playwright/test';

/* ---------------------------------------------------------------------------
 * THE COMPOSER STAYS IN FRAME.
 *
 * Round 1, measured at 1440×900 against the unbounded pin:
 *   13 owed items → the feed was 183px tall
 *   17 owed items → 55px
 *   19 owed items → the composer's bottom edge sat at 909 in a 900 viewport,
 *                   and `scrollHeight` stayed 900, so it could not be scrolled
 *                   back — unreachable by any means the user has
 *   34 owed items → 89 elements below the fold
 *
 * This drives the same four counts across the four supported widths in both
 * themes and asserts what the user actually needs: the composer is on screen,
 * the feed still has room to be a feed, and the owed items that did not fit are
 * counted rather than dropped.
 * ------------------------------------------------------------------------- */

function browserAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const LOADS = [4, 13, 19, 34] as const;
const WIDTHS = [1124, 1240, 1340, 1440] as const;
const THEMES = ['light', 'dark'] as const;

test.describe('the pin bounds itself', () => {
  test.skip(
    !browserAvailable(),
    'Playwright browsers are not installed — run `pnpm exec playwright install chromium`',
  );

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`the composer stays in frame at every load — ${theme} @ ${width}`, async ({ page }) => {
        for (const n of LOADS) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`/gallery/pin/${n}?theme=${theme}`);
          await expect(page.locator('[data-region="needs-you"]')).toBeVisible();

          const measured = await page.evaluate(() => {
            const composer = document.querySelector('textarea')?.closest('div')?.parentElement;
            const feed = document.querySelector('[data-region="conversation"]');
            const pin = document.querySelector('[data-region="needs-you"]');
            const box = (el: Element | null | undefined) =>
              el === null || el === undefined ? null : el.getBoundingClientRect();
            return {
              composer: box(composer),
              feed: box(feed),
              pin: box(pin),
              viewport: window.innerHeight,
              documentScrollHeight: document.documentElement.scrollHeight,
              rows: document.querySelectorAll('[data-region="needs-you"] [data-attention-id]')
                .length,
              overflow: document
                .querySelector('[data-pin-overflow]')
                ?.getAttribute('data-pin-overflow'),
            };
          });

          const composer = measured.composer;
          const feed = measured.feed;
          expect(composer, 'the composer is not in the DOM').not.toBeNull();
          expect(feed).not.toBeNull();

          console.info(
            `${theme} @ ${width} · ${n} owed: pin ${Math.round(measured.pin?.height ?? 0)}px · feed ${Math.round(feed?.height ?? 0)}px · composer bottom ${Math.round(composer?.bottom ?? 0)} / ${measured.viewport} · rows ${measured.rows} · overflow ${measured.overflow ?? '0'}`,
          );

          /* THE ASSERTION THAT MATTERS: the composer's bottom edge is inside
             the viewport. Round 1's 19-item case failed this by 9px with no
             scroll available. */
          expect(
            composer?.bottom ?? Number.POSITIVE_INFINITY,
            `${n} owed items pushed the composer to ${composer?.bottom} in a ${measured.viewport}px viewport`,
          ).toBeLessThanOrEqual(measured.viewport + 1);
          expect(composer?.top ?? -1).toBeGreaterThanOrEqual(0);

          // and the feed is still a feed, not a sliver
          expect(feed?.height ?? 0, 'the pin ate the conversation').toBeGreaterThan(80);

          // the pin never renders more rows than its budget, whatever arrives
          expect(measured.rows).toBeLessThanOrEqual(5);

          // nothing owed is dropped: rows + overflow accounts for all of them
          const overflow = Number(measured.overflow ?? 0);
          expect(measured.rows + overflow).toBe(n);

          /* And the affordance that says so is VISIBLE, not merely present. The
             pin's max-height clips its own list, so a "N more owed" line that
             exists in the DOM but sits below the clip announces nothing — which
             is the same defect as not counting the overflow at all, wearing a
             passing test. */
          if (overflow > 0) {
            const seen = await page.evaluate(() => {
              const more = document.querySelector('[data-pin-overflow]');
              const list = document.querySelector('[data-pin-list]');
              if (more === null || list === null) return null;
              const a = more.getBoundingClientRect();
              const b = list.getBoundingClientRect();
              return { moreBottom: a.bottom, listBottom: b.bottom, height: a.height };
            });
            expect(seen, 'the overflow affordance is not in the DOM').not.toBeNull();
            expect(seen?.height ?? 0).toBeGreaterThan(0);
            expect(
              seen?.moreBottom ?? Number.POSITIVE_INFINITY,
              'the pin clips its own "N more owed" line',
            ).toBeLessThanOrEqual((seen?.listBottom ?? 0) + 1);
          }
        }
      });
    }
  }

  /* The overflow affordance is not decorative: using it shows more owed items
     and STILL keeps the composer on screen — the pin folds rather than
     scrolling, at every step. */
  test('opening the overflow shows more without losing the composer', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery/pin/34?theme=light');
    const before = await page.locator('[data-attention-id]').count();
    await page.locator('[data-pin-overflow]').click();
    const after = await page.locator('[data-attention-id]').count();
    expect(after).toBeGreaterThan(before);

    const bottom = await page.evaluate(() => {
      const composer = document.querySelector('textarea')?.closest('div')?.parentElement;
      return {
        bottom: composer?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
        viewport: window.innerHeight,
      };
    });
    console.info(
      `overflow opened: ${before} → ${after} rows · composer bottom ${Math.round(bottom.bottom)} / ${bottom.viewport}`,
    );
    expect(bottom.bottom).toBeLessThanOrEqual(bottom.viewport + 1);
  });
});
