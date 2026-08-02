import { describe, expect, it } from 'vitest';
import {
  authorize,
  commandPolicy,
  commandScope,
  isCommand,
  mayGrantRole,
  parseRole,
  type Role,
  roleRank,
  roles,
} from '../src/authz.js';

const member = { role: 'member' };
const admin = { role: 'admin' };
const owner = { role: 'owner' };

describe('authorize — the denials', () => {
  it('denies a command it has never heard of', () => {
    const result = authorize('room.selfDestruct', owner);
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: 'unknown_command' });
  });

  it('denies a command with no membership at all', () => {
    expect(authorize('room.join', null).allowed).toBe(false);
    expect(authorize('room.join', undefined)).toMatchObject({ reason: 'not_a_member' });
  });

  it('denies a role it does not recognise instead of guessing', () => {
    expect(authorize('room.join', { role: 'superuser' })).toMatchObject({
      reason: 'unknown_role',
    });
    expect(authorize('room.join', { role: '' })).toMatchObject({ reason: 'unknown_role' });
  });

  it('denies a member the commands reserved for admins', () => {
    expect(authorize('workspace.invite', member)).toMatchObject({ reason: 'insufficient_role' });
    expect(authorize('room.archive', member)).toMatchObject({ reason: 'insufficient_role' });
  });

  it('denies an admin the commands reserved for the owner', () => {
    expect(authorize('workspace.delete', admin)).toMatchObject({ reason: 'insufficient_role' });
  });

  it('is case sensitive — "Admin" is not admin', () => {
    expect(authorize('workspace.invite', { role: 'Admin' })).toMatchObject({
      reason: 'unknown_role',
    });
  });

  it('cannot be tricked by a prototype key', () => {
    // `commandPolicy` is a plain object; "toString" and friends must not read as
    // commands just because Object.prototype has them.
    expect(authorize('toString', owner)).toMatchObject({ reason: 'unknown_command' });
    expect(authorize('constructor', owner)).toMatchObject({ reason: 'unknown_command' });
    expect(isCommand('hasOwnProperty')).toBe(false);
  });
});

describe('authorize — the grants', () => {
  it('lets a member do member things', () => {
    expect(authorize('room.join', member)).toEqual({
      allowed: true,
      command: 'room.join',
      role: 'member',
      scope: 'room',
    });
    expect(authorize('message.send', member).allowed).toBe(true);
  });

  it('lets higher roles do everything a lower role can', () => {
    /**
     * **Reads its expectation out of the table it is testing** — the round-11
     * codex critic's finding, and kept deliberately. As a *monotonicity* check
     * it is exactly right: whatever the table says, a higher role must be able
     * to do what a lower one can, and deriving the threshold from the table is
     * the only way to say that for every row at once.
     *
     * What it must not be mistaken for is a check that the thresholds are
     * correct. That one is `grants each command to exactly the roles the
     * protocol says` in "the policy table itself", against a literal list.
     */
    for (const command of Object.keys(commandPolicy)) {
      const required = commandPolicy[command as keyof typeof commandPolicy].role;
      const allowed: Role[] =
        required === 'member'
          ? ['member', 'admin', 'owner']
          : required === 'admin'
            ? ['admin', 'owner']
            : ['owner'];
      for (const role of roles) {
        expect(authorize(command, { role }).allowed, `${role} → ${command}`).toBe(
          allowed.includes(role),
        );
      }
    }
  });
});

