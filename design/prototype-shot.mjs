import { chromium } from "/home/lars/atrium/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
/* the viewport is an argument, not a constant (round 14, D2) */
const argv = process.argv.slice(2);
const take = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const W = Number(take("--w", "1440"));
const H = Number(take("--h", "900"));
const FILE = path.resolve(take("--file", path.join(HERE, "prototype-frame.html")));
const out = argv[0] || "/tmp/shot.png";
const steps = argv.slice(1);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
await page.goto(pathToFileURL(FILE).href);
await page.waitForTimeout(400);
for (const t of steps) {
  await page.evaluate(t => {
    const els = Array.prototype.filter.call(document.querySelectorAll("button"), el => {
      const r = el.getBoundingClientRect();
      return r.width && r.height && (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(t.toLowerCase());
    });
    const el = els.filter(e => !els.some(o => o !== e && e.contains(o)))[0];
    if (el) el.click();
  }, t);
  await page.waitForTimeout(80);
}
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
console.log("wrote " + out + " at " + W + "x" + H);
