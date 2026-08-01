/**
 * The web app's boot condition.
 *
 * Next runs `register()` once per server instance, before the first request is
 * served. That is the only place this app gets to fail *closed*: everything else
 * about its configuration is read lazily on the request path, which is correct
 * (see `lib/env.ts`) and is also how issue #26 round 4 found a compose stack
 * whose every page answered 500 while every container reported healthy.
 *
 * Kept to three lines and a dynamic import on purpose. `lib/boot` pulls in the
 * database client and Better Auth; importing it at module scope would load both
 * into the edge runtime's compilation as well, and this file is compiled for
 * every runtime Next supports.
 */
export async function register(): Promise<void> {
  // Only the Node.js server has an environment worth checking — and only it can
  // exit. The edge runtime has neither.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { assertServingConfig } = await import('./lib/boot');
    assertServingConfig();
  } catch (error) {
    console.error(
      '[atrium/web] refusing to serve: this process is not configured well enough ' +
        'to render a page, so it is exiting instead of answering 500 to every ' +
        'request. See apps/web/lib/boot.ts.',
    );
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  }
}
