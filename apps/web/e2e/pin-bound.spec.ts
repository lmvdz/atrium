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
/* 1124 and 1240 were inside the supported range while the shell's floor was
   1024. The floor is 1280 now — measured, see AppFrame.MINIMUM_WIDTH — so both
   are widths the shell refuses in words rather than lays out for, and measuring
   the pin's budget inside a frame the product says does not fit measures the
   refusal, not the pin. What the two dropped widths caught was the pin keeping
   its full height out of a short frame at a NARROW one; 1280 is now the narrow
   one, and the height sweep below still drives it down to 420px. */
const WIDTHS = [1280, 1340, 1440] as const;
const THEMES = ['light', 'dark'] as const;

/* ROUND 4's GAUNTLET: EVERY VIEWPORT IN THIS FILE HARD-CODED 900.
   `.pinList`'s belt was a constant 340px while `.app` is `height: 100vh`, so at
   1124x500 the pin kept its full height out of a 500px frame, the feed collapsed
   to 22px, and the composer's bottom edge sat at 511 in a 500px viewport with
   `scrollHeight === clientHeight` — round 1's exact signature, unreachable by
   any means the user has. The one dimension the bound was written against was
   the one dimension the harness never varied.

   420 is the floor this app claims: a laptop with browser chrome and a dock, or
   a half-height window. It is asserted rather than assumed, and 500 is in the
   list because it is the number the gauntlet reproduced at. */
const HEIGHTS = [420, 500, 640, 768, 900] as const;

/** Every element in the pin that a person is meant to be able to hit.
    The overflow control is a SIBLING of the clipped list since round 5's blind
    review — a card that grows past the belt may cost a row, but it may not cost
    the affordance that pages past them — so it is selected from the pin, not
    from the list, and checked against the pin's box below. */
