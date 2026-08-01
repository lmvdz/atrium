/**
 * The web app's boot condition.
 *
 * Next runs `register()` once per server instance, before the first request is
 * served. That is the only place this app gets to fail *closed*: everything else
 * about its configuration is read lazily on the request path, which is correct
 * (see `lib/env.ts`) and is also how issue #26 round 4 found a compose stack
 * whose every page answered 500 while every container reported healthy.
 *
 * Kept to two lines and a dynamic import on purpose. Next compiles this file for
 * every runtime it supports, edge included; `lib/boot` pulls in the database
 * client, Better Auth and `process.exit`, none of which exist there. Importing
 * it at module scope would drag all of that into the edge compilation and earn a
 * build warning about a Node API on a line the edge runtime can never reach.
 */
export async function register(): Promise<void> {
  // Only the Node.js server has an environment worth checking — and only it can
  // exit. The edge runtime has neither.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertServingConfigOrExit } = await import('./lib/boot');
  assertServingConfigOrExit();
}
