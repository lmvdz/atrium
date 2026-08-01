import { expect, test } from '@playwright/test';
import { browserAvailable } from './support/flows';

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

  test('offers a way in to someone who is not signed in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('sign-in-link')).toBeVisible();
    await page.getByTestId('sign-in-link').click();
    await page.waitForURL(/\/sign-in/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
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
