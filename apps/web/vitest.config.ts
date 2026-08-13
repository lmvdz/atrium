import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * `apps/web`'s unit tests — ONE project carrying two lanes' suites.
 *
 * The auth lane (#26 r5) added this file to cover the app's SERVER-side
 * modules: there was none before, which is why `lib/env.ts` — the file that
 * decides whether this app will serve production traffic at all — had no test
 * of its own for four rounds. Playwright covers the app through a browser; it
 * cannot flip `NODE_ENV` and watch a boot condition refuse.
 *
 * The UI lane (#39) added this file independently to cover the COMPONENT
 * layer. Browser-shaped assertions (overflow, computed font size, contrast)
 * live in Playwright — see e2e/gallery.spec.ts. These tests cover the things a
 * real browser cannot check better than a type: glyph derivation, the quotation
 * invariant, and the required rationale.
 *
 * Both suites run here. What each side needed, and how it survived:
 *
 *   ENVIRONMENT — `jsdom`, the UI lane's value. `@testing-library/react` has to
 *   have a document; the auth suite does not have to *not* have one. Nothing in
 *   `test/env.test.ts` reads a Node-only global that jsdom removes — it stubs
 *   `process.env` through `vi.stubEnv` and calls three accessors. A file that
 *   ever does need the bare runtime can say `@vitest-environment node` in its
 *   own docblock rather than forcing the whole project onto one environment.
 *
 *   `server-only` ALIAS — kept, verbatim, from the auth lane. It points at that
 *   package's own `empty.js`, the exact module it exports under the
 *   `react-server` condition, which is what Next resolves when it compiles
 *   these files for the server. The alias is not a stub we wrote; it is the
 *   same file the framework picks.
 *
 *   `resolve.conditions` — DROPPED, deliberately, and this is the one line
 *   neither lane wrote. The auth lane set `['react-server', 'node', 'import',
 *   'default']`. Under `react-server`, React resolves to its SERVER build — no
 *   hooks, no `react-dom/client` — so every one of the UI lane's ~20 `.tsx`
 *   suites would fail to render. That condition list existed only to reach
 *   `server-only/empty.js`, and the auth lane's own comment records that it was
 *   NOT sufficient for that ("the package is CommonJS and gets resolved through
 *   `main`, so the throwing module wins") — the explicit alias above is what
 *   actually does the job, and it still does it with the conditions gone.
 *
 *   WORKSPACE SOURCE ALIASES — kept from the auth lane. Testing against source
 *   is what keeps `pnpm test` independent of build order.
 *
 *   INCLUDE — the union: `.test.ts` (both lanes) and `.test.tsx` (UI lane).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      /**
       * `@/*` — the app's own root alias, declared in `tsconfig.json` and used by
       * app modules. It was absent here and nothing noticed, because every `@/`
       * specifier in the component layer had been a TYPE import, which the
       * compiler erases before vite ever sees it. The first VALUE import through
       * it (#121's shared hold constants, which the gate and the affordance must
       * read from one place) failed to resolve and took twenty-one suites down
       * with it — including every sweep, which is the shape that matters: a
       * resolution error reports as a failing file, and a failing sweep proves
       * nothing about the rule it enforces.
       *
       * The key is `@/` and not `@`: `@atrium/db` starts with `@`, and a prefix
       * alias on the bare sigil would swallow all three workspace packages below.
       */
      '@/': fileURLToPath(new URL('./', import.meta.url)),
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
      // Test against source, so `pnpm test` never depends on build order.
      '@atrium/auth': fileURLToPath(new URL('../../packages/auth/src/index.ts', import.meta.url)),
      '@atrium/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@atrium/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globals: false,
  },
});
