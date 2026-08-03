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

  /**
   * Mutation: calculate a divider chip from a hand-written total while the
   * filter classifies the persisted rows. The number on the clicked chip and
   * the number reported as lifted diverge.
   */
  test('derives every replay-divider count from the rows its filter lifts', async ({ page }) => {
    await page.goto('/replay/atrium-replay/nextjs-isr');

    const divider = page.locator('[data-row="since-you-left"]');
    for (const attentionClass of ['need', 'change', 'discussion'] as const) {
      const chip = divider.locator(`[data-count-class="${attentionClass}"]`);
      const label = (await chip.textContent())?.trim() ?? '';
      const count = Number.parseInt(label, 10);
      expect(count).toBeGreaterThan(0);

      await chip.click();
      await expect(page.locator(`[data-filter-note="${attentionClass}"]`)).toContainText(
        `${count} ${count === 1 ? 'row' : 'rows'} lifted`,
      );
      await chip.click();
      await expect(page.locator(`[data-filter-note="${attentionClass}"]`)).toHaveCount(0);
    }
  });

  /**
   * Mutation: treat an answer-bound message as ordinary chat, remove only the
   * pin row, or build the receipt from proposal text rather than its persisted
   * source. The typed answer, accepted object, and quoted source can no longer
   * be observed together through the product surfaces.
   */
  test('binds a typed answer to the pending decision and opens its sourced receipt', async ({
    page,
  }) => {
    const decision =
      "Correct. This will cause a server-side render of the full page for a missing path (that wasn't prerendered via `paths: [...]`), instead of doing the static fallback and then load client-side. All other benefits and functionality remains the same.";
    const answer = 'Use the server-rendered fallback for paths that were not prerendered.';
    await page.goto('/replay/atrium-replay/nextjs-isr');

    await page.getByRole('button', { name: 'answer', exact: true }).click();
    const composer = page.getByRole('textbox', {
      name: `Answer ${decision} in your own words`,
    });
    await composer.fill(answer);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    const receipt = page.getByRole('region', { name: 'Receipt' });
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('✓');
    await expect(receipt).toContainText('DECISION');
    await expect(receipt).toContainText('accepted');
    await expect(receipt.locator('[data-quoted]')).toContainText(decision);

    await receipt.getByRole('button', { name: '← BACK TO CURRENT STATE' }).click();
    const accepted = page
      .locator('[data-region="current-state"] [data-object-id]')
      .filter({ hasText: decision });
    await expect(accepted).toContainText('✓');
  });
});
