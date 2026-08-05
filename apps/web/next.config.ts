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
  devIndicators: process.env.ATRIUM_E2E === '1' ? false : undefined,
  // These load drivers and crypto at runtime; bundling them into the server
  // build is at best pointless and at worst breaks them. Leave them as real
  // Node requires. (The workspace packages are deliberately *not* listed — Next
  // compiles those from source, which is what makes `@/lib` imports work.)
  serverExternalPackages: ['postgres', 'drizzle-orm', 'better-auth', 'nodemailer'],
  /* In the deployed stack Caddy owns `/attachments/*`. A split-process local
     run has no proxy, so it may state the server origin here; the browser still
     calls the same-origin path and only the small presign JSON is forwarded. */
  async rewrites() {
    const server = process.env.ATRIUM_SERVER_HTTP_URL?.replace(/\/$/, '');
    return server
      ? [
          {
            source: '/attachments/:path*',
            destination: `${server}/attachments/:path*`,
          },
        ]
      : [];
  },

  // There is deliberately no `env:` block, and no `NEXT_PUBLIC_WS_URL`.
  //
  // The auth lane put one here; the realtime lane took it out, and taking it
  // out is the correct half. Anything named in `env:` is inlined into the
  // client bundle at build time, which is what #19's gauntlet routed to #22 as
  // a defect: the socket URL was frozen into the image, so one build could not
  // be promoted between environments and an HTTPS deployment served a
  // `ws://localhost` bundle that fails as mixed content. The URL is now
  // resolved when the page runs — same-origin `/ws` by default, overridable per
  // request through `app/api/runtime-config/route.ts`. See `src/lib/ws-url.ts`.
  //
  // `serverExternalPackages` above is the auth lane's and is unaffected: it
  // governs the SERVER bundle and inlines nothing into the client.
};

export default nextConfig;
