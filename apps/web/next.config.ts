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
  // These load drivers and crypto at runtime; bundling them into the server
  // build is at best pointless and at worst breaks them. Leave them as real
  // Node requires. (The workspace packages are deliberately *not* listed — Next
  // compiles those from source, which is what makes `@/lib` imports work.)
  serverExternalPackages: ['postgres', 'drizzle-orm', 'better-auth', 'nodemailer'],

  // ┌─ THERE IS NO `env:` BLOCK HERE, AND THAT IS THE POINT ────────────────────
  // │ Until #40 this file carried
  // │
  // │     env: { NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? 'ws://…' }
  // │
  // │ `env:` is a *compile-time substitution*. Measured, not assumed: building
  // │ with `NEXT_PUBLIC_WS_URL=wss://probe.example/ws` put that literal string
  // │ into `.next/standalone/apps/web/server.js` and into two server chunks. So
  // │ the value in `docker-compose.yml` — set at runtime, derived from
  // │ `ATRIUM_DOMAIN` — never reached the process, which read the build
  // │ machine's fallback instead. Under NODE_ENV=production that fallback is
  // │ `ws://`, `assertSecureTransport` refuses it, and `auth()` throws on every
  // │ request: the second reason (after the missing mail transport) that this
  // │ deployment answered 500 to every page.
  // │
  // │ The realtime URL is a *deployment* fact, not a *build* fact. It is now
  // │ `ATRIUM_WS_URL` — no `NEXT_PUBLIC_` prefix, because that prefix is itself
  // │ a compile-time substitution — read on the request path by
  // │ `lib/env.ts:realtimeUrl()` and handed to the browser as a prop by the room
  // │ page. One image, any hostname, no rebuild.
  // │
  // │ `scripts/ci/assert-image-origins.mjs` fails the build if a `ws://` or
  // │ `wss://` literal reappears in the image's own compiled output, which is
  // │ what re-adding either spelling would produce.
  // └───────────────────────────────────────────────────────────────────────────
};

export default nextConfig;
