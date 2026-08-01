import { authModelOptions, authTables, type Database, organizationSchemaOptions } from '@atrium/db';
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { forwardedHeaderNames } from './client-ip.js';
import { type Mailer, resolveMailer } from './mailer.js';
import {
  atriumOrganizationOptions,
  type OrganizationLogger,
  type OrganizationPorts,
} from './org.js';
import { resolveAuthSecret } from './secret.js';
import {
  createDefaultRoom,
  joinWorkspaceRooms,
  loadWorkspaceMemberRole,
  revokeWorkspaceRooms,
  syncWorkspaceRoomRoles,
} from './workspace.js';

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
  /**
   * Transport for verification and invitation mail. Omitted, the console
   * transport is used — and `resolveMailer` refuses to boot in production
   * without a real one rather than printing links into a log.
   */
  mailer?: Mailer;
  /** GitHub OAuth, when it is configured. Omitted entirely when it is not. */
  github?: { clientId: string; clientSecret: string };
  /**
   * Framework glue appended after the shared plugins — `nextCookies()` in the
   * web app, nothing in the realtime server. Must not add database models.
   */
  plugins?: BetterAuthPlugin[];
  /**
   * Origins allowed to make credentialed calls. `baseURL` is always trusted;
   * both processes pass their configured `APP_URL` explicitly so neither can
   * end up with a laxer notion of "us" than the other.
   */
  trustedOrigins?: string[];
  /** Where hook denials are recorded. Defaults to the console. */
  logger?: OrganizationLogger;
}

export type AtriumAuth = ReturnType<typeof createAtriumAuth>;

/** The database-backed implementations of the organization hooks' ports. */
export function atriumOrganizationPorts(
  db: Database,
  logger?: OrganizationLogger,
): OrganizationPorts {
  const reconcile = logger ? { warn: logger.warn } : undefined;
  return {
    memberRole: (input) => loadWorkspaceMemberRole(db, input),
    createDefaultRoom: (input) => createDefaultRoom(db, input, reconcile),
    joinWorkspaceRooms: (input) => joinWorkspaceRooms(db, input, reconcile),
    revokeWorkspaceRooms: (input) => revokeWorkspaceRooms(db, input),
    syncWorkspaceRoomRoles: (input) => syncWorkspaceRoomRoles(db, input, reconcile),
  };
}

const consoleLogger: OrganizationLogger = {
  warn: (message, fields) => console.warn(`[atrium/auth] ${message}`, fields ?? {}),
  error: (message, fields) => console.error(`[atrium/auth] ${message}`, fields ?? {}),
};

export function createAtriumAuth(options: AtriumAuthOptions) {
  const { db, baseURL } = options;
  const logger = options.logger ?? consoleLogger;
  const mailer = resolveMailer(options.mailer);
  const secret = options.secret ?? resolveAuthSecret();

  const config = {
    appName: 'atrium',
    baseURL,
    secret,
    /**
     * Always includes `baseURL`; callers add the other process's origin. Better
     * Auth uses this for its own origin check on state-changing requests, so an
     * empty list here is not "no policy", it is "only us".
     */
    trustedOrigins: [baseURL, ...(options.trustedOrigins ?? [])].filter(
      (origin, index, all) => all.indexOf(origin) === index,
    ),

    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: authTables,
      // One invitation acceptance writes an invitation row and a member row;
      // a half-accepted invitation is not a state this app knows how to be in.
      transaction: true,
    }),

    // Ids are real uuids so an auth row's primary key looks like every other
    // primary key in the schema and can be foreign-keyed at directly.
    advanced: {
      database: { generateId: 'uuid' },
      /**
       * Which headers may name the caller. Matched to `client-ip.ts` so the
       * library's limiter and Atrium's own throttle bucket the same request the
       * same way; both are only as trustworthy as the proxy in front of them,
       * which is what `ATRIUM_TRUSTED_PROXY_HOPS` documents.
       */
      ipAddress: { ipAddressHeaders: [...forwardedHeaderNames] },
    },

    /**
     * Better Auth's own limiter, pinned rather than defaulted.
     *
     * The default is "enabled in production only", which means the surface is
     * unlimited in exactly the environment where somebody is most likely to
     * point a script at it by accident. `mounted.ts` already reduces that
     * surface to the verification link and the OAuth callback; this bounds what
     * is left. It is per-process memory, same caveat as `throttle.ts`.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 120,
      storage: 'memory',
      customRules: {
        // The verification link is the one unauthenticated GET that does real
        // work. Generous enough for a shared NAT, tight enough to make token
        // guessing pointless on top of the token's own entropy.
        '/verify-email': { window: 60, max: 30 },
      },
    },

    // Better Auth's `user`/`organization` models are our `users`/`workspaces`.
    ...authModelOptions,

    /**
     * Session lifetime, written down instead of inherited. (Spread over the
     * model remapping above rather than beside it — both configure `session`.)
     *
     * Thirty days with a daily refresh is the ordinary "stay signed in" bargain.
     * `freshAge` is the one that matters for revocation: a session older than an
     * hour is not fresh enough for Better Auth's sensitive operations, so a
     * stolen cookie cannot be used to change the account it stole.
     *
     * There is deliberately **no cookie cache**. It trades a database read for
     * a window in which a revoked session still validates, and this ticket's
     * whole revocation story — removed member, dead socket — depends on the
     * session table being the truth.
     */
    session: {
      ...authModelOptions.session,
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60,
    },

    emailAndPassword: {
      enabled: true,
      // No unverified session, ever: a signup that never checks its mail cannot
      // create a workspace or accept an invitation.
      requireEmailVerification: true,
      minPasswordLength: 12,
      /**
       * Resetting a password is what somebody does when they think an account is
       * compromised. Leaving the attacker's other sessions alive would make the
       * reset theatre. (The interactive `changePassword` endpoint takes its own
       * `revokeOtherSessions` flag; Atrium does not expose it yet — when a
       * change-password flow lands it passes `true`, and `mounted.ts` is where
       * its path becomes reachable.)
       */
      revokeSessionsOnPasswordReset: true,
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
      organization(
        atriumOrganizationOptions({
          ports: atriumOrganizationPorts(db, logger),
          baseURL,
          mailer,
          schema: organizationSchemaOptions,
          logger,
        }),
      ),
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
