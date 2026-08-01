/* an ad-hoc prober: drive a path by button text, then evaluate an expression.
   node prototype-probe.mjs "<expr>" "click text" "click text" ... */
import { chromium } from "/home/lars/atrium/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const expr = process.argv[2];
const steps = process.argv.slice(3);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("[uncaught] " + e.message));
await page.goto(pathToFileURL(path.join(HERE, "prototype-frame.html")).href);
await page.waitForTimeout(300);
for (const t of steps) {
  const ok = await page.evaluate(t => {
    const els = Array.prototype.filter.call(document.querySelectorAll("button"), el => {
      const r = el.getBoundingClientRect();
      return r.width && r.height && (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(t.toLowerCase());
    });
    const el = els.filter(e => !els.some(o => o !== e && e.contains(o)))[0];
    if (el) el.click();
    return !!el;
  }, t);
  console.log((ok ? "  clicked " : "  NOT FOUND ") + JSON.stringify(t));
  await page.waitForTimeout(60);
}
console.log("---");
console.log(JSON.stringify(await page.evaluate(expr), null, 1));
console.log("--- errors:");
[...new Set(errs.map(e => e.slice(0, 190)))].forEach(e => console.log(e));
await browser.close();
