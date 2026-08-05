import { expect, test } from '@playwright/test';

test('the live edge follows a newly sent message in the rendered workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1124, height: 500 });
  await page.goto('/');
  const feed = page.locator('[data-region="conversation"]');
  const composer = page.getByRole('combobox', { name: /Message #/ });
  await expect(feed).toBeVisible();
  const message = [
    'browser follow probe',
    ...Array.from({ length: 18 }, (_, i) => `line ${i + 1}`),
  ].join('\n');
  await composer.fill(message);
  await page.getByRole('button', { name: 'Send' }).click();
  const appended = feed.locator('[data-message-id]').last();
  await expect(appended).toContainText('browser follow probe');
  await expect
    .poll(async () => {
      const [feedBox, rowBox] = await Promise.all([feed.boundingBox(), appended.boundingBox()]);
      return (rowBox?.y ?? -1000) - (feedBox?.y ?? 0);
    })
    .toBeGreaterThanOrEqual(0);
});

test('a paused conversation marks and counts the oldest unseen boundary', async ({ page }) => {
  await page.setViewportSize({ width: 1124, height: 500 });
  await page.goto('/');
  const feed = page.locator('[data-region="conversation"]');
  await feed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  const composer = page.getByRole('combobox', { name: /Message #/ });
  await composer.fill('unseen boundary probe');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(feed.locator('[data-unread-divider="1"]')).toHaveText('1 new message');
  await expect(page.getByRole('button', { name: '↓ 1 new message' })).toBeVisible();
});
