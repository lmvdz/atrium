/**
 * @atrium/auth — one Better Auth configuration, one authorization function.
 *
 * Imported by `apps/web` (route handlers, server components, server actions)
 * and by `apps/server` (the WebSocket upgrade). Everything about "who is this
 * and what may they do" lives behind these exports; nothing outside this package
 * parses a cookie, validates a token, or compares a role.
 */
export * from './auth.js';
export * from './authz.js';
export * from './client-ip.js';
export * from './mailer.js';
export * from './mounted.js';
export * from './org.js';
export * from './origin.js';
export * from './secret.js';
export * from './session.js';
export * from './throttle.js';
export * from './workspace.js';
