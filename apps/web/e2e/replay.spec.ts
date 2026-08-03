import { expect, test } from '@playwright/test';
import postgres from 'postgres';
import type { AuditResult } from './audit';
import { AUDIT } from './audit';
import { databaseUrl } from './support/config.mjs';

async function replayDatabaseFingerprint(): Promise<string> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ digest: string }[]>`
      WITH target AS (
        SELECT r.id
        FROM rooms r
        JOIN workspaces w ON w.id = r.workspace_id
        WHERE w.slug = 'atrium-replay' AND r.slug = 'typescript-9998'
      )
      SELECT md5(concat_ws('|',
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id)::text, '[]') FROM core_events x WHERE x.room_id = (SELECT id FROM target)),
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.seq)::text, '[]') FROM messages x WHERE x.room_id = (SELECT id FROM target)),
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id)::text, '[]') FROM proposals x WHERE x.room_id = (SELECT id FROM target)),
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id)::text, '[]') FROM accepted_objects x WHERE x.room_id = (SELECT id FROM target)),
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id)::text, '[]') FROM relations x WHERE x.room_id = (SELECT id FROM target)),
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id)::text, '[]') FROM attention_items x WHERE x.room_id = (SELECT id FROM target)),
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id)::text, '[]') FROM corrections x WHERE x.room_id = (SELECT id FROM target)),
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.proposal_id, x.message_id)::text, '[]') FROM proposal_sources x WHERE x.room_id = (SELECT id FROM target)),
        (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.object_id, x.message_id)::text, '[]') FROM object_sources x WHERE x.room_id = (SELECT id FROM target))
      )) AS digest
    `;
    return row?.digest ?? '';
  } finally {
    await sql.end();
  }
}

