import { authModelOptions, authTables, type Database, organizationSchemaOptions } from '@atrium/db';
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { consoleMailer, type Mailer } from './mailer.js';
import { resolveAuthSecret } from './secret.js';
import { createDefaultRoom, joinWorkspaceRooms } from './workspace.js';

/**
 * The one Better Auth configuration.
 *
 * Both processes that need to know who a request belongs to build their
 * instance from this function: the web app (route handlers, server components,
 * server actions) and the realtime server (the WebSocket upgrade). That is not
 * tidiness — a second configuration would be a second definition of a valid
 * session, and the two would eventually disagree about one.
 *
 * Nothing here is hand-rolled. No token format, no password hash, no cookie
 * signing, no invitation state machine (init.md forbids it, and issue #13
 * chose Better Auth precisely so we would not have to).
 */

export interface AtriumAuthOptions {
  /** The Drizzle handle from `createDatabase()`. */
  db: Database;
  /** Public origin of the web app, e.g. `http://localhost:3000`. */
  baseURL: string;
  /** Signing secret. Defaults to `resolveAuthSecret()` over `process.env`. */
  secret?: string;
  /** Transport for verification and invitation mail. Defaults to the console. */
  mailer?: Mailer;
  /** GitHub OAuth, when it is configured. Omitted entirely when it is not. */
  github?: { clientId: string; clientSecret: string };
  /**
   * Framework glue appended after the shared plugins — `nextCookies()` in the
   * web app, nothing in the realtime server. Must not add database models.
   */
  plugins?: BetterAuthPlugin[];
  /** Extra origins allowed to make credentialed calls (the realtime server). */
  trustedOrigins?: string[];
}

export type AtriumAuth = ReturnType<typeof createAtriumAuth>;

export function createAtriumAuth(options: AtriumAuthOptions) {
  const { db, baseURL } = options;
  const mailer = options.mailer ?? consoleMailer;
  const secret = options.secret ?? resolveAuthSecret();

  const config = {
    appName: 'atrium',
    baseURL,
    secret,
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),

    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: authTables,
      // One invitation acceptance writes an invitation row and a member row;
      // a half-accepted invitation is not a state this app knows how to be in.
      transaction: true,
    }),

    // Ids are real uuids so an auth row's primary key looks like every other
    // primary key in the schema and can be foreign-keyed at directly.
    advanced: { database: { generateId: 'uuid' } },

    // Better Auth's `user`/`organization` models are our `users`/`workspaces`.
    ...authModelOptions,

    emailAndPassword: {
      enabled: true,
      // No unverified session, ever: a signup that never checks its mail cannot
      // create a workspace or accept an invitation.
      requireEmailVerification: true,
      minPasswordLength: 12,
    },

    emailVerification: {
      sendOnSignUp: true,
      // Someone who lost the first email will try to sign in before they think
      // to hunt for a "resend" button. Meeting them there with a fresh link is
      // the difference between finishing signup and giving up.
      sendOnSignIn: true,
      // Verifying is the last step of signing up, not a detour before signing in.
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const link = withCallback(url, '/app');
        await mailer({
          kind: 'email-verification',
          to: user.email,
          subject: 'Confirm your email for Atrium',
          url: link,
          body: `Confirm ${user.email} to finish setting up Atrium: ${link}`,
        });
      },
    },

    ...(options.github
      ? {
          socialProviders: {
            github: {
              clientId: options.github.clientId,
              clientSecret: options.github.clientSecret,
            },
          },
        }
      : {}),

    plugins: [
      organization({
        schema: organizationSchemaOptions,
        // The person who creates a workspace owns it.
        creatorRole: 'owner',
        // A stale invitation is a smaller problem than an eternal one.
        invitationExpiresIn: 60 * 60 * 48,
        cancelPendingInvitationsOnReInvite: true,

        sendInvitationEmail: async ({ id, email, organization: workspace, inviter }) => {
          const link = new URL(`/invite/${id}`, baseURL).toString();
          await mailer({
            kind: 'workspace-invitation',
            to: email,
            subject: `${inviter.user.name} invited you to ${workspace.name} on Atrium`,
            url: link,
            body:
              `${inviter.user.name} (${inviter.user.email}) invited you to join ` +
              `the ${workspace.name} workspace: ${link}`,
          });
        },

        organizationHooks: {
          // A workspace with no room is a dead end for the person who just made
          // it, so the first room is part of creating one.
          afterCreateOrganization: async ({ organization: workspace, member }) => {
            await createDefaultRoom(db, {
              workspaceId: workspace.id,
              userId: member.userId,
              role: member.role,
            });
          },
          // Accepting an invitation has to land the invitee somewhere shared,
          // or "you're in the workspace" is a claim with nothing behind it.
          afterAcceptInvitation: async ({ organization: workspace, member }) => {
            await joinWorkspaceRooms(db, {
              workspaceId: workspace.id,
              userId: member.userId,
              role: member.role,
            });
          },
        },
      }),
      ...(options.plugins ?? []),
    ],
  } satisfies BetterAuthOptions;

  return betterAuth(config);
}

/**
 * Better Auth builds the verification URL with `callbackURL=/` by default. We
 * want the newly-verified user to land in the app rather than on the marketing
 * shell, and rewriting the query is safer than reconstructing the whole link.
 */
function withCallback(url: string, callbackPath: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('callbackURL', callbackPath);
    return parsed.toString();
  } catch {
    return url;
  }
}
