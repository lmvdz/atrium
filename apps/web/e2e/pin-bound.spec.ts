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

const LOADS = [4, 13, 19, 34, 60] as const;
const WIDTHS = [1124, 1240, 1340, 1440] as const;
const THEMES = ['light', 'dark'] as const;

/** Every element inside the pin's list that a person is meant to be able to hit. */
const REACHABLE = '[data-pin-list] [data-attention-id], [data-pin-list] [data-pin-overflow]';

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

  /* -------------------------------------------------------------------------
   * THE EXPANDED STATE, WHICH IS WHERE ROUND 2 FAILED.
   *
   * The checks above only ever looked at the unexpanded pin. Expanded at 60
   * owed, `showAll` raised the row budget from 4 to a hard cap of 9 while the
   * list's 340px belt stayed put: 50 of 60 owed items were unreachable by any
   * pointer input, behind a live-looking "50 more owed" that had already done
   * everything it was ever going to do, and tabbing into the pin scrolled the
   * `overflow: hidden` container and took rows off the TOP with no way back.
   * ---------------------------------------------------------------------- */

  for (const theme of THEMES) {
    test(`paging the pin reaches every owed item and clips none of them — ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/gallery/pin/60?theme=${theme}`);
      await expect(page.locator('[data-region="needs-you"]')).toBeVisible();

      /* Everything the pin can show, on this page, measured as the browser laid
         it out: inside the list's visible box, hit-testing to itself, and with
         the list not secretly scrolled. */
      const snapshot = () =>
        page.evaluate((selector) => {
          const list = document.querySelector('[data-pin-list]');
          if (list === null) return null;
          const listBox = list.getBoundingClientRect();
          const items = [...document.querySelectorAll(selector)].map((el) => {
            const box = el.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            const hit = document.elementFromPoint(x, y);
            return {
              id: el.getAttribute('data-attention-id') ?? 'overflow',
              inside:
                box.top >= listBox.top - 0.5 &&
                box.bottom <= listBox.bottom + 0.5 &&
                box.height > 0,
              reachable: hit !== null && (hit === el || el.contains(hit)),
              text: (el.textContent ?? '').slice(0, 40),
            };
          });
          const control = document.querySelector('[data-pin-overflow]');
          return {
            items,
            scrollTop: list.scrollTop,
            scrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight,
            overflow: Number(control?.getAttribute('data-pin-overflow') ?? 0),
            next: Number(control?.getAttribute('data-pin-next') ?? 0),
            page: control?.getAttribute('data-pin-page') ?? '',
            label: (control?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          };
        }, REACHABLE);

      const first = await snapshot();
      expect(first, 'the pin rendered no list').not.toBeNull();
      const pages = Number(first?.page.split('/')[1]);
      expect(pages, 'the overflow control does not say how many pages there are').toBeGreaterThan(
        1,
      );

      const seen = new Set<string>();
      for (let click = 0; click < pages; click += 1) {
        const before = await snapshot();
        expect(before).not.toBeNull();

        /* THE CLIP. Every row AND the overflow line are inside the list's
           visible box — not merely in the DOM — and each hit-tests to itself,
           which is what "reachable by pointer" means. */
        for (const item of before?.items ?? []) {
          expect(item.inside, `"${item.text}" is outside the pin's visible box`).toBe(true);
          expect(item.reachable, `"${item.text}" cannot be hit by a pointer`).toBe(true);
          seen.add(item.id);
        }

        /* And the list is not a hidden scroll container: nothing has been
           scrolled off the top, and there is nothing below the clip to scroll
           to. This is the exact failure mode of the r2 expanded state. */
        expect(before?.scrollTop, 'the pin has scrolled its own content out of view').toBe(0);
        expect(
          (before?.scrollHeight ?? 0) - (before?.clientHeight ?? 0),
          'the pin holds more than it can show',
        ).toBeLessThanOrEqual(1);

        // the label promises what the next click delivers
        const promised = before?.next ?? 0;
        expect(before?.label).toContain(String(promised));
        await page.locator('[data-pin-overflow]').click();
        const after = await snapshot();
        const rows = (after?.items ?? []).filter((i) => i.id !== 'overflow');
        expect(rows.length - 1, 'the control revealed a different number than it promised').toBe(
          promised,
        );
        expect(
          after?.items.map((i) => i.id),
          'the overflow control did nothing',
        ).not.toEqual(before?.items.map((i) => i.id));
      }

      const rows = [...seen].filter((id) => id !== 'overflow');
      console.info(
        `${theme} @ 60 owed: ${pages} pages · ${rows.length} distinct owed rows reached by clicking · every row and the overflow line inside the clip`,
      );
      expect(rows.length, `only ${rows.length} of 60 owed items were reachable`).toBe(60);

      // and the composer is still where it belongs, in the expanded state too
      const bottom = await page.evaluate(() => {
        const composer = document.querySelector('textarea')?.closest('div')?.parentElement;
        return {
          bottom: composer?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
          viewport: window.innerHeight,
        };
      });
      expect(bottom.bottom).toBeLessThanOrEqual(bottom.viewport + 1);
    });
  }

  /* The keyboard reaches the same places the pointer does, and focusing a row
     does not scroll the list out from under everything else — the r2 expanded
     pin clipped three rows off the top when a keyboard user tabbed into it. */
  test('tabbing through the pin never scrolls a row out of the clip', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery/pin/60?theme=light');
    await expect(page.locator('[data-pin-list]')).toBeVisible();

    let worst = 0;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const report = await page.evaluate(() => {
        const list = document.querySelector('[data-pin-list]');
        const active = document.activeElement;
        if (list === null || active === null) return null;
        return {
          scrollTop: list.scrollTop,
          inPin: list.contains(active),
        };
      });
      if (report?.inPin === true) worst = Math.max(worst, report.scrollTop);
    }
    console.info(`keyboard: worst pin scrollTop while tabbing = ${worst}`);
    expect(worst, 'keyboard focus scrolled the pin and clipped rows off the top').toBe(0);
  });

  /* CATCHES the route's own NaN: /gallery/pin/abc rendered a whole frame
     announcing "NaN owed to you" from an unguarded parseInt. */
  test('a non-numeric pin load is a 404, not a frame full of NaN', async ({ page }) => {
    const response = await page.goto('/gallery/pin/abc');
    expect(response?.status()).toBe(404);
    expect(await page.content()).not.toContain('NaN');
  });
});
