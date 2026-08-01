import { existsSync } from 'node:fs';
import { chromium, expect, test } from '@playwright/test';
import type { AuditResult } from './audit';
import { AUDIT } from './audit';

/**
 * Playwright downloads its browsers into a cache outside the repo. In sandboxes
 * where that download is blocked, skip with a reason instead of failing the
 * suite — a red gallery test would say "the design system is broken" when the
 * truth is "no browser is installed".
 */
function browserAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const FRAMES = [
  'fresh-room',
  'since-you-left',
  'filtered',
  'receipt-open',
  'cross-room-jump',
  'zero-owed',
] as const;

/** The two design targets plus the two edges of the supported range. */
const WIDTHS = [1124, 1280, 1340, 1440] as const;

const THEMES = ['light', 'dark'] as const;

test.describe('gallery', () => {
  test.skip(
    !browserAvailable(),
    'Playwright browsers are not installed — run `pnpm exec playwright install chromium`',
  );

  for (const theme of THEMES) {
    test(`every frame renders in the ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/gallery?theme=${theme}`);

      await expect(page.locator('[data-gallery-frame]')).toHaveCount(FRAMES.length);
      for (const frame of FRAMES) {
        const box = page.locator(`[data-gallery-frame="${frame}"]`);
        await expect(box).toBeVisible();
        // a full frame, not a crop of one: all four regions present inside it
        await expect(box.locator('nav[aria-label="Rooms and people"]')).toHaveCount(1);
        await expect(box.locator('[data-region="needs-you"]')).toHaveCount(1);
        await expect(box.locator('[data-region="conversation"]')).toHaveCount(1);
        await expect(box.locator('[data-region="current-state"]')).toHaveCount(1);
      }

      // the theme is one class on <html> and nothing else
      expect(await page.locator('html').evaluate((el) => el.classList.contains('atr-dark'))).toBe(
        theme === 'dark',
      );
    });
  }

  test('the frames render the states they claim to', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');

    const sinceYouLeft = page.locator('[data-gallery-frame="since-you-left"]');
    // counts by attention class, and the divider is not yet muted
    await expect(sinceYouLeft.locator('[data-row="since-you-left"]')).toHaveAttribute(
      'data-seen',
      'false',
    );
    await expect(sinceYouLeft.locator('[data-count-class="need"]')).toHaveText('4 NEED YOU');
    // hardest first: the ■ destructive decision is the open card
    await expect(
      sinceYouLeft.locator('[data-region="needs-you"] article [data-glyph]').first(),
    ).toHaveAttribute('data-glyph', '■');
    // the routine group says what it hid, not just how much
    await expect(sinceYouLeft.locator('[data-row="routine"]')).toContainText('8 routine');
    await expect(sinceYouLeft.locator('[data-row="routine"]')).toContainText('11:50 – 11:57');
    await expect(sinceYouLeft.locator('[data-row="routine"]')).toContainText('click to peek');

    const filtered = page.locator('[data-gallery-frame="filtered"]');
    // marked seen MUTES the divider; the counts and window survive
    await expect(filtered.locator('[data-row="since-you-left"]')).toHaveAttribute(
      'data-seen',
      'true',
    );
    await expect(filtered.locator('[data-row="since-you-left"]')).toContainText('marked seen');
    await expect(filtered.locator('[data-count-class="need"]')).toHaveText('4 NEED YOU');
    /* A filter DIMS rows; it never removes them. A row you cannot see is a row
       you cannot check — so the non-matching rows are still in the DOM, still
       readable, and measurably faded rather than gone. */
    const unfilteredCount = await page
      .locator(
        '[data-gallery-frame="since-you-left"] [data-region="conversation"] [data-row="message"]',
      )
      .count();
    const filteredRows = filtered.locator('[data-region="conversation"] [data-row="message"]');
    expect(await filteredRows.count()).toBe(unfilteredCount);
    const dimmed = filtered.locator('[data-row="message"][data-dimmed="true"]');
    expect(await dimmed.count()).toBeGreaterThan(0);
    expect(
      await dimmed.first().evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)),
    ).toBeLessThan(0.5);
    await expect(dimmed.first()).toBeVisible();
    const kept = filtered.locator('[data-row="message"]:not([data-dimmed])');
    expect(
      await kept.first().evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)),
    ).toBe(1);

    /* An irreversible item holds even when it is compressed: friction belongs
       to the action, not to how much room the card was given. */
    await expect(
      filtered.locator('[data-attention-id="X1"] button[data-hold="2000"]'),
    ).toBeVisible();

    const receipt = page.locator('[data-gallery-frame="receipt-open"]');
    await expect(receipt.locator('[data-receipt-id="P1"]')).toBeVisible();
    // every excerpt in the receipt carries its provenance
    const quoted = receipt.locator('[data-quoted]');
    expect(await quoted.count()).toBeGreaterThan(0);
    for (const ref of await quoted.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-quoted')),
    )) {
      expect(ref).toMatch(/^msg:/);
    }

    const jump = page.locator('[data-gallery-frame="cross-room-jump"]');
    await expect(jump.locator('[data-row="cross-room-jump"]')).toBeVisible();
    await expect(jump.locator('[data-row="cross-room-jump"]')).toHaveAttribute(
      'data-voice',
      'system',
    );

    const zero = page.locator('[data-gallery-frame="zero-owed"]');
    await expect(zero.locator('[data-region="needs-you"]')).toContainText(
      'THAT IS A RESULT, NOT AN ABSENCE',
    );
    // and the trailer only says "verified" because it derived it
    await expect(zero.locator('[data-row="trailer"]')).toContainText('everything else is verified');

    // the room that owes nothing may not say everything is green
    await expect(
      page.locator('[data-gallery-frame="fresh-room"] [data-row="trailer"]'),
    ).not.toContainText('everything else is verified');
  });

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`no horizontal overflow, no type below 10px, AA contrast — ${theme} @ ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/gallery?theme=${theme}`);
        // Audit the gallery, not a dev server still compiling it.
        await expect(page.locator('[data-gallery-frame]')).toHaveCount(FRAMES.length);
        await expect(page.locator('[data-row="trailer"]').first()).toBeVisible();
        await page.waitForLoadState('networkidle');

        const audit = (await page.evaluate(AUDIT)) as AuditResult;
        expect(audit.elementsChecked, 'the audit found almost nothing to check').toBeGreaterThan(
          500,
        );

        // Reported so the numbers land in the run log, not just the assertions.
        console.info(
          `${theme} @ ${width}: ${audit.elementsChecked} text elements · smallest font ${audit.smallestFont}px · lowest contrast ${audit.lowestContrast}:1 · scrollWidth ${audit.overflow.documentScrollWidth} / clientWidth ${audit.overflow.documentClientWidth}`,
        );

        expect(audit.overflow.widest, 'unclipped elements past the right edge').toEqual([]);
        expect(audit.overflow.scrollingFrames, 'a frame scrolls sideways').toEqual([]);
        expect(audit.overflow.documentScrollWidth).toBeLessThanOrEqual(
          audit.overflow.documentClientWidth,
        );
        expect(audit.fontFailures, 'text below the 10px floor').toEqual([]);
        expect(audit.contrastFailures, 'text below AA').toEqual([]);
      });
    }
  }

  test('reduced motion is honoured globally, not per component', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');

    const animated = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .map((el) => {
          const style = getComputedStyle(el);
          return {
            animation: style.animationName,
            transition: style.transitionProperty,
            className: typeof el.className === 'string' ? el.className : '',
          };
        })
        .filter((s) => s.animation !== 'none' || s.transition !== 'all')
        .filter((s) => s.animation !== 'none')
        .slice(0, 5),
    );
    expect(animated, 'an animation survived prefers-reduced-motion').toEqual([]);

    // and the elements that WOULD animate are still there, still visible
    await expect(page.locator('.atr-rise-s').first()).toBeVisible();
    await context.close();
  });

  test('motion is present when it is not suppressed', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    const name = await page
      .locator('.atr-rise-s')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe('gl-rise');
    await context.close();
  });

  test('the theme switch is the only theme mechanism', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    const html = page.locator('html');
    expect(await html.evaluate((el) => el.classList.contains('atr-dark'))).toBe(false);

    await page.getByTestId('gallery-theme-dark').click();
    await expect.poll(() => html.evaluate((el) => el.classList.contains('atr-dark'))).toBe(true);

    // no frame carries a theme override of its own
    const overrides = await page.evaluate(
      () => document.querySelectorAll('[data-theme], [class*="theme-"]').length,
    );
    expect(overrides).toBe(0);
  });
});