describe('scope', () => {
  it('refuses a workspace command judged against room membership', () => {
    // The WebSocket only ever holds a room membership. Without this, an owner of
    // *a room* would pass the check for deleting the *workspace*.
    expect(authorize('workspace.delete', owner, { scope: 'room' })).toMatchObject({
      reason: 'wrong_scope',
    });
    expect(authorize('workspace.invite', admin, { scope: 'room' })).toMatchObject({
      reason: 'wrong_scope',
    });
  });

  it('refuses a room command judged against workspace membership', () => {
    expect(authorize('room.archive', owner, { scope: 'workspace' })).toMatchObject({
      reason: 'wrong_scope',
    });
  });

  it('allows a command whose scope matches, and is silent when no scope is given', () => {
    expect(authorize('room.join', member, { scope: 'room' }).allowed).toBe(true);
    expect(authorize('workspace.invite', admin, { scope: 'workspace' }).allowed).toBe(true);
    expect(authorize('workspace.invite', admin).allowed).toBe(true);
  });

  it('checks the scope before the role, so a mismatch never leaks a role verdict', () => {
    expect(authorize('workspace.delete', member, { scope: 'room' })).toMatchObject({
      reason: 'wrong_scope',
    });
  });

  it('reports the scope of every command', () => {
    expect(commandScope('room.join')).toBe('room');
    expect(commandScope('workspace.invite')).toBe('workspace');
  });
});

describe('parseRole', () => {
  it('reads better auth’s comma-separated multi-role value', () => {
    expect(parseRole('member,admin')).toBe('admin');
    expect(parseRole('admin, owner')).toBe('owner');
    expect(parseRole(' member ')).toBe('member');
  });

  it('rejects the whole value when any component is unrecognised', () => {
    // Round 1 of this ticket blessed exactly this input as `admin` — and had a
    // test saying so. It is the wrong reading: `"billing,admin"` was written by
    // something whose role vocabulary is not ours, and "the part I recognise"
    // is a guess about the part I do not.
    expect(parseRole('billing,admin')).toBeNull();
    expect(parseRole('admin,suspended')).toBeNull();
    expect(parseRole('owner,')).toBeNull();
    expect(parseRole('admin,,owner')).toBeNull();
  });

  it('returns null when nothing in the value is a known role', () => {
    expect(parseRole('billing,auditor')).toBeNull();
    expect(parseRole('')).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    expect(parseRole(null as unknown as string)).toBeNull();
    expect(parseRole(undefined as unknown as string)).toBeNull();
    expect(parseRole(['admin'] as unknown as string)).toBeNull();
  });
});

describe('authorize — strictness reaches the decision', () => {
  it('denies a membership whose role carries an unknown component', () => {
    // The gauntlet's point: `authorize` and the room-grant hook were reading
    // the same string in opposite directions. Both now refuse it.
    expect(authorize('room.join', { role: 'billing,admin' })).toMatchObject({
      reason: 'unknown_role',
    });
    expect(authorize('workspace.invite', { role: 'admin,superuser' })).toMatchObject({
      reason: 'unknown_role',
    });
  });
});

describe('mayGrantRole', () => {
  it('lets a role hand out itself and everything below it', () => {
    expect(mayGrantRole('owner', 'owner')).toBe(true);
    expect(mayGrantRole('owner', 'admin')).toBe(true);
    expect(mayGrantRole('admin', 'member')).toBe(true);
    expect(mayGrantRole('admin', 'admin')).toBe(true);
  });

  it('refuses to hand out authority the actor does not hold', () => {
    // The escalation both critics found: an admin inviting an owner.
    expect(mayGrantRole('admin', 'owner')).toBe(false);
    expect(mayGrantRole('member', 'admin')).toBe(false);
    expect(mayGrantRole('member', 'owner')).toBe(false);
  });

  it('refuses when either side is unreadable', () => {
    expect(mayGrantRole('', 'member')).toBe(false);
    expect(mayGrantRole('owner', 'superuser')).toBe(false);
    expect(mayGrantRole('billing,owner', 'member')).toBe(false);
    expect(mayGrantRole('owner', 'billing,member')).toBe(false);
  });
});

describe('roleRank', () => {
  it('orders the three roles', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('member'));
  });
});

