/* a fast console check: load, walk the obvious paths, print every invariant
   error once. The full enumerating driver is prototype-drive.mjs. */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '/home/lars/atrium/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs';

/* THE VIEWPORT IS AN ARGUMENT (round 14, D2): `--w 1279` reproduces a class of
   defect that every harness here was blind to for thirteen rounds because all
   four of them opened at 1440×900 and nothing said so. */
const argv = process.argv.slice(2);
const take = (k, d) => {
  const i = argv.indexOf(k);
  if (i < 0) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const W = Number(take('--w', '1440'));
const H = Number(take('--h', '900'));
const FILE = path.resolve(
  argv[0] || path.join(path.dirname(new URL(import.meta.url).pathname), 'prototype-frame.html'),
);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
page.on('pageerror', (e) => errs.push('[uncaught] ' + e.message));
await page.goto(pathToFileURL(FILE).href);
await page.waitForTimeout(400);
const click = async (t, n) => {
  const ok = await page.evaluate(
    ({ t, n }) => {
      const els = Array.prototype.filter.call(document.querySelectorAll('button'), (el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width &&
          r.height &&
          (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase().includes(t.toLowerCase())
        );
      });
      const el = els.filter((e) => !els.some((o) => o !== e && e.contains(o)))[n || 0];
      if (el) el.click();
      return !!el;
    },
    { t, n },
  );
  await page.waitForTimeout(60);
  if (!ok) errs.push('[driver] control not found: ' + t);
  return ok;
};
for (const step of argv.slice(1)) await click(step);
await page.waitForTimeout(200);
const seen = new Set();
errs.forEach((e) => {
  const k = e.slice(0, 150);
  if (!seen.has(k)) {
    seen.add(k);
    console.log(e.slice(0, 320));
  }
});
console.log(
  '--- ' + errs.length + ' error line(s), ' + seen.size + ' distinct  [' + W + 'x' + H + ']',
);
await browser.close();
