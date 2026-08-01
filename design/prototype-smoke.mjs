/* a fast console check: load, walk the obvious paths, print every invariant
   error once. The full enumerating driver is prototype-drive.mjs. */
import { chromium } from "/home/lars/atrium/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const FILE = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), "prototype-frame.html"));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("[uncaught] " + e.message));
await page.goto(pathToFileURL(FILE).href);
await page.waitForTimeout(400);
const click = async (t, n) => {
  const ok = await page.evaluate(({ t, n }) => {
    const els = Array.prototype.filter.call(document.querySelectorAll("button"), el => {
      const r = el.getBoundingClientRect();
      return r.width && r.height && (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(t.toLowerCase());
    });
    const el = els.filter(e => !els.some(o => o !== e && e.contains(o)))[n || 0];
    if (el) el.click();
    return !!el;
  }, { t, n });
  await page.waitForTimeout(60);
  if (!ok) errs.push("[driver] control not found: " + t);
  return ok;
};
for (const step of (process.argv.slice(3).length ? process.argv.slice(3) : [])) await click(step);
await page.waitForTimeout(200);
const seen = new Set();
errs.forEach(e => { const k = e.slice(0, 150); if (!seen.has(k)) { seen.add(k); console.log(e.slice(0, 320)); } });
console.log("--- " + errs.length + " error line(s), " + seen.size + " distinct");
await browser.close();
