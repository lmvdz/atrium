import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { authorize } from '../src/authz.js';
import { effectiveRoomRole } from '../src/room-access.js';

/**
 * The half of room authorization a stub can settle: the role ceiling, and the
 * claim that nothing outside this package still asks the derived table.
 *
 * The other half — that the SQL really refuses a room row whose member row is
 * gone — is not decidable here, because the mechanism is a join and the only
 * honest test of a join is a database. That lives in
 * `apps/web/e2e/room-access.spec.ts`, against real Postgres, calling these same
 * exported functions.
 */

describe('effectiveRoomRole', () => {
  it('denies when the join matched nothing', () => {
    // Catches: `effectiveRoomRole` treating a missing row as anything but a
    // denial — the entire fix rests on "no member row, no authority".
    expect(effectiveRoomRole(undefined)).toBeNull();
    expect(effectiveRoomRole(null)).toBeNull();
  });

  it('passes the role through when both tables agree', () => {
    // The positive control. Without it, `return null` passes every other test
    // in this file — which is exactly the shape a denial-only suite rewards.
    expect(effectiveRoomRole({ role: 'owner', workspaceRole: 'owner' })).toBe('owner');
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'admin' })).toBe('admin');
    expect(effectiveRoomRole({ role: 'member', workspaceRole: 'member' })).toBe('member');
  });

  it('caps a stale elevated room role at the committed workspace role', () => {
    /**
     * The demotion whose propagation failed: `syncWorkspaceRoomRoles` timed out
     * on the member lock, so `memberships.role` still says admin while
     * `workspace_members.role` says member.
     *
     * Catches: returning `row.role` instead of the lower of the two — which is
     * what every version of this read did through round 5, and what would let
     * `room.rename` / `room.archive` through for a demoted member.
     */
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'member' })).toBe('member');
    expect(effectiveRoomRole({ role: 'owner', workspaceRole: 'member' })).toBe('member');
    expect(effectiveRoomRole({ role: 'owner', workspaceRole: 'admin' })).toBe('admin');
  });

  it('does not raise a room role to meet a higher workspace role', () => {
    // The ceiling is a ceiling, not an assignment. A promotion whose room rows
    // have not been reconciled yet stays at the room role; `afterUpdateMemberRole`
    // is what raises it, after the write it depends on has committed.
    // Catches: replacing `lowerOf` with "prefer the workspace role".
    expect(effectiveRoomRole({ role: 'member', workspaceRole: 'owner' })).toBe('member');
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'owner' })).toBe('admin');
  });

  it('denies, and says so, when either role is unreadable', () => {
    /**
     * Both directions, because `lowerOf` returns the *string* it could not
     * parse and the denial depends on `parseRole` then refusing it.
     *
     * Catches: a version that falls back to the readable side, which is the
     * `parseRole(role) ?? 'member'` failure `roomRole` already has a paragraph
     * about — the exact string `authorize()` refuses becomes a working grant.
     */
    const logger = { warn: vi.fn() };
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'billing,admin' }, logger)).toBeNull();
    expect(effectiveRoomRole({ role: 'superuser', workspaceRole: 'owner' }, logger)).toBeNull();
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: '' }, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({ unknownRole: true });
  });

  it('reads a list of known roles as its strongest member, and still caps', () => {
    /**
     * Recording measured behaviour, because the first draft of the test above
     * asserted the opposite of it.
     *
     * `workspace_members.role` is free text and Better Auth writes multi-role
     * values comma-separated. `parseRole` is strict about *unknown* components
     * — `billing,admin` is null, above — but a list whose every component is a
     * role we know resolves to the strongest one, so `admin,member` is `admin`.
     * That is `parseRole`'s documented contract; `assertKnownRole`'s prose in
     * `org.ts` claims lists are rejected outright and is wrong about this case.
     * Noted rather than changed: tightening it belongs with the code that
     * writes roles, not with the code that reads them.
     *
     * The ceiling is unaffected either way, which is what this asserts.
     */
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'admin,member' })).toBe('admin');
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'member,owner' })).toBe('admin');
    expect(effectiveRoomRole({ role: 'owner', workspaceRole: 'member,admin' })).toBe('admin');
  });

  it('produces a role `authorize` refuses admin commands for after a demotion', () => {
    /**
     * The ceiling wired to the thing it protects, rather than asserted in
     * isolation. `room.archive` is an admin command; a member may not run it.
     *
     * Catches: any regression in the ceiling that a `toBe('member')` assertion
     * would still pass — this one fails at the decision, which is where it
     * matters.
     */
    const role = effectiveRoomRole({ role: 'admin', workspaceRole: 'member' });
    const decision = authorize('room.archive', role === null ? null : { role }, { scope: 'room' });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('insufficient_role');

    // …and still allows what a member may do, so the denial above is about the
    // role and not about the command never being allowed.
    expect(
      authorize('message.send', role === null ? null : { role }, { scope: 'room' }).allowed,
    ).toBe(true);
  });
});

/**
 * Structural invariant: the apps do not query room membership themselves.
 *
 * Rounds 2–5 fixed five propagation paths and the class stayed open because the
 * authorization *read* was written out in the two apps. The read now lives in
 * `room-access.ts` alone. This asserts that it stays that way — a fourth query
 * added to a page or a handler is how the join gets forgotten again, and it is
 * an easy thing to do by accident and a hard thing to see in review.
 *
 * Deliberately scoped to `import` statements rather than to prose: several files
 * legitimately *discuss* `memberships` in a comment, and a test that fails on a
 * paragraph teaches people to delete paragraphs.
 */
describe('room membership is not queried outside @atrium/auth', () => {
  const appsRoot = fileURLToPath(new URL('../../../apps', import.meta.url));

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Tests and e2e specs are allowed to touch the tables directly: that is
        // how they arrange the "cleanup failed" state they then measure.
        if (['node_modules', '.next', 'dist', 'test', 'e2e'].includes(entry.name)) continue;
        out.push(...sourceFiles(path));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(path);
      }
    }
    return out;
  }

  it('finds no app file importing `memberships` from @atrium/db', () => {
    /**
     * Catches: reinstating the round-5 shape — `apps/web/lib/workspaces.ts` or
     * `apps/server/src/index.ts` selecting from `memberships` on their own, with
     * or without the join. Verified against the round-5 tree, where it names
     * both files.
     */
    const offenders = sourceFiles(appsRoot).filter((file) => {
      const source = readFileSync(file, 'utf8');
      // The whole import statement, so a `memberships` mentioned in a comment
      // three lines above an unrelated import does not count.
      const imports = source.match(/import\s*{[^}]*}\s*from\s*'@atrium\/db'/gs) ?? [];
      return imports.some((statement) => /\bmemberships\b/.test(statement));
    });

    expect(
      offenders.map((file) => file.slice(appsRoot.length + 1)),
      'an app is querying room membership directly; the joined read is in @atrium/auth',
    ).toEqual([]);
  });

  it('is looking at the right tree', () => {
    // The premise, measured. A `sourceFiles` that silently returns nothing —
    // wrong root, an exclusion that swallowed everything — would make the test
    // above pass by scanning zero files, which is the way this kind of guard
    // usually dies.
    const files = sourceFiles(appsRoot);
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith('lib/workspaces.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('server/src/index.ts'))).toBe(true);
  });
});
