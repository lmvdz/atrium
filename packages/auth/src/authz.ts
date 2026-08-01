/**
 * Authorization. One function, deny by default.
 *
 * Every command that crosses a trust boundary — a WebSocket frame, a server
 * action, a route handler — passes through `authorize()`. There is deliberately
 * no second place to ask "is this allowed?", because two places is how the two
 * answers drift apart.
 *
 * The rules:
 *  - An unknown command is denied. Adding a command to the protocol without
 *    adding it to `commandPolicy` fails closed, loudly, in the caller's face.
 *  - An unknown role is denied. `role` arrives as free text from the database
 *    (Better Auth's organization plugin stores a comma-separated list), so it is
 *    parsed, not trusted.
 *  - No membership is denied. Being signed in is not being allowed in.
 *
 * Most of the commands below are stubs whose handlers land with the realtime
 * protocol (#22) and the semantic layer (#16). They are listed now on purpose:
 * the policy table is the specification, and a handler that forgets to call
 * `authorize` is a much easier review catch than a policy that was never written.
 */

/** The three roles Better Auth's organization plugin assigns. */
export const roles = ['owner', 'admin', 'member'] as const;
export type Role = (typeof roles)[number];

/** Higher wins. `owner` is `admin` plus the things you cannot delegate. */
const rank: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (roles as readonly string[]).includes(value);
}

/**
 * Which membership a command is judged against. A room command is checked
 * against a `memberships` row, a workspace command against a
 * `workspace_members` row. They are the same shape, so getting them the wrong
 * way round would type-check and quietly authorize the wrong thing — declaring
 * the scope here lets `authorize` refuse the mix-up instead.
 */
export type Scope = 'room' | 'workspace';

export interface Policy {
  scope: Scope;
  role: Role;
}

/** The scope and minimum role of every command Atrium will accept. */
export const commandPolicy = {
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
} as const satisfies Record<string, Policy>;

export type Command = keyof typeof commandPolicy;

export function isCommand(value: unknown): value is Command {
  return typeof value === 'string' && Object.hasOwn(commandPolicy, value);
}

/** The shape `authorize` needs. A `workspace_members` or `memberships` row fits. */
export interface MembershipLike {
  role: string;
}

export type DenialReason =
  | 'unknown_command'
  | 'wrong_scope'
  | 'not_a_member'
  | 'unknown_role'
  | 'insufficient_role';

export type AuthorizationResult =
  | { allowed: true; command: Command; role: Role; scope: Scope }
  | { allowed: false; reason: DenialReason; message: string };

export interface AuthorizeOptions {
  /**
   * The kind of membership the caller is handing in. Set it whenever you know —
   * a transport that only carries room commands (the WebSocket) says `'room'`
   * and gets workspace commands rejected for free.
   */
  scope?: Scope;
}

/**
 * Decide whether `membership` may run `command`.
 *
 * @param command    the command name off the wire — untrusted, validated here.
 * @param membership the caller's membership row, or null/undefined if they have
 *                   none. Null is a denial, never a fallthrough.
 * @param options    optionally, the scope of the membership being supplied.
 */
export function authorize(
  command: string,
  membership: MembershipLike | null | undefined,
  options: AuthorizeOptions = {},
): AuthorizationResult {
  if (!isCommand(command)) {
    return {
      allowed: false,
      reason: 'unknown_command',
      message: `unknown command "${command}"`,
    };
  }

  const policy: Policy = commandPolicy[command];

  if (options.scope && options.scope !== policy.scope) {
    return {
      allowed: false,
      reason: 'wrong_scope',
      message: `"${command}" is a ${policy.scope} command, judged against ${options.scope} membership`,
    };
  }

  if (!membership) {
    return {
      allowed: false,
      reason: 'not_a_member',
      message: `"${command}" requires membership`,
    };
  }

  const role = parseRole(membership.role);
  if (!role) {
    return {
      allowed: false,
      reason: 'unknown_role',
      message: `unrecognised role "${membership.role}"`,
    };
  }

  if (rank[role] < rank[policy.role]) {
    return {
      allowed: false,
      reason: 'insufficient_role',
      message: `"${command}" requires ${policy.role}, caller is ${role}`,
    };
  }

  return { allowed: true, command, role, scope: policy.scope };
}

/** The scope a command is judged in. Throws on an unknown command, by design. */
export function commandScope(command: Command): Scope {
  return commandPolicy[command].scope;
}

/**
 * Better Auth stores multiple roles as `"admin,member"`. Take the strongest one
 * we recognise and ignore the rest; return null if we recognise none, so an
 * unfamiliar role can never be mistaken for a familiar one.
 */
export function parseRole(raw: string): Role | null {
  let best: Role | null = null;
  for (const part of raw.split(',')) {
    const candidate = part.trim();
    if (!isRole(candidate)) continue;
    if (best === null || rank[candidate] > rank[best]) best = candidate;
  }
  return best;
}
