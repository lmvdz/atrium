import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';
import { databaseUrl } from './support/config.mjs';
import {
  createWorkspace,
  invite,
  newCallerContext,
  requireBrowser,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';

/**
 * CERTIFY A `~` CLAIM AND REMOVE A `~` READING — on the REAL live route (#110).
 *
 * `claim` and `open_question` `autoAccept: true` (policy.ts), so a drafted one
 * lands as an accepted `~` reading with no proposal and no certify/reject button.
 * Before this, the live route had certify/reject for PROPOSALS only, and the
 * covenant's two acts on a `~` reading — a person promoting a claim to `✓
 * verified`, a person removing an accepted reading — were unreachable in the UI.
 *
 * This drives all three through the real WebSocket round-trip, on `/app`:
 *
 *   1. DISINTERESTED CERTIFY. Bob drafts a `~` claim; Alice — who is not its
 *      claimant and wrote none of its source — certifies it, and it becomes `✓`
 *      (the accepted object's `verification` is `verified` and a human has touched
 *      it). This is #102's second pair of eyes: whether an agent or a colleague
 *      drafted the claim is immaterial to the gate — what it turns on is that the
 *      certifier is disinterested, which is exactly what Alice→Bob's claim is.
 *
 *   2. SELF-VERIFICATION REFUSED. Alice drafts her own `~` claim; on it, her
 *      certify affordance is DISABLED and states why — the covenant, surfaced, not
 *      bypassed. The server refuses the same act, and remains the authority.
 *
 *   3. REMOVE A `~` OPEN_QUESTION. Alice removes a `~` open_question; it is
 *      retracted (withdrawn from current state, kept on the append-only record).
 *      An open_question is not "certified" — the scenario rejects it, and removal
 *      is that act.
 *
 * The agent-VIEWER gate (a machine never sees certify) and the model-drafted-claim
 * fidelity are proven at the layers that can flip the input cleanly:
 * `test/certify-remove.test.tsx` (viewer kind) and `test/replay-view.test.ts`
 * (a claim folded through @atrium/core as a model's `~` reading).
 */

const sql = postgres(databaseUrl);

/**
 * Send one plain message. The e2e server runs the deterministic acceptance
 * provider (`INTERPRET_PROVIDER=acceptance-deterministic`), which reads a
 * whole-line `Claim: …` / `Open question: …` body, stages the reading, and
 * auto-accepts it (claim/open_question, #4/#8) — so it lands as a `~` reading
 * exactly as a model-drafted one does, with the sender as claimant/source-author.
 */
async function sendLine(page: Page, body: string): Promise<void> {
  const composer = page.locator('textarea[role="combobox"]');
  await expect(composer).toBeEnabled();
  await composer.fill(body);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(composer).toHaveValue('');
}

/**
 * Draft a `~` reading, then leave one ordinary message after it. The receipt
 * window certifies a claim/open_question only when the window reaches PAST the
 * message it cites — otherwise the correction scan cannot say a later message
 * did not take it back (`receipt_not_certifiable`), and the auto-accept never
 * fires. A single trailing line is the smallest window that lets the covenant's
 * own gate conclude, so the reading reaches the accepted fold as `~`.
 */
async function draftReading(page: Page, line: string): Promise<void> {
  await sendLine(page, line);
  await sendLine(page, 'Noted — carrying on with the discussion.');
}

/** Poll until a drafted semantic reading reaches the accepted fold, and return its id. */
async function acceptedObjectId(
  roomId: string,
  type: 'claim' | 'open_question',
  statement: string,
): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        [id] = (
          await sql<{ id: string }[]>`
            SELECT id::text FROM accepted_objects
            WHERE room_id = ${roomId}::uuid
              AND type = ${type}
              AND retracted_at IS NULL
              AND COALESCE(payload->>'statement', payload->>'question') = ${statement}
          `
        ).map((row) => row.id);
        return id ?? null;
      },
      { timeout: 90_000, message: `${type} "${statement}" to reach the accepted fold` },
    )
    .not.toBeNull();
  if (!id) throw new Error(`${type} "${statement}" never reached the fold`);
  return id;
}

