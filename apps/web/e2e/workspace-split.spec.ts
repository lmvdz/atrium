import { expect, test } from '@playwright/test';
import { requireBrowser } from './support/flows';

test.describe('current state and conversation split', () => {
  requireBrowser();

  /**
   * CATCHES: stacking StateLens and Timeline as unbounded flex siblings, or
   * painting a separator that cannot resize/collapse the panes it describes.
   */
  test('the divider resizes and can collapse either pane', async ({ page }) => {
    await page.goto('/gallery/pin/4');
    const frame = page.locator('[data-frame]').first();
    const split = frame.locator('[data-workspace-split="true"]');
    /* The split panes are layout boxes, not landmarks — see RoomFrame. They
       were labelled regions, and the conversation one's name contained the
       feed's own accessible name, so `getByRole('region', { name:
       'Conversation' })` matched both. Same two boxes, addressed by the handle
       they carry for exactly this. */
    const state = frame.locator('[data-split-pane="current-state"]');
    const conversation = frame.locator('[data-split-pane="conversation"]');
    const separator = frame.getByRole('separator', {
      name: 'Resize current state and conversation panes',
    });
    await expect(separator).toHaveAttribute('aria-valuenow', '60');

    const splitBox = await split.boundingBox();
    const separatorBox = await separator.boundingBox();
    if (!splitBox || !separatorBox) throw new Error('split workspace is not measurable');
    await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + 4);
    await page.mouse.down();
    await page.mouse.move(separatorBox.x + separatorBox.width / 2, splitBox.y + 2);
    await page.mouse.up();
    await expect(split).toHaveAttribute('data-state-collapsed', 'true');
    expect((await state.boundingBox())?.height ?? -1).toBe(0);
    expect((await conversation.boundingBox())?.height ?? 0).toBeGreaterThan(0);

    const collapsedSeparator = await separator.boundingBox();
    if (!collapsedSeparator) throw new Error('collapsed separator is not reachable');
    await page.mouse.move(
      collapsedSeparator.x + collapsedSeparator.width / 2,
      collapsedSeparator.y + 4,
    );
    await page.mouse.down();
    await page.mouse.move(
      collapsedSeparator.x + collapsedSeparator.width / 2,
      splitBox.y + splitBox.height - 2,
    );
    await page.mouse.up();
    await expect(split).toHaveAttribute('data-conversation-collapsed', 'true');
    expect((await state.boundingBox())?.height ?? 0).toBeGreaterThan(0);
    expect((await conversation.boundingBox())?.height ?? -1).toBe(0);

    await separator.dblclick();
    await expect(separator).toHaveAttribute('aria-valuenow', '60');
    const stateBox = await state.boundingBox();
    const conversationBox = await conversation.boundingBox();
    if (!stateBox || !conversationBox) throw new Error('reset panes are not measurable');
    expect(stateBox.y + stateBox.height).toBeLessThanOrEqual(conversationBox.y);
  });
});
