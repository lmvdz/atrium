import { describe, expect, it, vi } from 'vitest';
import {
  assertKnownRole,
  atriumOrganizationOptions,
  isDemotion,
  type OrganizationPorts,
} from '../src/org.js';

/**
 * The library-layer authorization, tested for what it decides.
 *
 * Round 1 shipped the policy in a Server Action only, so the same operation
 * performed through Better Auth's own API skipped it — a workspace admin could
 * mint an `owner` invitation. These tests call the hook the way Better Auth
 * calls it and assert the denial, which is the part that has to be true no
 * matter which caller gets there.
 */

const workspaceId = 'ws-1';

function ports(overrides: Partial<OrganizationPorts> = {}): OrganizationPorts {
  return {
    memberRole: async () => 'admin',
    createDefaultRoom: async () => undefined,
    joinWorkspaceRooms: async () => undefined,
    revokeWorkspaceRooms: async () => undefined,
    syncWorkspaceRoomRoles: async () => undefined,
    voidInvitation: async () => true,
    ...overrides,
  };
}

function options(overrides: Partial<OrganizationPorts> = {}) {
  return atriumOrganizationOptions({
    ports: ports(overrides),
    baseURL: 'https://atrium.test',
    mailer: async () => {},
    schema: {},
  });
}

function invitation(role: string, inviterId = 'user-admin') {
  return {
    invitation: { email: 'grace@example.com', role, organizationId: workspaceId, inviterId },
    inviter: { id: inviterId },
    organization: { id: workspaceId },
  };
}

