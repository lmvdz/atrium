'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * A SEEDED `ControlPlaneData` — the process tree's REAL substrate (#154).
 *
 * The tree lane (#154) binds `NavTree` to the shipped control-plane read model
 * (`lib/control-plane-data.ts`) and its derivations (`control/state.ts`), the
 * same shapes the plain `ProcessTree.tsx` renders. The live projection is loaded
 * server-side by `loadControlPlane` (server-only, one authenticated room); the
 * live-progress channel that streams it into the prototype is #159, out of this
 * lane's scope. So this module stands in for that projection with a SEEDED value
 * of the real type — every field is a `ControlAgentRow`/`ControlPlanRow`/
 * `ControlSessionRow` column, nothing invented — and `treeData()` in `seams.ts`
 * returns it. When #159 lands, the seam body swaps to the real load and this file
 * is deleted; `NavTree` never changes shape.
 *
 * ## WHY THESE EXACT VALUES
 *
 * The ids are the SAME ones the still-mock conversation/peripheral seams (#155/
 * #156) key their selection lookups on (`a-hexi`/`p-invoices`/`s-live`, …), so a
 * node selected in the bound tree still resolves its (mock) thread until those
 * lanes bind. The certified scout carries a WHOLE hold receipt — settled, an
 * artifact to sign, armer == certifier == the same human, a held duration that
 * agrees with the interval its stamps bracket — because `sessionCertified` fails
 * closed on any missing part, and the tree's `✓` is derived from it and from
 * nothing else. The three open sessions carry NO artifact, so the tree shows them
 * NO branch rather than fabricating one (the covenant's honesty, ticket #154).
 * ═════════════════════════════════════════════════════════════════════════ */

import type { ControlPlaneData } from '@/lib/control-plane-data';

/* The projection instant. `ageMin` on a session is `now − createdAt`, derived
   from this and the row's `createdAt` (the read model carries no age column), so
   it is a single stable reference across SSR and hydration — never `Date.now()`,
   which would tear between server and client. */
const NOW = '2026-08-15T12:00:00.000Z';

/** Minutes before {@link NOW}, as an ISO string — for readable `createdAt`s. */
function minutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

/**
 * A fresh copy of the seeded plane on every call, so a test may mutate a fixture
 * value (flip a `spentMicros`) and assert the rendered cell moves without leaking
 * into the next render.
 */
export function controlPlaneFixture(): ControlPlaneData {
  return {
    room: { id: 'r-billing-rewrite', name: 'billing-rewrite' },
    viewerId: 'u-you',
    updatedAt: NOW,
    decisions: [],
    unseen: [],
    unseenTotal: 0,
    agents: [
      {
        userId: 'a-hexi',
        name: 'hexi',
        host: 'mac-studio-01',
        harness: 'claude-code',
        model: 'opus-5',
        budgetLimitMicros: 5_000_000,
        plans: [
          {
            id: 'p-invoices',
            agentUserId: 'a-hexi',
            title: 'streaming invoice totals',
            status: 'open',
            budgetLimitMicros: 5_000_000,
            spentMicros: 780_000,
            rlimitSlice: 8,
            authorizedDraws: 3,
            refusedDraws: 0,
            sessions: [
              {
                id: 's-live',
                planId: 'p-invoices',
                harness: 'claude-code',
                model: 'opus-5',
                status: 'open',
                contextPct: 0.42,
                spendMicros: 660_000,
                exitSummary: null,
                artifact: null,
                artifactDigest: null,
                certifiedById: null,
                certifyArmedById: null,
                certifiedByName: null,
                certifiedByKind: null,
                certifiedAt: null,
                certifiedHeldMs: null,
                certifyArmedAt: null,
                certifyArmedByName: null,
                certifyArmedByKind: null,
                createdAt: minutesAgo(9),
                updatedAt: minutesAgo(0),
              },
              {
                /* THE ONE CERTIFIED SESSION — a WHOLE hold receipt, so
                   `sessionCertified` mints the tree's `✓`. Flip any part to null
                   and the tick drops to `~`, which is the derivation the badge is. */
                id: 's-scout',
                planId: 'p-invoices',
                harness: 'claude-code',
                model: 'sonnet-5',
                status: 'settled',
                contextPct: 0.18,
                spendMicros: 120_000,
                exitSummary: null,
                artifact: { branch: 'scout/invoice-schema', commit: 'abc1234' },
                artifactDigest: 'd41d8cd98f00b204e9800998ecf8427e',
                certifiedById: 'u-you',
                certifyArmedById: 'u-you',
                certifiedByName: 'you',
                certifiedByKind: 'human',
                certifiedAt: '2026-08-15T11:20:00.000Z',
                certifiedHeldMs: 2400,
                certifyArmedAt: '2026-08-15T11:19:57.600Z',
                certifyArmedByName: 'you',
                certifyArmedByKind: 'human',
                createdAt: minutesAgo(41),
                updatedAt: '2026-08-15T11:20:00.000Z',
              },
            ],
          },
        ],
      },
      {
        userId: 'a-mira',
        name: 'mira',
        host: 'linux-ci-07',
        harness: 'codex',
        model: 'gpt-5.6-sol',
        budgetLimitMicros: 3_000_000,
        plans: [
          {
            id: 'p-rank',
            agentUserId: 'a-mira',
            title: 're-rank on embeddings',
            status: 'open',
            budgetLimitMicros: 3_000_000,
            spentMicros: 2_910_000,
            rlimitSlice: 6,
            authorizedDraws: 6,
            refusedDraws: 0,
            sessions: [
              {
                id: 's-rank',
                planId: 'p-rank',
                harness: 'codex',
                model: 'gpt-5.6-sol',
                status: 'open',
                contextPct: 0.71,
                spendMicros: 2_910_000,
                exitSummary: null,
                artifact: null,
                artifactDigest: null,
                certifiedById: null,
                certifyArmedById: null,
                certifiedByName: null,
                certifiedByKind: null,
                certifiedAt: null,
                certifiedHeldMs: null,
                certifyArmedAt: null,
                certifyArmedByName: null,
                certifyArmedByKind: null,
                createdAt: minutesAgo(26),
                updatedAt: minutesAgo(0),
              },
            ],
          },
        ],
      },
      {
        userId: 'a-vale',
        name: 'vale',
        host: 'linux-ci-03',
        harness: 'grok',
        model: 'grok-4.6',
        budgetLimitMicros: null,
        plans: [
          {
            id: 'p-audit',
            agentUserId: 'a-vale',
            title: 'sweep env reads',
            status: 'open',
            budgetLimitMicros: null,
            spentMicros: 40_000,
            /* UNFUNDED — a null slice is a ceiling of zero (#118). `planCost`
               reads this as `unfunded`, and the chip wears the warn tone. */
            rlimitSlice: null,
            authorizedDraws: 1,
            refusedDraws: 0,
            sessions: [
              {
                id: 's-audit',
                planId: 'p-audit',
                harness: 'grok',
                model: 'grok-4.6',
                status: 'open',
                contextPct: 0.09,
                spendMicros: 40_000,
                exitSummary: null,
                artifact: null,
                artifactDigest: null,
                certifiedById: null,
                certifyArmedById: null,
                certifiedByName: null,
                certifiedByKind: null,
                certifiedAt: null,
                certifiedHeldMs: null,
                certifyArmedAt: null,
                certifyArmedByName: null,
                certifyArmedByKind: null,
                createdAt: minutesAgo(4),
                updatedAt: minutesAgo(0),
              },
            ],
          },
        ],
      },
    ],
  };
}
