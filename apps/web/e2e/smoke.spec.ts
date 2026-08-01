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

  test('renders the three regions', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Current state' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();

    await expect(page.locator('[data-region]')).toHaveCount(3);
    await expect(page.locator('[data-region="needs-you"]')).toContainText('needs you specifically');
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
