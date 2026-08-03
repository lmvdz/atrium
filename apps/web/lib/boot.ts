import 'server-only';
import { auth } from './auth';
import { appUrl, databaseUrl, isBuildPhase, proxyStrategy, realtimeOrigin } from './env';

/**
 * Exercise every lazy serving-time configuration gate once at process boot.
 * Next's build phase is exempt because it compiles routes but serves nothing.
 */
export function assertServingConfig(): void {
  if (isBuildPhase()) return;
  appUrl();
  databaseUrl();
  proxyStrategy();
  realtimeOrigin();
  auth();
}

/** Exit rather than leaving a listening process whose every page returns 500. */
export function assertServingConfigOrExit(): void {
  try {
    assertServingConfig();
  } catch (error) {
    console.error(
      '[atrium/web] refusing to serve: runtime configuration cannot render a page.',
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  }
}