async function openReceipt(page: Page, objectId: string): Promise<void> {
  await page.reload();
  await expect(page.locator('[data-frame="live"]')).toBeVisible();
  const row = page.locator(`[data-object-id="${objectId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(`[data-receipt-id="${objectId}"]`)).toBeVisible();
}

test.describe('the live route can certify a `~` claim and remove a `~` reading', () => {
  requireBrowser();

  test.afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  test('a disinterested human certifies a `~` claim → ✓; the claimant is refused; a `~` open_question is removable', async ({
    browser,
  }) => {
    const aliceEmail = uniqueEmail('certify-alice');
    const bobEmail = uniqueEmail('certify-bob');
    const aliceCtx = await newCallerContext(browser);
    const bobCtx = await newCallerContext(browser);
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      // Two members of one room. Alice owns the workspace; Bob is invited in.
      await signUpAndVerify(alice, { email: aliceEmail, name: 'Alice' });
      const workspace = await createWorkspace(alice, `Certify ${Date.now().toString(36)}`);
      const invitation = await invite(alice, { slug: workspace, email: bobEmail, role: 'member' });
      await signUpAndVerify(bob, { email: bobEmail, name: 'Bob' });
      await bob.goto(invitation);
      await bob.getByTestId('accept-invitation').click();
      await bob.waitForURL('**/app');

      await alice.goto(`/app/${workspace}/general`);
      await bob.goto(`/app/${workspace}/general`);
      for (const page of [alice, bob]) {
        await expect(page.locator('[data-frame="live"]')).toBeVisible();
      }
      await expect(bob.locator('[data-presence="here"]')).toHaveCount(2);

      const roomId = await alice.locator('main[data-room-id]').getAttribute('data-room-id');
      if (!roomId) throw new Error('the live route did not expose its room id');

      // ── 1. Bob drafts a `~` claim; Alice, disinterested, certifies it ────────
      const bobClaim = 'Claim: The staging deploy came back green.';
      await draftReading(bob, bobClaim);
      const bobClaimId = await acceptedObjectId(roomId, 'claim', bobClaim);

      // it is a `~` reading: no human has certified it, nothing has verified it
      const [beforeRow] = await sql<{ verification: string; touched: string | null }[]>`
        SELECT payload->>'verification' AS verification,
               human_touched_at::text AS touched
        FROM accepted_objects WHERE id = ${bobClaimId}::uuid
      `;
      expect(beforeRow?.verification).toBe('unverified');
      expect(beforeRow?.touched).toBeNull();

      await openReceipt(alice, bobClaimId);
      // Alice is offered certify (she is disinterested), and it is a deliberate
      // two-stage act — the trigger arms a confirm, the confirm commits.
      const receipt = alice.locator(`[data-receipt-id="${bobClaimId}"]`);
      await expect(receipt.locator('[data-certify="refused"]')).toHaveCount(0);
      await receipt.locator('[data-certify="ready"]').click();
      await receipt.locator('[data-confirm-certify="true"]').click();

      // the covenant made tangible: a person put their name on the sentence, so
      // the reading is now `✓ verified` and a human has touched it.
      await expect
        .poll(
          async () =>
            (
              await sql<{ verification: string; touched: string | null }[]>`
                SELECT payload->>'verification' AS verification,
                       human_touched_at::text AS touched
                FROM accepted_objects WHERE id = ${bobClaimId}::uuid
              `
            )[0],
          { timeout: 30_000, message: 'the certified claim to reach verified' },
        )
        .toMatchObject({ verification: 'verified' });
      const [afterRow] = await sql<{ touched: string | null }[]>`
        SELECT human_touched_at::text AS touched FROM accepted_objects WHERE id = ${bobClaimId}::uuid
      `;
      expect(afterRow?.touched).not.toBeNull();

      // ── 2. Alice drafts her OWN `~` claim; self-verification is refused ──────
      const aliceClaim = 'Claim: The metrics dashboard stayed within limits overnight.';
      await draftReading(alice, aliceClaim);
      const aliceClaimId = await acceptedObjectId(roomId, 'claim', aliceClaim);

      await openReceipt(alice, aliceClaimId);
      const ownReceipt = alice.locator(`[data-receipt-id="${aliceClaimId}"]`);
      // no ready trigger — a disabled certify that says, in the covenant's words,
      // why the claimant may not vouch for their own claim.
      await expect(ownReceipt.locator('[data-certify="ready"]')).toHaveCount(0);
      const refused = ownReceipt.locator('[data-certify="refused"]');
      await expect(refused).toBeVisible();
      await expect(refused).toBeDisabled();
      await expect(ownReceipt.locator('[data-certify-refused="true"]')).toContainText(
        'second pair of eyes',
      );
      // and clicking the disabled affordance certifies nothing — it stays `~`.
      const [stillRow] = await sql<{ verification: string }[]>`
        SELECT payload->>'verification' AS verification
        FROM accepted_objects WHERE id = ${aliceClaimId}::uuid
      `;
      expect(stillRow?.verification).toBe('unverified');

      // ── 3. Alice removes a `~` open_question ────────────────────────────────
      const question = 'Open question: Should the release be held until Monday?';
      await draftReading(alice, question);
      const questionId = await acceptedObjectId(roomId, 'open_question', question);

      await openReceipt(alice, questionId);
      const questionReceipt = alice.locator(`[data-receipt-id="${questionId}"]`);
      await questionReceipt.locator('[data-remove="ready"]').click();
      await questionReceipt.locator('[data-confirm-remove="true"]').click();

      // retracted: withdrawn from current state, kept on the append-only record.
      await expect
        .poll(
          async () =>
            (
              await sql<{ retracted: string | null }[]>`
                SELECT retracted_at::text AS retracted
                FROM accepted_objects WHERE id = ${questionId}::uuid
              `
            )[0]?.retracted ?? null,
          { timeout: 30_000, message: 'the removed open_question to be retracted' },
        )
        .not.toBeNull();
      await expect(alice.locator(`[data-object-id="${questionId}"]`)).toHaveCount(0);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
