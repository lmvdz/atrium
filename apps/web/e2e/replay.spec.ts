import { expect, test } from '@playwright/test';

test.describe('persisted three-surface replay', () => {
  /**
   * Mutation: route the replay through gallery fixtures, truncate the corpus,
   * or leave the range input disconnected. The database-backed title/count and
   * the three-message prefix can no longer all be observed in one browser.
   *
   * Mutation: keep final worker objects visible while the cursor is at three.
   * The objective appears before the worker has read the complete import.
   */
  test('loads the full corpus and steps through its honest worker boundary', async ({ page }) => {
    await page.goto('/replay/atrium-replay/nextjs-isr');

    const controls = page.getByRole('navigation', { name: 'Replay controls' });
    await expect(controls).toContainText('interpreted · 454 / 454');
    await expect(
      page.getByRole('heading', { name: 'incremental static regeneration', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Fully automatic re-rendering of statically exported pages without a full rebuild.',
        { exact: true },
      ),
    ).toBeVisible();

    const slider = page.getByRole('slider', { name: 'Replay position' });
    await slider.press('Home');
    await slider.press('ArrowRight');
    await slider.press('ArrowRight');
    await slider.press('ArrowRight');
    await expect(controls).toContainText('message 3 / 454');
    await expect(
      page.getByText(
        'You would still need a full rebuild if you change something shared with all pages eg header, correct?',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Fully automatic re-rendering of statically exported pages without a full rebuild.',
        { exact: true },
      ),
    ).toHaveCount(0);
  });
});
