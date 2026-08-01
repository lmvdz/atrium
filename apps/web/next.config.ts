import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/** Repo root — this app imports `design/tokens.css` from outside its own dir. */
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-hosted on a single VPS behind Docker (issue #18), not a serverless
  // platform — standalone output keeps the runtime image small.
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
  turbopack: {
    root: workspaceRoot,
  },
  // Dev-only: keeps client assets served when the browser reaches the dev
  // server by IP (Playwright, a phone on the LAN) instead of `localhost`.
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  // There is deliberately no `env:` block, and no `NEXT_PUBLIC_WS_URL`.
  //
  // Anything named here is inlined into the client bundle at build time, which
  // is what #19's gauntlet routed to #22 as a defect: the socket URL was frozen
  // into the image, so one build could not be promoted between environments and
  // an HTTPS deployment served a `ws://localhost` bundle that fails as
  // mixed content. The URL is now resolved when the page runs — same-origin
  // `/ws` by default, overridable per request through
  // `app/api/runtime-config/route.ts`. See `src/lib/ws-url.ts`.
};

export default nextConfig;
