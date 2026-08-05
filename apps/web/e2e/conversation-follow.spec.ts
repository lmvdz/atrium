import { expect, test } from '@playwright/test';

test('the live edge follows a newly sent message in the rendered workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1124, height: 500 });
  await page.goto('/');
  const feed = page.locator('[data-region="conversation"]');
  const composer = page.getByRole('combobox', { name: /Message #/ });
  await expect(feed).toBeVisible();
  await composer.fill('browser follow probe');
  await composer.press('Enter');
  await expect(feed.locator('[data-message-id]').last()).toContainText('browser follow probe');
  await expect
    .poll(() =>
      feed.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThanOrEqual(12);
});
