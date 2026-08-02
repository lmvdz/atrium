/* an ad-hoc prober: drive a path by button text, then evaluate an expression.
   node prototype-probe.mjs [--w 1279] [--h 900] [--file f] "<expr>" "click text" ...

   THE VIEWPORT IS AN ARGUMENT, NOT A CONSTANT (round 14, D2). Every harness
   beside this one hard-coded 1440×900, so thirteen rounds of numbers were
   numbers about one viewport and a live invariant violation at every supported
   width at or below 1279 went thirteen rounds unseen. An environmental constant
   a harness fixes is part of its denominator. */
import { chromium } from "/home/lars/atrium/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const take = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const W = Number(take("--w", "1440"));
const H = Number(take("--h", "900"));
const FILE = path.resolve(take("--file", path.join(HERE, "prototype-frame.html")));
const CUT = Number(take("--cut", "190"));
const expr = argv[0];
const steps = argv.slice(1);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("[uncaught] " + e.message));
await page.goto(pathToFileURL(FILE).href);
await page.waitForTimeout(300);
console.log(`# ${FILE} at ${W}x${H}`);
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
if (expr) console.log(JSON.stringify(await page.evaluate(expr), null, 1));
console.log("--- errors:");
[...new Set(errs.map(e => e.slice(0, CUT)))].forEach(e => console.log(e));
await browser.close();
