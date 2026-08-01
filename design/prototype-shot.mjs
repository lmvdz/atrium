import { chromium } from "/home/lars/atrium/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const out = process.argv[2] || "/tmp/shot.png";
const steps = process.argv.slice(3);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(pathToFileURL(path.join(HERE, "prototype-frame.html")).href);
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
console.log("wrote " + out);
