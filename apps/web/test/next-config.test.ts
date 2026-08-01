import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../next.config';

/**
 * The build must not compile a deployment's own URLs into the image.
 *
 * ## What happened
 *
 * `next.config.ts` carried
 *
 *     env: { NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws' }
 *
 * `env:` is a compile-time substitution, and so is the `NEXT_PUBLIC_` prefix on
 * its own. Measured before the fix: a build with
 * `NEXT_PUBLIC_WS_URL=wss://probe.example/ws` put that literal into
 * `.next/standalone/apps/web/server.js` and two server chunks. In the shipped
 * image the substituted value was the build machine's fallback,
 * `ws://localhost:4000/ws`, because nothing sets that variable during
 * `docker build` — and `docker-compose.yml` sets the real `wss://` one at
 * *runtime*, where it could no longer be read. `assertSecureTransport` refused
 * the cleartext value, correctly, and every page of the deployment answered 500.
 *
 * ## Why a unit test as well as `scripts/ci/assert-image-origins.mjs`
 *
 * The CI script reads the built image, which is the artefact that ships and is
 * therefore the stronger evidence — but it only runs in the deploy job, needs
 * Docker, and takes minutes. This runs in milliseconds on every `pnpm test` and
 * fails on the commit that reintroduces the shape, which is where a defect is
 * cheapest to fix. Two checks of one property at two costs, deliberately.
 *
 * Each assertion names the mutation it catches.
 */

const source = readFileSync(fileURLToPath(new URL('../next.config.ts', import.meta.url)), 'utf8');

/**
 * The file with its comments removed.
 *
 * The comment block in `next.config.ts` quotes the deleted `env:` line verbatim,
 * because a warning that cannot name the thing it warns about is not a warning.
 * A source scan therefore has to read code, and only code — otherwise the
 * documentation of the defect *is* the defect as far as the test is concerned,
 * and the only way to make the test pass would be to delete the explanation.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('next.config.ts — no deployment value may be compiled in', () => {
  it('declares no `env` block', () => {
    /**
     * Catches: re-adding `env: { … }` in any form. Asserted on the *resolved
     * config object* rather than on the source text, so a block written with a
     * different key order, a spread, or a computed value is caught just as well
     * as the original line.
     */
    expect(config.env).toBeUndefined();
  });

  it('mentions no `NEXT_PUBLIC_` variable at all', () => {
    /**
     * The prefix is the substitution. A `NEXT_PUBLIC_WS_URL` read anywhere in
     * the app has the same effect as the `env:` block did, without the block —
     * which is why the variable is `ATRIUM_WS_URL` now and why this asserts on
     * the *name* rather than on the config shape.
     *
     * Catches: renaming `ATRIUM_WS_URL` back, or adding any other public-
     * prefixed deployment variable to this file.
     */
    expect(code).not.toMatch(/NEXT_PUBLIC_[A-Z_]+/);
  });

  it('keeps nodemailer out of the bundle, so the SMTP transport is a real require', () => {
    /**
     * `createSmtpMailer` is reached from a Server Action through `@atrium/auth`,
     * which Next compiles from source. Bundling nodemailer with it breaks its
     * dynamic requires; leaving it external makes Next's file tracing copy the
     * package into the standalone output instead.
     *
     * Catches: dropping `nodemailer` from `serverExternalPackages`, which turns
     * every signup in the deployment into a 500 that no unit test would see.
     */
    expect(config.serverExternalPackages).toContain('nodemailer');
  });

  it('still emits the standalone output the Dockerfile copies', () => {
    // Catches: removing `output: 'standalone'`, which leaves
    // `apps/web/Dockerfile`'s `COPY --from=build .next/standalone` with nothing
    // to copy — a build failure, but a confusing one.
    expect(config.output).toBe('standalone');
  });
});
