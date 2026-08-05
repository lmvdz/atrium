import { expect, test } from '@playwright/test';
import {
  createWorkspace,
  invite,
  newCallerContext,
  requireBrowser,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';

requireBrowser();

test('a reader follows another participant through the live projection refresh', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const senderContext = await newCallerContext(browser);
  const readerContext = await newCallerContext(browser);
  const sender = await senderContext.newPage();
  const reader = await readerContext.newPage();
  const senderEmail = uniqueEmail('follow-sender');
  const readerEmail = uniqueEmail('follow-reader');

  try {
    await signUpAndVerify(sender, { email: senderEmail, name: 'Follow sender' });
    const workspace = await createWorkspace(sender, 'Follow acceptance');
    const invitation = await invite(sender, {
      slug: workspace,
      email: readerEmail,
      role: 'member',
    });
    await signUpAndVerify(reader, { email: readerEmail, name: 'Follow reader' });
    await reader.goto(invitation);
    await reader.getByTestId('accept-invitation').click();
    await reader.waitForURL('**/app');

    await Promise.all([
      sender.goto(`/app/${workspace}/general`),
      reader.goto(`/app/${workspace}/general`),
    ]);
    await Promise.all([
      expect(sender.locator('[data-frame="live"]')).toBeVisible(),
      expect(reader.locator('[data-frame="live"]')).toBeVisible(),
    ]);
    const senderComposer = sender.getByRole('combobox', { name: 'Message #general' });
    const readerFeed = reader.locator('[data-region="conversation"]');

    for (let index = 0; index < 12; index += 1) {
      const body = `follow prelude ${index}`;
      await senderComposer.fill(body);
      await sender.getByRole('button', { name: 'Send' }).click();
      await expect(readerFeed).toContainText(body, { timeout: 20_000 });
    }
    await readerFeed.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });

    const marker = `live unread anchor ${Date.now()}`;
    const body = [marker, ...Array.from({ length: 18 }, (_, i) => `line ${i + 1}`)].join('\n');
    await senderComposer.fill(body);
    await sender.getByRole('button', { name: 'Send' }).click();
    const appended = readerFeed.locator('[data-message-id]').filter({ hasText: marker });
    await expect(appended).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        () =>
          readerFeed.evaluate((element, messageText) => {
            const row = [...element.children].find((child) =>
              child.textContent?.includes(messageText),
            );
            if (!(row instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
            const target = Math.min(
              element.scrollHeight - element.clientHeight,
              Math.max(0, row.offsetTop),
            );
            return Math.abs(element.scrollTop - target);
          }, marker),
        { timeout: 20_000 },
      )
      .toBeLessThanOrEqual(2);
  } finally {
    await Promise.all([senderContext.close(), readerContext.close()]);
  }
});
