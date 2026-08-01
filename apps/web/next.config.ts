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
  env: {
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws',
  },
};

export default nextConfig;
