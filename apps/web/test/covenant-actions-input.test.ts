import { describe, expect, it } from 'vitest';
import { CertifyObjectSpanInput } from '@/app/app/[workspace]/[room]/control/covenant-actions-input';

/* ═══════════════════════════════════════════════════════════════════════════
 * P6F-2 / #196 — the certify request schema REFUSES resolution-bearing fields.
 *
 * The gauntlet LOW: a non-strict `z.object` SILENTLY STRIPS unknown keys, so a
 * client that supplies a `renderedDigest` / `stateVector` / `relStart` (all of
 * which the covenant derives SERVER-SIDE) parses as valid and the client cannot
 * tell its smuggled field was ignored. The covenant's promise is REFUSAL, not
 * laundering — `.strict()` rejects the request outright, so the action returns
 * `derive_failed` rather than proceeding on a stripped payload.
 * ═════════════════════════════════════════════════════════════════════════ */

const VALID = {
  workspaceSlug: 'ws',
  roomSlug: 'room',
  objectId: '00000000-0000-4000-8000-000000000000',
  bodyPath: [0, 0],
  start: 0,
  end: 4,
} as const;

describe('CertifyObjectSpanInput refuses resolution-bearing fields (strict)', () => {
  it('accepts a well-formed WHICH-object + WHICH-span request', () => {
    expect(CertifyObjectSpanInput.safeParse(VALID).success).toBe(true);
  });

  it.each(['renderedDigest', 'stateVector', 'deleteSet', 'relStart', 'relEnd', 'certifier', 'principalKind'])(
    'REFUSES a request carrying a supplied resolution field: %s (not silently stripped)',
    (field) => {
      const parsed = CertifyObjectSpanInput.safeParse({ ...VALID, [field]: 'attacker-supplied' });
      // FLIP: a non-strict schema would return success:true with the field stripped —
      // the exact defect. Strict rejects it, so the action fails closed (derive_failed).
      expect(parsed.success).toBe(false);
    },
  );

  it('REFUSES any unknown key, not just a known-dangerous name (allowlist, not denylist)', () => {
    expect(CertifyObjectSpanInput.safeParse({ ...VALID, somethingNew: 1 }).success).toBe(false);
  });
});
