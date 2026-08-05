/**
 * Asserts the browser Playwright is about to use actually exists.
 *
 * The e2e suite skips itself when no browser is installed, which is the right
 * call on a laptop and a lie in CI. Belt to that spec's braces: if the download
 * silently failed, stop here rather than report a green run over zero executed
 * browser tests.
 *
 * Run from apps/web:
 *   pnpm --filter @atrium/web exec node ../../scripts/ci/assert-chromium.mjs
 */

import { existsSync } from 'node:fs';
import { requireFrom } from './import-from.mjs';

const webDir = process.env.WEB_PACKAGE_DIR ?? process.cwd();

function main() {
  const { chromium } = requireFrom(webDir, '@playwright/test');
  const path = chromium.executablePath();
  if (!existsSync(path)) {
    console.error(
      `::error::Chromium is not installed at ${path}. A browser suite with no browser does not pass; it does not run.`,
    );
    return 1;
  }
  console.info(`Chromium present at ${path}`);
  return 0;
}

process.exit(main());