const REACHABLE =
  '[data-pin-list] [data-attention-id], [data-region="needs-you"] [data-pin-overflow]';

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
          /* The pin's row budget is measured from the viewport after hydration.
             Reading the geometry before it has been measured reports the
             server's guess and passes for the wrong reason — the same species as
             round 4's computed style read mid-transition. */
          await expect(page.locator('[data-pin-list]')).toHaveAttribute(
            'data-pin-measured',
            'true',
          );

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
              const pin = document.querySelector('[data-region="needs-you"]');
              if (more === null || pin === null) return null;
              const a = more.getBoundingClientRect();
              const b = pin.getBoundingClientRect();
              return { moreBottom: a.bottom, pinBottom: b.bottom, height: a.height };
            });
            expect(seen, 'the overflow affordance is not in the DOM').not.toBeNull();
            expect(seen?.height ?? 0).toBeGreaterThan(0);
            expect(
              seen?.moreBottom ?? Number.POSITIVE_INFINITY,
              'the pin clips its own "N more owed" line',
            ).toBeLessThanOrEqual((seen?.pinBottom ?? 0) + 1);
          }
        }
      });
    }
  }

  /* -------------------------------------------------------------------------
   * THE SAME BOUND, AGAINST THE VIEWPORT'S HEIGHT.
   *
   * The sweep above varies the load and the width; this one varies the height,
   * which is the axis the belt is actually competing with. Both the composer and
   * the feed are asserted, at the heaviest load, in both themes — because a pin
   * that keeps the composer on screen by eating the entire conversation has
   * moved the failure rather than fixed it.
   * ---------------------------------------------------------------------- */
  for (const theme of THEMES) {
    test(`the composer stays in frame at every viewport height — ${theme}`, async ({ page }) => {
      for (const height of HEIGHTS) {
        for (const n of [4, 34] as const) {
          await page.setViewportSize({ width: 1280, height });
          await page.goto(`/gallery/pin/${n}?theme=${theme}`);
          await expect(page.locator('[data-region="needs-you"]')).toBeVisible();
          /* The pin's row budget is measured from the viewport after hydration.
             Reading the geometry before it has been measured reports the
             server's guess and passes for the wrong reason — the same species as
             round 4's computed style read mid-transition. */
          await expect(page.locator('[data-pin-list]')).toHaveAttribute(
            'data-pin-measured',
            'true',
          );

          const measured = await page.evaluate(() => {
            const composer = document.querySelector('textarea')?.closest('div')?.parentElement;
            const feed = document.querySelector('[data-region="conversation"]');
            const pin = document.querySelector('[data-region="needs-you"]');
            const list = document.querySelector('[data-pin-list]');
            const more = document.querySelector('[data-pin-overflow]');
            const box = (el: Element | null | undefined) =>
              el === null || el === undefined ? null : el.getBoundingClientRect();
            return {
              composer: box(composer),
              feed: box(feed),
              pin: box(pin),
              list: box(list),
              more: box(more),
              viewport: window.innerHeight,
              scrollTop: list?.scrollTop ?? 0,
              hidden: (list?.scrollHeight ?? 0) - (list?.clientHeight ?? 0),
            };
          });

          console.info(
            `${theme} @ 1280x${height} · ${n} owed: pin ${Math.round(measured.pin?.height ?? 0)}px · feed ${Math.round(measured.feed?.height ?? 0)}px · composer bottom ${Math.round(measured.composer?.bottom ?? 0)} / ${measured.viewport}`,
          );

          expect(
            measured.composer?.bottom ?? Number.POSITIVE_INFINITY,
            `at ${height}px tall with ${n} owed the composer's bottom edge is ${measured.composer?.bottom} in a ${measured.viewport}px viewport`,
          ).toBeLessThanOrEqual(measured.viewport + 1);
          expect(measured.composer?.top ?? -1).toBeGreaterThanOrEqual(0);

          /* The feed keeps a floor proportional to the frame rather than an
             absolute one: at 420px a 80px feed is a fifth of the screen, which
             is the same share 80px is not at 900. */
          expect(
            measured.feed?.height ?? 0,
            `the pin ate the conversation at ${height}px`,
          ).toBeGreaterThan(Math.min(80, height * 0.12));

          /* And the pin still shows what it says it shows: the belt shrinking
             must not turn it back into the hidden scroll container round 2 shipped. */
          expect(measured.scrollTop, 'the pin scrolled its own content out of view').toBe(0);
          expect(measured.hidden, 'the pin holds more than it can show').toBeLessThanOrEqual(1);
          if (measured.more !== null) {
            expect(
              measured.more.bottom,
              `the pin clips its own "N more owed" line at ${height}px`,
            ).toBeLessThanOrEqual((measured.pin?.bottom ?? 0) + 1);
            expect(measured.more.height, 'the overflow control has no box').toBeGreaterThan(0);
          }
        }
      }
    });
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
          const pin = document.querySelector('[data-region="needs-you"]');
          const pinBox = pin === null ? listBox : pin.getBoundingClientRect();
          const items = [...document.querySelectorAll(selector)].map((el) => {
            const bounds = el.hasAttribute('data-pin-overflow') ? pinBox : listBox;
            const box = el.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            const hit = document.elementFromPoint(x, y);
            return {
              id: el.getAttribute('data-attention-id') ?? 'overflow',
              inside:
                box.top >= bounds.top - 0.5 && box.bottom <= bounds.bottom + 0.5 && box.height > 0,
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

      /* ---------------------------------------------------------------------
       * AND THE PRICE OF REACHING THEM IS BOUNDED, AND STATED BEFORE IT IS PAID.
       *
       * Round 6: "an affordance whose label states a quantity must deliver that
       * quantity" is satisfied by `show the next 1 · page 1 of 60` — sixty
       * clicks to see sixty items, each click honestly delivering the one it
       * promised. A REACHABILITY bound with no COST bound is a bound a control
       * can satisfy while being useless, which is the same species as round 2's
       * idempotent affordance one level of honesty up.
       *
       * Two halves, and the second is the one that was missing:
       *   - the cost is a function of the room there is, not of the list: each
       *     page carries as many rows as the measured budget allows, so pages ×
       *     rows-per-page reaches the whole list without a page that carries
       *     less than the pin can hold.
       *   - the cost is STATED. `page N of M` is on the control before the first
       *     click, so a reader knows the price of the whole list up front rather
       *     than discovering it one click at a time.
       * ------------------------------------------------------------------- */
      const budget = Number(await page.locator('[data-pin-list]').getAttribute('data-pin-budget'));
      expect(budget, 'the pin never measured a row budget').toBeGreaterThan(0);
      expect(
        pages,
        `paging 60 owed items at a budget of ${budget} rows took ${pages} pages — a page that carries less than the pin can hold is a cost the room does not justify`,
      ).toBeLessThanOrEqual(Math.ceil(60 / budget) + 1);
      /* The price is on the control before the first click, not discovered. */
      expect(first?.label, 'the control does not state the total cost').toMatch(/of\s*\d+/);

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

  /* -------------------------------------------------------------------------
   * A CARD THAT GREW MAY COST A ROW; IT MAY NOT COST THE WAY PAST THE ROWS.
   *
   * Found by the blind cross-lineage review of round 5. The row budget is
   * computed from a MEASURED card height, and `AttentionCard` bounds neither its
   * title nor its action count — so an item with a long enough title pushes the
   * card past the belt, and while the "N more owed" control lived inside
   * `.pinList` the first thing `overflow: hidden` ate was the control. Owed
   * items behind an affordance that cannot be reached is round 2's stranding
   * defect with a different cause.
   *
   * The title is clamped to two lines AND the control is a sibling of the
   * clipped list. This drives the pathological case the clamp is supposed to
   * make impossible — a title stretched in the DOM, past any clamp — so the
   * structural half is what is being tested rather than the arithmetic half.
   * ---------------------------------------------------------------------- */
  for (const height of [420, 900] as const) {
    test(`a pathological card cannot strand the way out of the fold — @${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height });
      await page.goto('/gallery/pin/34?theme=light');
      await expect(page.locator('[data-pin-list]')).toHaveAttribute('data-pin-measured', 'true');

      await page.evaluate(() => {
        const title = document.querySelector('[data-pin-list] article div');
        if (title === null) throw new Error('no open card title to stretch');
        /* Past the two-line clamp on purpose: the clamp is the arithmetic
           defence and this test is about the structural one. */
        (title as HTMLElement).style.webkitLineClamp = 'unset';
        (title as HTMLElement).style.display = 'block';
        title.textContent = `${'an owed item whose title runs on and on '.repeat(30)}.`;
      });

      const seen = await page.evaluate(() => {
        const more = document.querySelector('[data-pin-overflow]');
        const pin = document.querySelector('[data-region="needs-you"]');
        if (more === null || pin === null) return null;
        const box = more.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + Math.min(box.height / 2, 8),
        );
        return {
          height: box.height,
          insidePin: box.bottom <= pin.getBoundingClientRect().bottom + 1,
          reachable: hit !== null && (hit === more || more.contains(hit)),
        };
      });
      console.info(`stretched card @${height}: overflow control ${JSON.stringify(seen)}`);
      expect(seen, 'the overflow control left the DOM').not.toBeNull();
      expect(seen?.height ?? 0, 'a long title clipped the overflow control').toBeGreaterThan(0);
      expect(seen?.insidePin, 'the overflow control was pushed out of the pin').toBe(true);
      expect(seen?.reachable, 'the overflow control cannot be hit by a pointer').toBe(true);

      // and it still pages: the owed items behind it are still reachable
      const before = await page.locator('[data-pin-overflow]').getAttribute('data-pin-overflow');
      await page.locator('[data-pin-overflow]').click();
      const rows = await page.locator('[data-pin-list] [data-attention-id]').count();
      console.info(
        `stretched card @${height}: ${before} overflow before the click, ${rows} rows after`,
      );
      expect(rows, 'the control did nothing').toBeGreaterThan(0);
    });
  }

  /* ROUND 11, FINDING 1(b) — A GROWN CARD MOVES THE COUNT THE READER READS.
   *
   * The round-2 receipt claimed a grown card dropped a row and took the overflow
   * from 29 to 30; the blind page critic drove the real page and watched the
   * count SIT STILL — the budget stayed 4, the overflow stayed 29, and a tall
   * enough card clipped compressed rows in silence while the control still read
   * "29 more owed." The card is grown by an inline `min-height` rather than by
   * injected text on purpose: React reconciles the title back to its prop on the
   * very re-render the growth triggers, so a textContent stretch reverts before
   * it can be read, but a style the component never set survives. The card
   * growing must lower `data-pin-budget`, raise `data-pin-overflow` by the rows
   * it cost, and then SETTLE — no oscillation. */
  test('a card that grows drops rows and moves the overflow count, then settles', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/gallery/pin/34?theme=light');
    const list = page.locator('[data-pin-list]');
    await expect(list).toHaveAttribute('data-pin-measured', 'true');

    const budget = async () => Number(await list.getAttribute('data-pin-budget'));
    const overflow = async () =>
      Number(await page.locator('[data-pin-overflow]').getAttribute('data-pin-overflow'));
    const budget0 = await budget();
    const overflow0 = await overflow();
    expect(budget0, 'the pin is not showing rows to drop').toBeGreaterThan(1);

    /* grow the open card past the belt with a style the component does not own,
       so the growth is not clobbered on the re-render it causes */
    await page.evaluate(() => {
      const card = document.querySelector('[data-pin-list] article') as HTMLElement | null;
      if (card === null) throw new Error('no open card to grow');
      card.style.minHeight = '260px';
    });

    /* the budget comes down and the overflow goes up by exactly the rows the
       grown card cost — the count is not stale */
    await expect.poll(budget, { timeout: 2000 }).toBeLessThan(budget0);
    const budget1 = await budget();
    const overflow1 = await overflow();
    expect(overflow1, 'the overflow count did not move when the card grew').toBe(
      overflow0 + (budget0 - budget1),
    );
    expect(overflow0 + budget0, 'a row was lost between the fold and the count').toBe(
      overflow1 + budget1,
    );

    /* AND IT SETTLED: the grown card is a fixed point, not a flicker. Read the
       budget across a spell in which the observers have every chance to fire. */
    await page.waitForTimeout(250);
    expect(await budget(), 'the pin never stopped re-folding after the card grew').toBe(budget1);
    console.info(
      `grown card @900: budget ${budget0}→${budget1}, overflow ${overflow0}→${overflow1}, settled`,
    );
  });

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
