import { describe, expect, it, vi } from 'vitest';
import { assertKnownRole, atriumOrganizationOptions, type OrganizationPorts } from '../src/org.js';

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
    const hooks = options({ syncWorkspaceRoomRoles }).organizationHooks;

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