describe('beforeCreateInvitation — the escalation guard', () => {
  it('refuses an admin who tries to invite an owner', async () => {
    const hooks = options({ memberRole: async () => 'admin' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('owner'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('lets an owner invite an owner', async () => {
    const hooks = options({ memberRole: async () => 'owner' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('owner'))).resolves.toBeUndefined();
  });

  it('lets an admin invite an admin or a member', async () => {
    const hooks = options({ memberRole: async () => 'admin' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.beforeCreateInvitation(invitation('member'))).resolves.toBeUndefined();
  });

  it('refuses a plain member outright — inviting is an admin verb', async () => {
    const hooks = options({ memberRole: async () => 'member' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('member'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('refuses somebody who is not a member of the workspace at all', async () => {
    const hooks = options({ memberRole: async () => null }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('member'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('reads the inviter’s role from the database, not from the request', async () => {
    // The inviter id in the body is attacker-controlled in the general case;
    // what matters is that the role comes from a lookup keyed by the session's
    // user, which is what Better Auth passes as `inviter`.
    const memberRole = vi.fn(async () => 'member');
    const hooks = options({ memberRole }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('owner', 'user-x'))).rejects.toThrow();
    expect(memberRole).toHaveBeenCalledWith({ workspaceId, userId: 'user-x' });
  });

  it('refuses a role string it cannot read at all', async () => {
    const hooks = options({ memberRole: async () => 'owner' }).organizationHooks;
    for (const role of ['superuser', 'billing,admin', '', 'admin,owner,root']) {
      await expect(hooks.beforeCreateInvitation(invitation(role))).rejects.toMatchObject({
        status: 'BAD_REQUEST',
      });
    }
  });

  it('refuses an admin whose stored role carries an unknown component', async () => {
    // `"billing,admin"` must not read as admin on the granting side either.
    const hooks = options({ memberRole: async () => 'billing,admin' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('member'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });
});

describe('revocation hooks', () => {
  it('drops room membership before the workspace member row goes', async () => {
    const revokeWorkspaceRooms = vi.fn(async () => undefined);
    const hooks = options({ revokeWorkspaceRooms }).organizationHooks;

    await hooks.beforeRemoveMember({
      member: { userId: 'user-2', organizationId: workspaceId },
      organization: { id: workspaceId },
    });

    expect(revokeWorkspaceRooms).toHaveBeenCalledWith({ workspaceId, userId: 'user-2' });
  });

  it('sweeps again afterwards, so a join racing the removal does not survive it', async () => {
    const revokeWorkspaceRooms = vi.fn(async () => undefined);
    const hooks = options({ revokeWorkspaceRooms }).organizationHooks;

    await hooks.afterRemoveMember({
      member: { userId: 'user-2', organizationId: workspaceId },
      organization: { id: workspaceId },
    });

    expect(revokeWorkspaceRooms).toHaveBeenCalledTimes(1);
  });

  it('never turns a completed removal into an error when the second sweep fails', async () => {
    const hooks = options({
      revokeWorkspaceRooms: async () => {
        throw new Error('database is on fire');
      },
    }).organizationHooks;

    await expect(
      hooks.afterRemoveMember({
        member: { userId: 'user-2', organizationId: workspaceId },
        organization: { id: workspaceId },
      }),
    ).resolves.toBeUndefined();
  });

  it('lets a failed pre-removal revoke abort the removal', async () => {
    const hooks = options({
      revokeWorkspaceRooms: async () => {
        throw new Error('database is on fire');
      },
    }).organizationHooks;

    await expect(
      hooks.beforeRemoveMember({
        member: { userId: 'user-2', organizationId: workspaceId },
        organization: { id: workspaceId },
      }),
    ).rejects.toThrow(/on fire/);
  });

  it('follows a demotion down into the rooms, before the workspace role changes', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => 'admin',
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member: { userId: 'user-2', organizationId: workspaceId },
      newRole: 'member',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).toHaveBeenCalledWith({
      workspaceId,
      userId: 'user-2',
      role: 'member',
    });
  });

  it('refuses a role change to something it cannot read', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({ syncWorkspaceRoomRoles }).organizationHooks;

    await expect(
      hooks.beforeUpdateMemberRole({
        member: { userId: 'user-2', organizationId: workspaceId },
        newRole: 'root',
        organization: { id: workspaceId },
      }),
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' });
    expect(syncWorkspaceRoomRoles).not.toHaveBeenCalled();
  });
});

/**
 * Direction, which is the part round 2 got half right.
 *
 * Revoking early is correct: a crash between the two writes leaves somebody a
 * workspace member with no rooms, which is visible and repairable. Granting
 * early is the mirror image and is *not* correct — it hands out room authority
 * the workspace row does not yet carry, and leaves it handed out if the
 * library's write then fails.
 */
describe('role changes only move in the safe direction before the commit', () => {
  const member = { userId: 'user-2', organizationId: workspaceId };

  it('does not grant a promotion before Better Auth has committed it', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => 'member',
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member,
      newRole: 'admin',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).not.toHaveBeenCalled();
  });

  it('grants the promotion afterwards, on the value that landed', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({ syncWorkspaceRoomRoles }).organizationHooks;

    await hooks.afterUpdateMemberRole({
      member: { ...member, role: 'admin' },
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).toHaveBeenCalledWith({
      workspaceId,
      userId: 'user-2',
      role: 'admin',
    });
  });

  it('does nothing early for a role that is not changing', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => 'admin',
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member,
      newRole: 'admin',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).not.toHaveBeenCalled();
  });

  it('treats a promotion of somebody with no membership yet as a grant, not a revoke', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => null,
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member,
      newRole: 'owner',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).not.toHaveBeenCalled();
  });

  it('revokes early when the role it is moving *from* is unreadable', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => 'billing,admin',
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member,
      newRole: 'admin',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).toHaveBeenCalledWith({
      workspaceId,
      userId: 'user-2',
      role: 'admin',
    });
  });

  it('ranks the three roles the way the rest of the system does', () => {
    expect(isDemotion('owner', 'admin')).toBe(true);
    expect(isDemotion('admin', 'member')).toBe(true);
    expect(isDemotion('owner', 'member')).toBe(true);
    expect(isDemotion('member', 'admin')).toBe(false);
    expect(isDemotion('admin', 'admin')).toBe(false);
    expect(isDemotion(null, 'member')).toBe(false);
    expect(isDemotion('admin', 'root')).toBe(true);
  });
});

/**
 * The invitation race, made deterministic.
 *
 * `beforeCreateInvitation` reads the inviter's role; Better Auth then writes the
 * invitation. Between those two statements the inviter can be demoted or
 * removed, and round 2's code had nothing to say about it — the invitation
 * landed carrying authority its author no longer held.
 *
 * The port below is the race with the timing taken out: the first `memberRole`
 * call (the before-hook's) answers `admin`, every later call answers whatever
 * the demotion left. Running the two hooks in the order Better Auth runs them
 * then reproduces the race exactly, every time, with no sleeps.
 */
describe('afterCreateInvitation — the time-of-check/time-of-use compensation', () => {
  function racingPorts(after: string | null, overrides: Partial<OrganizationPorts> = {}) {
    let asked = 0;
    return ports({
      memberRole: async () => {
        asked += 1;
        return asked === 1 ? 'admin' : after;
      },
      ...overrides,
    });
  }

  function optionsWith(portsValue: OrganizationPorts) {
    return atriumOrganizationOptions({
      ports: portsValue,
      baseURL: 'https://atrium.test',
      mailer: async () => {},
      schema: {},
    });
  }

  const created = {
    invitation: { id: 'inv-1', role: 'admin', organizationId: workspaceId },
    inviter: { id: 'user-admin' },
    organization: { id: workspaceId },
  };

  it('voids an invitation whose inviter was demoted mid-flight', async () => {
    const voidInvitation = vi.fn(async () => true);
    const hooks = optionsWith(racingPorts('member', { voidInvitation })).organizationHooks;

    // The check the invitation was minted under: at this instant it passes.
    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();

    // …and by the time the row exists, they are a plain member.
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
    expect(voidInvitation).toHaveBeenCalledWith({ invitationId: 'inv-1', workspaceId });
  });

  it('voids one whose inviter was removed from the workspace entirely', async () => {
    const voidInvitation = vi.fn(async () => true);
    const hooks = optionsWith(racingPorts(null, { voidInvitation })).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
    expect(voidInvitation).toHaveBeenCalledTimes(1);
  });

  it('leaves an invitation alone when nothing changed underneath it', async () => {
    const voidInvitation = vi.fn(async () => true);
    const hooks = optionsWith(racingPorts('admin', { voidInvitation })).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).resolves.toBeUndefined();
    expect(voidInvitation).not.toHaveBeenCalled();
  });

  it('voids when the inviter is demoted below the role they handed out', async () => {
    // owner → admin is still an inviter, but not one who may mint an owner.
    const voidInvitation = vi.fn(async () => true);
    const hooks = optionsWith(
      ports({
        memberRole: (() => {
          let asked = 0;
          return async () => {
            asked += 1;
            return asked === 1 ? 'owner' : 'admin';
          };
        })(),
        voidInvitation,
      }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('owner'))).resolves.toBeUndefined();
    await expect(
      hooks.afterCreateInvitation({
        ...created,
        invitation: { ...created.invitation, role: 'owner' },
      }),
    ).rejects.toMatchObject({ status: 'FORBIDDEN' });
    expect(voidInvitation).toHaveBeenCalledTimes(1);
  });

  it('fails loudly rather than quietly when the compensation itself fails', async () => {
    const hooks = optionsWith(
      racingPorts('member', {
        voidInvitation: async () => {
          throw new Error('database is on fire');
        },
      }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('still refuses the request when the row had already moved out of pending', async () => {
    // Nothing to void — accepted a millisecond earlier, say. The caller is told
    // no either way; the log is what carries the difference.
    const hooks = optionsWith(
      racingPorts('member', { voidInvitation: async () => false }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });
});

describe('the options themselves', () => {
  it('makes invitation email verification explicit rather than inherited', () => {
    expect(options().requireEmailVerificationOnInvitation).toBe(true);
  });

  it('gives the workspace creator ownership and expires invitations', () => {
    expect(options().creatorRole).toBe('owner');
    expect(options().invitationExpiresIn).toBe(60 * 60 * 48);
    expect(options().cancelPendingInvitationsOnReInvite).toBe(true);
  });
});

describe('assertKnownRole', () => {
  it('accepts the three roles and nothing else', () => {
    expect(assertKnownRole('owner')).toBe('owner');
    expect(assertKnownRole('admin')).toBe('admin');
    expect(assertKnownRole('member')).toBe('member');
    expect(() => assertKnownRole('root')).toThrow();
    expect(() => assertKnownRole(['admin', 'billing'])).toThrow();
    expect(() => assertKnownRole(undefined)).toThrow();
    expect(() => assertKnownRole(42)).toThrow();
  });
});
