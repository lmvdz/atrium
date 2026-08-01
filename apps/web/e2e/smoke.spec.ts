import { existsSync } from 'node:fs';
import { chromium, expect, test } from '@playwright/test';

/**
 * Playwright downloads its browsers into a cache outside the repo. In sandboxes
 * where that download is blocked, skip with a reason instead of failing the
 * suite — a red smoke test would say "the app is broken" when the truth is "no
 * browser is installed".
 */
function browserAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

test.describe('shell', () => {
  test.skip(
    !browserAvailable(),
    'Playwright browsers are not installed — run `pnpm exec playwright install chromium`',
  );

  test('renders the three surfaces of the real frame', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // Conversation on the left, what needs YOU pinned above it, what the group
    // now understands in the lens — init.md §3, on screen at the same time.
    await expect(page.locator('[data-region]')).toHaveCount(3);
    await expect(page.locator('[data-region="conversation"]')).toBeVisible();
    await expect(page.locator('[data-region="needs-you"]')).toBeVisible();
    await expect(page.locator('[data-region="current-state"]')).toBeVisible();

    // every owed item states why it needs this person
    await expect(page.locator('[data-region="needs-you"]')).toContainText('WHY YOU');
    await expect(page.locator('[data-region="needs-you"] article')).toContainText(
      'no automated path may drop a table',
    );

    // the rail is navigation; the roster is not
    await expect(page.getByRole('navigation', { name: 'Rooms and people' })).toBeVisible();
  });

  /* -------------------------------------------------------------------------
   * `/` IS OPERABLE.
   *
   * Round 2's gauntlet: this page forwarded no handlers at all, so the demo
   * meant to prove the component library worked was a screen of controls that
   * did nothing when clicked. Nothing was forced to fork — the props existed —
   * but "the props exist" is not the claim the page makes by rendering them.
   * ---------------------------------------------------------------------- */
  test('the controls on / actually do something', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    /* Every handler writes what it did into the composer's note, so a control
       that fires nothing is a note that does not change. */
    const note = page.locator('[data-composer-note]');

    /* THE COMPOSER'S OWN CONTRACT. The footer says "↵ send"; type and press
       Enter, and a real row appears — built through `messageEntry` from a real
       record, so it is quotable, attributed, and its body reads as its
       record. */
    const rowsBefore = await page.locator('[data-row="message"]').count();
    const composer = page.getByRole('textbox');
    await composer.click();
    await composer.type('the composer seam is real');
    await composer.press('Enter');
    await expect(page.locator('[data-row="message"]')).toHaveCount(rowsBefore + 1);
    const sent = page.locator('[data-row="message"]').last();
    await expect(sent.locator('[data-attribution]')).toHaveText('lars');
    await expect(sent.locator('[data-row-body]')).toHaveText('the composer seam is real');
    await expect(composer).toHaveValue('');

    /* SHIFT+ENTER IS A NEWLINE, which is the other half of the same sentence. */
    await composer.type('two');
    await composer.press('Shift+Enter');
    await expect(page.locator('[data-row="message"]')).toHaveCount(rowsBefore + 1);
    await expect(composer).toHaveValue(/two/);

    await expect(note).toContainText('typed, quotable, attributed to lars');

    // the surface indicators focus rather than navigate — and they respond
    const surface = page.locator('[data-surface="current-state"]');
    await expect(surface).toHaveAttribute('aria-pressed', 'false');
    await surface.click();
    await expect(surface).toHaveAttribute('aria-pressed', 'true');
    await expect(note).toContainText('focused current-state');

    // the filter chips filter
    await page.locator('[data-count-class="need"]').first().click();
    await expect(note).toContainText('filtered to need');
    await expect(page.locator('[data-row="message"][data-dimmed="true"]').first()).toBeVisible();

    // acting on an owed item takes it out of the pin
    const owedBefore = await page.locator('[data-region="needs-you"] [data-attention-id]').count();
    await page
      .locator('[data-region="needs-you"] button')
      .filter({ hasText: 'Keep it behind the retention window' })
      .first()
      .click();
    await expect(note).toContainText('it leaves the pin because it no longer needs you');
    await expect(page.locator('[data-region="needs-you"] [data-attention-id]')).not.toHaveCount(
      owedBefore,
    );

    /* Nothing on this page renders an absent value as a word. The RENDERED text,
       not `page.content()` — the dev server's own inline bundles contain the
       literal "undefined" and a check that reads them is a check that can only
       fail. */
    const rendered = await page.evaluate(() => document.body.innerText);
    expect(rendered).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]/);
  });

  test('toggles dark mode via the atr-dark class', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    const toggle = page.getByTestId('theme-toggle');

    // The button is server-rendered; wait for React to attach the handler.
    await expect(toggle).toHaveAttribute('data-hydrated', 'true');
    const before = await html.evaluate((el) => el.classList.contains('atr-dark'));

    await toggle.click();
    await expect.poll(() => html.evaluate((el) => el.classList.contains('atr-dark'))).toBe(!before);
  });
});
