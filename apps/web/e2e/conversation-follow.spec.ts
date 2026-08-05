import { expect, test } from '@playwright/test';

test('the live edge follows a newly sent message in the rendered workspace', async ({ page }) => {
  /* 1124 was inside the supported range while the shell's floor was 1024; the
     floor is 1280 now, so this drove the frame at a width the product refuses
     in words and the composer was never reachable. The HEIGHT is the point of
     this check — 500px is what makes the feed overflow — and it is unchanged. */
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto('/');
  const feed = page.locator('[data-region="conversation"]');
  /* BY ROLE, NOT BY THE NAME THE BINDING GIVES IT. This read
     `getByRole('combobox', { name: /Message #/ })`, and the fixture route opens
     with the composer BOUND to an owed decision — so its accessible name is
     "Answer … in your own words" and the pattern never matched. Both of these
     checks have been red since they were written, which is why the previous
     session's evidence that follow works came from the authenticated two-account
     spec alone while the fixture pair covering the same behaviour was dark.
     There is exactly one combobox on this page; the check should say that
     rather than depend on which item the composer happens to be answering. */
  const composer = page.locator('textarea[role="combobox"]');
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
      return feed.evaluate((element, messageText) => {
        const row = [...element.children].find((child) => child.textContent?.includes(messageText));
        if (!(row instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
        const expected = Math.min(
          element.scrollHeight - element.clientHeight,
          Math.max(0, row.offsetTop),
        );
        return Math.abs(element.scrollTop - expected);
      }, 'browser follow probe');
    })
    .toBeLessThanOrEqual(2);
});

test('a paused conversation marks and counts the oldest unseen boundary', async ({ page }) => {
  /* 1124 was inside the supported range while the shell's floor was 1024; the
     floor is 1280 now, so this drove the frame at a width the product refuses
     in words and the composer was never reachable. The HEIGHT is the point of
     this check — 500px is what makes the feed overflow — and it is unchanged. */
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto('/');
  const feed = page.locator('[data-region="conversation"]');
  /* SCROLL AWAY ONLY ONCE THE FEED HAS TAKEN ITS OWN FIRST POSITION.
     This scrolled to 0 the moment the locator resolved, which is before the
     timeline's first-render effect runs. Recorded writes, three runs out of
     three: the spec wrote 0 at t=449 and `Timeline.useEffect` wrote
     `scrollHeight` at t=509 — the check's premise was erased 60ms after it was
     established, the reader was never paused, and the divider it waits for was
     correctly absent. Same class as the class-filter hydration race.
     Waiting for the pane to be AT the bottom waits on the product's own
     first-render branch rather than on a sleep. */
  await expect
    .poll(() =>
      feed.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThanOrEqual(12);
  await feed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  const composer = page.locator('textarea[role="combobox"]');
  await composer.fill('unseen boundary probe');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(feed.locator('[data-unread-divider="1"]')).toHaveText('1 new message');
  await expect(page.getByRole('button', { name: '↓ 1 new message' })).toBeVisible();
});