describe('the policy table itself', () => {
  /**
   * The protocol, written out here rather than read out of the table.
   *
   * This list is the *second* statement of the same fact, and that is the whole
   * point: a test that derives its expectation from the thing it is testing
   * cannot fail. Adding a command means editing two files, which is the review
   * moment deny-by-default is supposed to create.
   */
  const protocol: Record<string, { scope: string; role: string }> = {
    'room.join': { scope: 'room', role: 'member' },
    'room.leave': { scope: 'room', role: 'member' },
    'room.presence': { scope: 'room', role: 'member' },
    'message.send': { scope: 'room', role: 'member' },
    'proposal.accept': { scope: 'room', role: 'member' },
    'proposal.reject': { scope: 'room', role: 'member' },
    'object.correct': { scope: 'room', role: 'member' },
    'room.rename': { scope: 'room', role: 'admin' },
    'room.archive': { scope: 'room', role: 'admin' },
    'workspace.read': { scope: 'workspace', role: 'member' },
    'room.create': { scope: 'workspace', role: 'member' },
    'workspace.invite': { scope: 'workspace', role: 'admin' },
    'workspace.invitation.revoke': { scope: 'workspace', role: 'admin' },
    'workspace.member.remove': { scope: 'workspace', role: 'admin' },
    'workspace.member.role': { scope: 'workspace', role: 'admin' },
    'workspace.update': { scope: 'workspace', role: 'admin' },
    'workspace.delete': { scope: 'workspace', role: 'owner' },
  };

  it('names only roles and scopes that exist', () => {
    // Against the literals, not against `isRole` — a predicate defined over the
    // same table cannot disagree with it.
    for (const policy of Object.values(commandPolicy)) {
      expect(['owner', 'admin', 'member']).toContain(policy.role);
      expect(['room', 'workspace']).toContain(policy.scope);
    }
    expect([...roles]).toEqual(['owner', 'admin', 'member']);
  });

  it('is the single list of commands — nothing is authorized off-table', () => {
    /**
     * **Round 11 rewrote this test, because the round-10 gauntlet proved it
     * passed for the wrong reason.** It used to assert
     * `Object.keys(commandPolicy).every(isCommand)` — and `isCommand` *is*
     * `Object.hasOwn(commandPolicy, value)`. That holds for every possible table
     * and every possible implementation: a definition restated in an
     * expectation. The critic proved it by replacing `isCommand` with
     * `typeof value === 'string'` and watching this test, alone, stay green.
     * `scripts/predicate-sweep.mjs` now runs exactly that stub against every
     * predicate in the package, and its receipt for `isCommand` names the two
     * tests that *do* notice — this one is no longer one of them by accident.
     *
     * The property is real and this is what it takes to assert it: the table's
     * keys are the protocol, spelled out independently above.
     */
    expect(commandPolicy).toEqual(protocol);
  });

  it('grants each command to exactly the roles the protocol says, from the list above', () => {
    /**
     * **The round-11 codex critic found the same tautology one test further
     * down**, and it was the more dangerous of the two. `authorize — the
     * grants > lets higher roles do everything a lower role can` reads
     * `commandPolicy[command].role` and builds its expectation from it, so
     * moving `room.rename` from `admin` to `member` leaves it green — and
     * nothing else in any of these files independently denies `room.rename` to
     * a member. A test that reads the table cannot notice the table changing.
     *
     * This asks the same question against the literal list above, so a policy
     * edit has to be made twice or the suite says so.
     */
    const rank: Record<string, number> = { member: 1, admin: 2, owner: 3 };
    for (const [command, expected] of Object.entries(protocol)) {
      for (const role of roles) {
        const allowed = rank[role] !== undefined && rank[role] >= (rank[expected.role] ?? 99);
        expect(authorize(command, { role }).allowed, `${role} → ${command}`).toBe(allowed);
      }
      expect(commandScope(command as keyof typeof commandPolicy), command).toBe(expected.scope);
    }
  });

  it('authorizes nothing outside that list, whatever the role', () => {
    // The claim stated as a decision rather than as a set: an owner is refused
    // every name the protocol does not contain, including the ones that look
    // like near-misses of real commands.
    for (const name of [
      'room.destroy',
      'Room.join',
      'room.join ',
      'workspace.member.promote',
      '__proto__',
      'toString',
      '',
    ]) {
      expect(authorize(name, owner), name).toMatchObject({ reason: 'unknown_command' });
      expect(isCommand(name), name).toBe(false);
    }
  });
});
