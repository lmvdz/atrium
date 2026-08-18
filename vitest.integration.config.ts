import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The real-Postgres suite (issue #22). Separate from `vitest.config.ts` on
 * purpose: `pnpm test` must stay runnable with nothing but Node, and a suite
 * that needs a database should say so by failing to connect, not by skipping
 * itself into a green tick.
 *
 *   pnpm test:integration           # compose up → migrate → run → down
 *
 * These tests exercise the migrations in `packages/db/drizzle` as applied to a
 * live server — never a hand-assembled schema and never a regex over the SQL,
 * which is the #19 finding this arrangement answers. A constraint that exists
 * in a string but not in the database is exactly the failure mode.
 */

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));
/** The webapp root, for the `@/` alias below (mirrors apps/web's own `@/*` → `./*`). */
const webRoot = fileURLToPath(new URL('./apps/web/', import.meta.url));

export default defineConfig({
  /**
   * JSX transform for the covenant read path's `.tsx` modules — the same plugin
   * `apps/web/vitest.config.ts` runs, and for a reason its own comment records:
   * `apps/web/tsconfig.json` sets `jsx: preserve` (Next wants it), so vite's esbuild
   * transform leaves the JSX in place and `import-analysis` cannot parse it. The
   * Babel-based plugin transforms JSX regardless of the discovered tsconfig, which
   * esbuild's own `jsx` option does not override per-file.
   *
   * The suite reaches this `.tsx` grammar because resolving `@/*` (below) lets the
   * runner follow the covenant read path to source: `apps/web/lib/replay-data.ts` →
   * `room-covenant-reads.ts` → `live-covenant-doc.ts` → `@/app/prototype/yjs-conversation`
   * → `./conversation-model`, which VALUE-imports `bodyText`/`messageEntry`/… from
   * `@/src/components/model`. The suite only IMPORTS these modules (to drive the real
   * covenant reader) — it never renders — so a Node environment plus this transform is
   * enough. The entanglement is temporary: E4's #204 lifts the Yjs substrate out of
   * `app/prototype/`, after which this path no longer crosses the component layer.
   */
  plugins: [react()],
  resolve: {
    // Array form, because order decides: `@atrium/db/schema` has to be matched
    // before the bare `@atrium/db` prefix would swallow it.
    alias: [
      // The webapp's own `@/*` alias, so an integration test may import a server
      // library that resolves siblings through it — the E3 server replica
      // (`apps/web/lib/server-room-replica.ts` → the prototype `ConversationDoc`)
      // is the first to. `@/` only (not `@atrium/`), matched as a prefix; mirrors
      // `integration/tsconfig.json`'s `@/*` path so the runner runs what tsc checks.
      { find: /^@\//, replacement: webRoot },
      { find: /^@atrium\/db\/schema$/, replacement: src('./packages/db/src/schema.ts') },
      { find: /^@atrium\/db$/, replacement: src('./packages/db/src/index.ts') },
      { find: /^@atrium\/core$/, replacement: src('./packages/core/src/index.ts') },
      // The identity package, for the suite that wires the real Better Auth
      // upgrade authenticator instead of the stub. Source rather than `dist` for
      // the same reason as the other three: the suite must never depend on build
      // order, and what the compiler checks has to be what the runner runs.
      { find: /^@atrium\/auth$/, replacement: src('./packages/auth/src/index.ts') },
      /**
       * `@/*` — the same alias `apps/web/tsconfig.json` declares as `["./*"]`,
       * mirrored here so what the runner resolves is what the compiler checks. The
       * covenant read path (#181) reaches the conversation through
       * `apps/web/lib/{live-covenant-doc,server-room-replica}.ts`, which import
       * `@/app/prototype/*` (the Yjs substrate lives there until E4's #204). Without
       * it, `integration/web/replay-data.test.ts` cannot LOAD — it pulls
       * `apps/web/lib/replay-data.ts` → `room-covenant-reads.ts` → `live-covenant-doc.ts`.
       * A prefix find (not `$`-anchored) so every `@/…` subpath rewrites onto
       * `apps/web/`; ordered after the `@atrium/*` finds, which it does not overlap.
       */
      { find: /^@\//, replacement: src('./apps/web/') },
      /**
       * `yjs` — the covenant certify path (#190) resolves a live span through
       * `apps/web/lib/covenant-reader.ts`, which binds the Yjs port. `yjs` is a
       * dependency of `apps/web`, not the repo root, so the root-run integration
       * runner cannot resolve the bare specifier; point it at the one installed
       * copy under `apps/web`, exactly as the `@atrium/*` aliases point at source.
       */
      { find: /^yjs$/, replacement: src('./apps/web/node_modules/yjs/dist/yjs.mjs') },
      /**
       * `server-only` — the same alias `apps/web/vitest.config.ts` carries, and
       * for the same reason.
       *
       * The package's job is to make a client bundle fail loudly if it pulls in a
       * server module: its default export throws on import. There is no client
       * bundle here — this runner IS the server, on a real Postgres — so the
       * throw would only prevent the suite from exercising the modules whose
       * server-side behaviour it exists to test (#121's certify path is the first
       * one). The target is `server-only/empty.js`, the module the package itself
       * exports under the `react-server` condition; it is not a stub written here.
       */
      { find: /^server-only$/, replacement: src('./apps/web/node_modules/server-only/empty.js') },
    ],
  },
  /**
   * Force OXC's automatic JSX transform for any `.tsx` a server library pulls in
   * transitively (the E3 replica → `ConversationDoc` → the `@/src/components/model`
   * barrel, whose value exports live beside a `.tsx`). Without this, vite@8's OXC
   * transformer honours Next's per-file `jsx: "preserve"` (apps/web/tsconfig) and
   * leaves raw JSX in the output — "invalid JS syntax". `apps/web/vitest.config.ts`
   * achieves the same with `@vitejs/plugin-react`; this node-env suite needs only the
   * transform, not the DOM/refresh plugin. Non-JSX files are unaffected.
   */
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'integration',
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    globalSetup: ['integration/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /**
     * One file at a time. Every append takes the same ledger-wide advisory
     * lock, so parallel files would serialize on it anyway — and they would
     * truncate the database out from under each other while doing it.
     */
    fileParallelism: false,
  },
});
