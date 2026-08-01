import { describe, expect, it } from 'vitest';
import {
  authorize,
  commandPolicy,
  commandScope,
  isCommand,
  isRole,
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
  it('names only roles and scopes that exist', () => {
    for (const policy of Object.values(commandPolicy)) {
      expect(isRole(policy.role)).toBe(true);
      expect(['room', 'workspace']).toContain(policy.scope);
    }
  });

  it('is the single list of commands — nothing is authorized off-table', () => {
    // Deny-by-default only means something if the table is the whole protocol.
    // A new command must be added here, which is the review moment this exists for.
    expect(Object.keys(commandPolicy)).toContain('room.join');
    expect(Object.keys(commandPolicy).every((c) => isCommand(c))).toBe(true);
  });
});