async function replayDatabaseFacts() {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<
      Array<{
        messages: number;
        proposals: number;
        objects: number;
        stagedDecisions: number;
        answers: number;
        blockers: number;
        proposalSources: number;
        objectSources: number;
      }>
    >`
      WITH target AS (
        SELECT r.id
        FROM rooms r
        JOIN workspaces w ON w.id = r.workspace_id
        WHERE w.slug = 'atrium-replay' AND r.slug = 'typescript-9998'
      )
      SELECT
        (SELECT count(*)::int FROM messages WHERE room_id = (SELECT id FROM target)) AS messages,
        (SELECT count(*)::int FROM proposals WHERE room_id = (SELECT id FROM target)) AS proposals,
        (SELECT count(*)::int FROM accepted_objects WHERE room_id = (SELECT id FROM target)) AS objects,
        (SELECT count(*)::int FROM proposals WHERE room_id = (SELECT id FROM target) AND type = 'decision' AND status = 'proposed') AS "stagedDecisions",
        (SELECT count(*)::int FROM relations WHERE room_id = (SELECT id FROM target) AND kind = 'answers') AS answers,
        (SELECT count(*)::int FROM relations WHERE room_id = (SELECT id FROM target) AND kind = 'blocks') AS blockers,
        (SELECT count(*)::int FROM proposal_sources WHERE room_id = (SELECT id FROM target)) AS "proposalSources",
        (SELECT count(*)::int FROM object_sources WHERE room_id = (SELECT id FROM target)) AS "objectSources"
    `;
    return row;
  } finally {
    await sql.end();
  }
}

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
    expect(await replayDatabaseFacts()).toEqual({
      messages: 111,
      proposals: 4,
      objects: 0,
      stagedDecisions: 2,
      answers: 0,
      blockers: 0,
      proposalSources: 4,
      objectSources: 0,
    });
    await page.goto('/replay/atrium-replay/typescript-9998');

    await expect(page.getByText('1 room · 5 humans', { exact: true })).toBeVisible();
    const controls = page.getByRole('navigation', { name: 'Replay controls' });
    await expect(controls).toContainText('all 111 messages shown · machine read through 111');
    await expect(
      page.getByRole('heading', { name: 'function-call side effects', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'trade-offs in the control flow analysis work based on running the real-world code (RWC) tests',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Message #function-call side effects' }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    expect(
      await page.getByRole('textbox').evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return hit?.closest('[aria-label="Replay controls"]') === null;
      }),
      'the replay scrubber must not cover the composer',
    ).toBe(true);
    /**
     * Mutation: leave replay at scrollTop zero. The corpus's first, book-length
     * message then consumes the returning participant's entire reading surface
     * and buries the since-you-left boundary the replay exists to expose.
     */
    const feed = page.locator('[data-region="conversation"]');
    const divider = page.locator('[data-row="since-you-left"]');
    await expect
      .poll(() => feed.evaluate((element) => element.scrollTop), {
        message: 'the replay to orient at its return boundary',
      })
      .toBeGreaterThan(0);
    await expect(divider).toBeInViewport();
    /**
     * Mutation: return the transport to fixed positioning. It then covers the
     * feed/composer while the earlier hit-test samples only the textbox centre.
     */
    expect(await controls.evaluate((element) => getComputedStyle(element).position)).toBe(
      'relative',
    );

    const slider = page.getByRole('slider', { name: 'Replay position' });
    await slider.press('Home');
    await slider.press('ArrowRight');
    await slider.press('ArrowRight');
    await slider.press('ArrowRight');
    await expect(controls).toContainText('first 3 of 111 shown');
    await expect(page.locator('[data-region="conversation"] [data-message-id]')).toHaveCount(3);
    await expect(
      page.getByText(
        'trade-offs in the control flow analysis work based on running the real-world code (RWC) tests',
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
    await page.goto('/replay/atrium-replay/typescript-9998');

    const divider = page.locator('[data-row="since-you-left"]');
    for (const attentionClass of ['need', 'change', 'discussion', 'routine'] as const) {
      const chip = divider.locator(`[data-count-class="${attentionClass}"]`);
      const label = (await chip.textContent())?.trim() ?? '';
      const count = Number.parseInt(label, 10);
      if (count === 0) {
        await expect(chip).toBeDisabled();
        continue;
      }

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
   * be observed together through the product surfaces. Mutation: omit the
   * focus handoff when Accept or Retype removes its own button; keyboard focus
   * then falls back to the document body.
   */
  test('corrects a sourced decision reading without mutating the persisted replay', async ({
    page,
  }) => {
    const before = await replayDatabaseFingerprint();
    const decision = 'will instead be using a function to obtain the current token';
    await page.goto('/replay/atrium-replay/typescript-9998');

    const receipt = page.getByRole('region', { name: 'Receipt' });
    await page
      .locator('[data-region="current-state"] [data-object-id]')
      .filter({ hasText: decision })
      .click();
    await expect(receipt).toContainText('DECISION');
    await expect(receipt).toContainText('proposed');
    await receipt.getByRole('button', { name: 'Accept reading', exact: true }).click();
    await expect(receipt).toContainText('accepted');
    await expect(receipt).toBeFocused();

    await receipt.getByRole('button', { name: 'Retype as claim', exact: true }).click();
    await expect(receipt).toContainText('CORRECTED · DECISION → CLAIM');
    await expect(receipt).toBeFocused();
    await expect(receipt).toContainText('the reading was retyped; its source remains attached');
    await expect(receipt.getByRole('button', { name: 'Retype as claim' })).toHaveCount(0);

    await receipt.getByRole('button', { name: '← BACK TO CURRENT STATE' }).click();
    const accepted = page
      .locator('[data-region="current-state"] [data-object-id]')
      .filter({ hasText: decision });
    await expect(accepted).toContainText('~');
    await expect(accepted).toContainText('claim truth remains unverified');

    const slider = page.getByRole('slider', { name: 'Replay position' });
    await slider.press('Home');
    await slider.press('End');
    await expect(page.getByText(decision, { exact: true })).toContainText(decision);
    expect(await replayDatabaseFingerprint()).toBe(before);
  });

  /**
   * Mutation: reopen a decision even though core refuses that operation, erase
   * the question's answer relation, or reset the status without retaining the
   * answer's cited message. The only legal Reopen control or its prior-answer
   * quotation disappears from this flow. Mutation: remove the composer/receipt
   * focus handoff after Answer or Reopen and strand the keyboard on the body.
   */
  test('reopens an answered question while preserving its prior answer', async ({ page }) => {
    const before = await replayDatabaseFingerprint();
    const question = 'any plan to improve the developer experience on this subject?';
    const firstAnswer = 'Keep the optimistic assumption, but suppress narrowing through a getter.';
    await page.goto('/replay/atrium-replay/typescript-9998');

    const questionRow = page
      .locator('[data-region="current-state"] [data-object-id]')
      .filter({ hasText: question });
    await questionRow.click();
    const receipt = page.getByRole('region', { name: 'Receipt' });
    await expect(receipt).toContainText('open');
    await receipt.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: `Answer ${question} in your own words` }),
    ).toBeFocused();
    await page
      .getByRole('textbox', { name: `Answer ${question} in your own words` })
      .fill(firstAnswer);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(receipt.locator('[data-quoted]').filter({ hasText: firstAnswer })).toHaveCount(1);
    await expect(receipt.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
    await receipt.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(receipt).toBeFocused();
    await expect(receipt).toContainText('REOPENED · PRIOR ANSWER KEPT');
    await expect(receipt).toContainText('pending again');
    await expect(receipt.locator('[data-quoted]').filter({ hasText: firstAnswer })).toHaveCount(1);
    await expect(receipt.getByRole('button', { name: 'Reopen', exact: true })).toHaveCount(0);
    const restored = page.locator('[data-attention-id]').filter({ hasText: question });
    await expect(restored).toContainText('?');
    await expect(restored.getByRole('button', { name: 'answer', exact: true })).toBeVisible();

    const priorAnswerSource = receipt.getByRole('button').filter({ hasText: firstAnswer });
    const messageId = await priorAnswerSource.getAttribute('data-jumps-to');
    expect(messageId).toBeTruthy();
    await priorAnswerSource.click();
    await expect(page.locator(`[data-message-id="${messageId}"]`)).toBeInViewport();
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-message-id')),
      'a provenance jump must leave keyboard focus on its source row',
    ).toBe(messageId);

    const secondAnswer =
      'Retain optimistic narrowing and use an accessor where mutation is expected.';
    await restored.getByRole('button', { name: 'answer', exact: true }).click();
    await page
      .getByRole('textbox', { name: `Answer ${question} in your own words` })
      .fill(secondAnswer);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(restored.getByRole('button', { name: 'answer', exact: true })).toHaveCount(0);
    await expect(receipt.locator('[data-quoted]').filter({ hasText: secondAnswer })).toHaveCount(1);
    await expect(receipt.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
    await receipt.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(page.locator('[data-attention-id]').filter({ hasText: question })).toContainText(
      '?',
    );
    await expect(receipt.getByRole('button', { name: 'Reopen', exact: true })).toHaveCount(0);
    await receipt.getByRole('button', { name: '← BACK TO CURRENT STATE' }).click();
    const reopenedAgain = page
      .locator('[data-region="current-state"] [data-object-id]')
      .filter({ hasText: question });
    await expect(reopenedAgain).toContainText('?');
    expect(await replayDatabaseFingerprint()).toBe(before);
  });

  for (const theme of ['light', 'dark'] as const) {
    /**
     * Mutation: let replay-only controls or persisted semantic text bypass the
     * shared token contrast gate. Gallery still passes while the real replay
     * route reports the offending rendered strings.
     */
    test(`passes the rendered contrast spot-check in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/replay/atrium-replay/typescript-9998?theme=${theme}`);
      await expect(page.locator('[data-region="needs-you"]')).toBeVisible();
      const audit = (await page.evaluate(AUDIT)) as AuditResult;
      expect(audit.elementsChecked).toBeGreaterThan(120);
      expect(audit.fontFailures, 'replay text below the 10px floor').toEqual([]);
      expect(audit.contrastFailures, 'replay text below AA').toEqual([]);
      expect(audit.graphicFailures, 'replay state graphic below 3:1').toEqual([]);
    });
  }

  /**
   * Mutation: scope the reduced-motion kill switch to gallery components and
   * leave the replay scrubber or route transitions live. The real persisted
   * route reports a non-zero duration under the user preference.
   */
  test('honours reduced motion on the persisted replay route', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/replay/atrium-replay/typescript-9998?theme=light');
    const motion = await page.evaluate(() => {
      const animations: string[] = [];
      const transitions: string[] = [];
      for (const element of document.querySelectorAll('body *')) {
        const style = getComputedStyle(element);
        if (style.animationName !== 'none') animations.push(style.animationName);
        if (
          style.transitionDuration.split(',').some((duration) => Number.parseFloat(duration) > 0)
        ) {
          transitions.push(`${style.transitionProperty} ${style.transitionDuration}`);
        }
      }
      return { animations, transitions };
    });
    expect(motion.animations).toEqual([]);
    expect(motion.transitions).toEqual([]);
    await context.close();

    const ordinary = await browser.newContext({ reducedMotion: 'no-preference' });
    const ordinaryPage = await ordinary.newPage();
    await ordinaryPage.goto('/replay/atrium-replay/typescript-9998?theme=light');
    const liveTransitions = await ordinaryPage.evaluate(
      () =>
        [...document.querySelectorAll('body *')].filter((element) =>
          getComputedStyle(element)
            .transitionDuration.split(',')
            .some((duration) => Number.parseFloat(duration) > 0),
        ).length,
    );
    expect(
      liveTransitions,
      'replay has no transitions for the preference to suppress',
    ).toBeGreaterThan(0);
    await ordinary.close();
  });
});
