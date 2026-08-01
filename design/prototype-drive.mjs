#!/usr/bin/env node
/* =============================================================================
 * prototype-drive.mjs — the enumerating driver for design/prototype-frame.html
 *
 * WHY THIS EXISTS. Round 11 reported "0 errors across 900 randomised real
 * clicks" and shipped four live invariant violations reachable in three
 * deliberate clicks. 900 random clicks never traverse one specific sequence: a
 * count of clicks is not a count of paths. This driver does not count clicks.
 * It ENUMERATES the controls the artifact offers — by instrumenting
 * addEventListener before the page's own script runs, so the enumeration is the
 * page's own listener registrations rather than a selector list somebody
 * remembered — and drives every one of them, then randomises on top.
 *
 * It reports: how many controls exist, how many were driven, which were not and
 * why. Plus the scripted repros for this round's defects, each of which must
 * fire on fix/prototype-frame-r11 as committed and be silent after.
 *
 * Usage:
 *   node design/prototype-drive.mjs [--file <path>] [--random N] [--json out]
 * ========================================================================== */

import { chromium } from "/home/lars/atrium/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FILE = path.resolve(argOf("--file", path.join(HERE, "prototype-frame.html")));
const RANDOM_SESSIONS = Number(argOf("--random", "12"));
const RANDOM_CLICKS = Number(argOf("--clicks", "60"));
const JSON_OUT = argOf("--json", "");
const URL = pathToFileURL(FILE).href;

/* --- the enumeration, installed before the page's script -------------------
   Every control on this page is an element the page called addEventListener
   on. That is the definition used here, so a control cannot be missed by being
   forgotten: patching the prototype means the page registers its own inventory.
   Elements are tagged at listener-attach time, which is inside render(), so the
   inventory is rebuilt with the DOM. */
const INIT = `
(() => {
  const ACTION = ["id","data-fx","data-open","data-receipt","data-rcroom","data-jump","data-jumproom",
                  "data-pin","data-reply","data-verify","data-opt","data-filter","data-scope",
                  "data-lens-obj","data-corr","data-obj","data-msg","data-bind","data-about"];
  window.__ctlSeen = new Map();
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      if ((type === "click" || type === "pointerdown" || type === "mousedown") &&
          this instanceof Element && this !== document.documentElement) {
        this.setAttribute("data-ctl", type);
      }
    } catch (e) {}
    return orig.call(this, type, fn, opts);
  };
  window.__ctlKey = function (el) {
    const parts = [el.tagName.toLowerCase()];
    for (const a of ACTION) if (el.hasAttribute(a)) parts.push(a + "=" + el.getAttribute(a));
    let label = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 44);
    label = label.replace(/\\d{1,2}:\\d{2}/g, "##:##").replace(/\\b\\d+\\b/g, "#");
    return parts.join(" ") + (label ? " :: " + label : "");
  };
  /* an element is drivable if a reader could reach it: on screen, not disabled,
     not hidden. Anything enumerated but not drivable is reported, not skipped
     silently. */
  window.__ctls = function () {
    return Array.prototype.map.call(document.querySelectorAll("[data-ctl]"), (el, i) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const vis = cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.01 &&
                  r.width > 0 && r.height > 0;
      el.setAttribute("data-ctl-i", String(i));
      return { i, key: window.__ctlKey(el), visible: vis, disabled: !!el.disabled,
               tag: el.tagName.toLowerCase() };
    });
  };
})();
`;

/* --- one browser session ---------------------------------------------------- */
async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", m => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const t = m.text();
    if (t.indexOf("[atrium invariant]") < 0 && m.type() !== "error") return;
    errors.push(t);
  });
  page.on("pageerror", e => errors.push("[uncaught] " + e.message));
  await page.goto(URL);
  await page.waitForFunction("typeof render === 'function'", null, { timeout: 90000 });
  return { ctx, page, errors };
}

const invariantsOnly = list => list.filter(t => t.indexOf("[atrium invariant]") === 0);
/* the class of a violation, for counting distinct classes rather than lines */
function classOf(text) {
  const m = text.replace(/^\[atrium invariant\] /, "");
  return m.split(/ — |:/)[0].trim().slice(0, 110);
}

async function ctlList(page) { return page.evaluate("window.__ctls()"); }

async function clickIndex(page, i) {
  await page.evaluate(idx => {
    const el = document.querySelector('[data-ctl-i="' + idx + '"]');
    if (el) el.click();
  }, i);
  await page.waitForTimeout(16);
}

/* controls that only do their work with characters in a field beside them */
async function prefill(page, key) {
  const fill = async (sel, text) => {
    const has = await page.evaluate(s => !!document.querySelector(s), sel);
    if (has) await page.fill(sel, text);
  };
  if (/id=vgo/.test(key)) await fill("#vinput", "checked the runbook against the staging rehearsal log");
  if (/id=rgo/.test(key)) await fill("#rinput", "the rehearsal log does not cover the rollback path");
  if (/id=sendBtn/.test(key)) await fill("#cinput", "noting this here so the room has it");
}

/* ===========================================================================
 * PASS 1 — deliberate enumeration.
 *
 * Greedy depth-first over control keys from repeated fresh loads: on each load,
 * keep clicking the first on-screen control whose key has never been driven,
 * until the screen offers none; then reload and go again. Repeat until a whole
 * lap discovers nothing new. Every key ever SEEN is recorded even if it was
 * never drivable, so the report can say which were not driven and why.
 * ======================================================================== */
async function passEnumerate(browser, log) {
  const seen = new Map();      // key -> {visible:bool, driven:bool, reason}
  const violations = [];       // {text, path}
  let rng = 7717;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const note = c => {
    if (!seen.has(c.key)) seen.set(c.key, { visible: false, driven: false, reason: "never on screen" });
    const s = seen.get(c.key);
    if (c.visible && !c.disabled) { s.visible = true; s.reason = ""; }
    else if (c.disabled && !s.visible) s.reason = "disabled wherever it appeared";
    return s;
  };
  let sessions = 0, dry = 0, lap = 0;
  /* Sessions keep running until a whole lap of SESSIONS_PER_LAP fresh loads
     drives nothing new. Within a session, an undriven on-screen control is
     always preferred; when the screen offers none, a random visible control is
     clicked to MOVE the state, because reachability is a property of a path and
     the first screen is not the whole page. */
  const SESSIONS_PER_LAP = Number(argOf("--lap", "6")), STEPS = Number(argOf("--steps", "70"));
  for (;;) {
    lap++;
    let discoveredThisLap = 0;
    for (let s = 0; s < SESSIONS_PER_LAP; s++) {
      const { ctx, page, errors } = await newPage(browser);
      sessions++;
      const path0 = [];
      for (let k = 0; k < STEPS; k++) {
        const list = await ctlList(page);
        list.forEach(note);
        const fresh = list.filter(c => c.visible && !c.disabled && !seen.get(c.key).driven);
        const pool = fresh.length ? fresh : list.filter(c => c.visible && !c.disabled);
        if (!pool.length) break;
        const pick = fresh.length ? fresh[0] : pool[Math.floor(rand() * pool.length)];
        const errAt = errors.length;
        await prefill(page, pick.key);
        path0.push(pick.key);
        await clickIndex(page, pick.i);
        if (!seen.get(pick.key).driven) { seen.get(pick.key).driven = true; discoveredThisLap++; }
        invariantsOnly(errors.slice(errAt)).forEach(t =>
          violations.push({ text: t, path: path0.slice(), where: "enumerate" }));
      }
      await ctx.close();
    }
    log(`  lap ${lap}: ${discoveredThisLap} newly driven control(s) over ${SESSIONS_PER_LAP} loads (${seen.size} keys known)`);
    if (!discoveredThisLap) { dry++; if (dry >= 2) break; } else dry = 0;
    if (lap >= 14) break;
  }
  return { seen, violations, sessions };
}

/* ===========================================================================
 * PASS 2 — randomised, on top. Not instead of.
 * ======================================================================== */
async function passRandom(browser, log) {
  const violations = [];
  let clicks = 0;
  let rng = 20260801;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let s = 0; s < RANDOM_SESSIONS; s++) {
    const { ctx, page, errors } = await newPage(browser);
    const path0 = [];
    for (let k = 0; k < RANDOM_CLICKS; k++) {
      const list = (await ctlList(page)).filter(c => c.visible && !c.disabled);
      if (!list.length) break;
      const pick = list[Math.floor(rand() * list.length)];
      const errAt = errors.length;
      await prefill(page, pick.key);
      path0.push(pick.key);
      await clickIndex(page, pick.i);
      clicks++;
      invariantsOnly(errors.slice(errAt)).forEach(t =>
        violations.push({ text: t, path: path0.slice(), where: "random s" + s }));
    }
    await ctx.close();
  }
  log(`  ${RANDOM_SESSIONS} sessions × up to ${RANDOM_CLICKS} clicks = ${clicks} clicks`);
  return { violations, clicks };
}

/* ===========================================================================
 * PASS 3 — the scripted repros. Each one is a named path, and each must be
 * silent. These are the checks that fire on r11 as committed.
 * ======================================================================== */
async function clickText(page, text, opts = {}) {
  const ok = await page.evaluate(({ text, within, nth }) => {
    const scope = within ? document.querySelector(within) : document;
    if (!scope) return false;
    const els = Array.prototype.filter.call(scope.querySelectorAll("[data-ctl]"), el => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (cs.display === "none" || cs.visibility === "hidden" || !r.width || !r.height) return false;
      return (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().indexOf(text.toLowerCase()) >= 0;
    });
    /* the innermost match — a row contains its own buttons */
    const el = els.filter(e => !els.some(o => o !== e && e.contains(o)))[nth || 0];
    if (!el) return false;
    el.click();
    return true;
  }, { text, within: opts.within, nth: opts.nth });
  await page.waitForTimeout(40);
  return ok;
}

const REPROS = [
  {
    id: "D1-resched-receipt",
    what: 'compact row "Sign off the rollback runbook" → Reschedule → the receipt for K2',
    async run(page) {
      if (!await clickText(page, "Sign off the rollback runbook")) return "row not found";
      if (!await clickText(page, "Reschedule")) return "Reschedule not found";
      if (!await clickText(page, "the receipt for K2")) return "receipt link not found";
      return null;
    }
  },
  {
    id: "D1b-resched-twice",
    what: "the same path, rescheduling a second time (the date it already had)",
    async run(page) {
      if (!await clickText(page, "Sign off the rollback runbook")) return "row not found";
      if (!await clickText(page, "Reschedule")) return "Reschedule not found";
      /* the row compresses after a write, so the card is re-opened before the
         second reschedule — the sequence, not the click count, is the test */
      if (!await clickText(page, "Sign off the rollback runbook")) return "row not found the second time";
      if (!await clickText(page, "Reschedule")) return "Reschedule not offered the second time";
      if (!await clickText(page, "the receipt for K2")) return "receipt link not found";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const k = (typeof obj === "function") && obj(room(), "K2");
        if (!k) return ["K2 is not in this room"];
        const out = [];
        if ((k.recorded.due || []).length !== 2)
          out.push("the second reschedule was not exercised: due history is " + JSON.stringify((k.recorded.due || []).map(e => e.value)));
        if (k.corrections.length < 2) out.push("only " + k.corrections.length + " correction(s) — the second reschedule did not land");
        return out;
      });
    }
  },
  {
    id: "D2-signoff-settled",
    what: 'Mark signed off on K2 → the receipt for K2 (N settled vs SETTLED header)',
    async run(page) {
      if (!await clickText(page, "Sign off the rollback runbook")) return "row not found";
      if (!await clickText(page, "Mark signed off")) return "sign-off not found";
      if (!await clickText(page, "the receipt for K2")) return "receipt link not found";
      return null;
    },
    /* the disagreement is a state question, not a console question: the summary
       partitions by verification, the header claims the settlement */
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const settledIds = [];
        Object.keys(S.rooms).forEach(rk => S.rooms[rk].objects.forEach(o => {
          const h = (o.recorded || {}).settlement || [];
          if (h.length && h[h.length - 1].value === "settled") settledIds.push(o.id);
        }));
        const sum = (document.getElementById("lensSummary") || {}).textContent || "";
        const m = sum.match(/(\d+)\s+settled/);
        const claimed = m ? Number(m[1]) : null;
        if (claimed != null && claimed !== settledIds.length)
          out.push('#lensSummary says "' + m[0] + '" while ' + settledIds.length +
                   " objects hold settlement === settled (" + settledIds.join(",") + ")");
        return out;
      });
    }
  },
  {
    id: "D2b-answer-settled",
    what: "answering a question sets resolvedAt and leaves verification alone",
    async run(page) {
      if (!await clickText(page, "Does legal approve")) return "Q1 row not found";
      if (!await clickText(page, "Answer —")) return "one-click answer not offered";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const settled = [];
        Object.keys(S.rooms).forEach(rk => S.rooms[rk].objects.forEach(o => {
          const h = (o.recorded || {}).settlement || [];
          if (h.length && h[h.length - 1].value === "settled") settled.push(o.id);
        }));
        const sum = (document.getElementById("lensSummary") || {}).textContent || "";
        const m = sum.match(/(\d+)\s+settled/);
        if (m && Number(m[1]) !== settled.length)
          out.push('#lensSummary says "' + m[0] + '" while ' + settled.length + " objects hold settlement === settled");
        return out;
      });
    }
  },
  {
    id: "D3-aggregate-coverage",
    what: "every quantified aggregate surface declares a subject the walk can see",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const sel = ["#lensSummary", "#lensSums", ".lensnote", "#pinTrailer"];
        sel.forEach(s => document.querySelectorAll(s).forEach(el => {
          if (!el.textContent.trim()) return;
          /* an aggregate surface is covered when it is minted (data-said /
             data-said-parts on it or an ancestor) or declares a subject the
             walk enumerates (data-obj / data-agg) */
          const covered = el.closest("[data-said], [data-said-parts], [data-obj], [data-agg]") ||
                          el.querySelector("[data-said], [data-said-parts]");
          if (!covered) out.push("uncovered aggregate surface: " + s + " — " + el.textContent.trim().slice(0, 70));
        }));
        return out;
      });
    }
  },
  {
    id: "D4-truncation",
    what: "no minted sentence and no control label is painted into an ellipsis",
    async run(page) {
      /* the offenders live on the compact pin rows, which appear as soon as a
         second item is owed, and on a cross-room item's title */
      await clickText(page, "Does legal approve");
      await clickText(page, "Sign off the rollback runbook");
      return null;
    },
    /* MEASURED IN THE DOM, NOT ASKED OF THE PAGE. `text-overflow: ellipsis`
       leaves textContent untouched, which is the whole defect, so this reads
       scrollWidth/scrollHeight — what the browser knows about characters it did
       not draw — rather than trusting any checker the artifact ships. */
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const clipped = el => {
          const cs = getComputedStyle(el);
          const hx = cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis";
          const hy = cs.overflowY === "hidden" || cs.overflowY === "clip" || cs.webkitLineClamp !== "none";
          return (hx && el.scrollWidth > el.clientWidth + 1) || (hy && el.scrollHeight > el.clientHeight + 1);
        };
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        document.querySelectorAll("[data-said], [data-said-parts] [data-part]").forEach(el => {
          if (!vis(el) || el.closest(".prov .ex")) return;
          for (let p = el; p && p !== document.body; p = p.parentElement)
            if (clipped(p)) return out.push("minted sentence truncated: " + el.textContent.replace(/\s+/g, " ").trim().slice(0, 60));
        });
        document.querySelectorAll("button").forEach(b => {
          if (!vis(b) || b.closest(".prov .ex")) return;
          if (clipped(b)) return out.push("control label truncated: " + b.textContent.replace(/\s+/g, " ").trim().slice(0, 60));
          b.querySelectorAll("*").forEach(el => {
            if (el.children.length || !(el.textContent || "").trim() || el.closest(".prov .ex")) return;
            if (clipped(el)) out.push("control label truncated: " + el.textContent.replace(/\s+/g, " ").trim().slice(0, 60));
          });
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    id: "D5-rail-badge",
    what: "clearing the last owed item never leaves a bare number where a glyphed count stood",
    async run(page) {
      /* clear this room's owed items: sign off the commitment, answer the
         question, take the decision */
      await clickText(page, "Sign off the rollback runbook");
      await clickText(page, "Mark signed off");
      await clickText(page, "Does legal approve");
      await clickText(page, "Answer —");
      await clickText(page, "Keep dual-write");
      await clickText(page, "Keep dual-write through");
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("#railRooms .rrow").forEach(b => {
          const badge = b.querySelector(".pill, .ct");
          if (!badge) return;
          const t = (badge.textContent || "").replace(/\s+/g, " ").trim();
          if (/^\d+$/.test(t))
            out.push("a rail badge paints a bare number with no glyph and no label, in the slot the owed count uses: " + t + " (" + b.textContent.trim().slice(0, 30) + ")");
        });
        return out;
      });
    }
  },
  {
    id: "D6-irreversible",
    what: "no action leaves an object with no way back that neither asks first nor names what it writes",
    async run(page) {
      /* drive the action the rule was written for, then go to the one surface
         every object is reachable from and look for a way back */
      if (!await clickText(page, "Does legal approve")) return "Q1 row not found";
      if (!await clickText(page, "Ask justin instead")) return "reassign not offered";
      if (!await clickText(page, "Does legal approve")) return "Q1 not reachable after the hand-off";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        if (typeof window.__irreversibleAudit === "function") out.push(...window.__irreversibleAudit());
        /* AND THE SAME QUESTION ASKED OF THE DOM, so this repro does not depend
           on the artifact's own opinion of itself: after handing Q1 on, SOME
           control a reader can reach has to amend Q1's record. */
        const q = (typeof obj === "function") && obj(room(), "Q1");
        if (!q) return out.concat(["Q1 is not in this room"]);
        if (q.assignee !== "justin" || q.owedTo != null)
          return out.concat(["the hand-off did not land: assignee=" + q.assignee + " owedTo=" + q.owedTo]);
        const writes = Array.prototype.filter.call(
          document.querySelectorAll("button[data-fx], button[data-opt], button[data-verify], #rcReopen"),
          b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        /* only controls that act on Q1 count — a Reschedule on K2 is not a way
           back from a question you handed to justin */
        const forQ1 = writes.filter(b =>
          (b.dataset.obj === "Q1") || (b.closest("[data-obj='Q1'], [data-lens-obj='Q1']")) ||
          (b.id === "rcReopen" && document.querySelector(".rc-ttl") &&
           /legal approve/i.test(document.querySelector(".rc-ttl").textContent)) ||
          /take it back/i.test(b.textContent || ""));
        if (!forQ1.length)
          out.push("Q1 was handed on with one unconfirmed click and no control anywhere amends it from your seat — " +
                   "canAnswer false, canReopen false, and the receipt offers nothing");
        return out;
      });
    }
  },
  {
    /* FOUND BY THIS DRIVER, on the artifact round 12 built before it ran — the
       branch beside the one round 11 fixed. The one-click ANSWER's provenance
       note stopped claiming things about the verification history in r11; the
       one-click RE-AFFIRMATION's note went on saying "the statement already on
       the record, recorded again verbatim" in a plain string that reads
       nothing, painted inside data-obj="D1". Four deliberate steps. */
    id: "D7-reaffirm-provenance",
    what: "reopen a decision, then re-affirm it — the provenance note quantifies over the statement history",
    async run(page) {
      if (!await clickText(page, "Dual-write stays on until parity")) return "D1's lens item not found";
      const opened = await page.evaluate(() => {
        const b = document.getElementById("rcReopen");
        if (b) b.click();
        return !!b;
      });
      if (!opened) return "the receipt offers no Reopen";
      await page.waitForTimeout(60);
      const submitted = await page.evaluate(() => {
        const i = document.getElementById("rinput"), g = document.getElementById("rgo");
        if (i) i.value = "the parity number changed";
        if (g) g.click();
        return !!g;
      });
      if (!submitted) return "the reopen prompt did not open";
      await page.waitForTimeout(80);
      const ok = await page.evaluate(() => {
        const b = Array.prototype.find.call(document.querySelectorAll("[data-opt]"), x => /Re-affirm/.test(x.textContent));
        if (b) b.click();
        return !!b;
      });
      await page.waitForTimeout(80);
      return ok ? null : "the re-affirm option was not offered";
    }
  },
  {
    /* RAISED BY A BLIND FOREIGN-LINEAGE REVIEWER against round 12's own first
       build, and true of r11 too: a feed row's state tag paints the object's
       verification straight off the object — `verified · checks`, `accepted ·
       lars`, `claim · unverified` — on the surface that never goes away, with
       nothing reading it. r10's value rule was scoped by a three-selector list
       to the lens, so no instrument on the page could see it. */
    id: "D8-row-state-tags",
    what: "every feed-row state tag is minted, not a value copied off the object",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("#feed .tag").forEach(el => {
          const host = el.closest("[data-obj], [data-lens-obj]");
          if (!host) return;
          const o = (typeof obj === "function") &&
                    (obj(room(), host.dataset.obj || host.dataset.lensObj) || null);
          if (!o) return;
          if (el.querySelector("[data-said], [data-said-parts]")) return;   // minted
          const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          Object.keys(o.recorded || {}).forEach(f => (o.recorded[f] || []).forEach(e => {
            if (typeof e.value !== "string" || !e.value) return;
            if (String(e.value).toLowerCase() === String(o.kind || "").toLowerCase()) return;
            const w = String(e.value).replace(/_/g, "-").toLowerCase();
            if (new RegExp("(^|[^\\w-])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^\\w-])").test(text))
              out.push("an unminted row tag states a value " + o.id + "'s record holds for " + f + ": " +
                       JSON.stringify(el.textContent.trim().slice(0, 50)) + " vs " + e.value);
          }));
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    id: "D6b-takeback-round-trip",
    what: "handing a question on and taking it back returns it to your seat",
    async run(page) {
      if (!await clickText(page, "Does legal approve")) return "Q1 row not found";
      if (!await clickText(page, "Ask justin instead")) return "reassign not offered";
      if (!await clickText(page, "Does legal approve")) return "Q1 not reachable after the hand-off";
      if (!await clickText(page, "Take it back")) return "nothing takes it back";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const q = (typeof obj === "function") && obj(room(), "Q1");
        if (!q) return ["Q1 is not in this room"];
        const out = [];
        if (q.owedTo !== S.me) out.push("taking it back did not put it back on your list: owedTo=" + q.owedTo);
        if ((q.recorded.assignee || []).length < 3)
          out.push("the hand-off and the take-back are not both on the record: " + JSON.stringify((q.recorded.assignee || []).map(e => e.value)));
        return out;
      });
    }
  }
];

async function passRepros(browser, log) {
  const rows = [];
  for (const rp of REPROS) {
    const { ctx, page, errors } = await newPage(browser);
    const skip = await rp.run(page);
    await page.waitForTimeout(60);
    const inv = invariantsOnly(errors);
    const asserts = rp.assert ? await rp.assert(page) : [];
    await ctx.close();
    const classes = Array.from(new Set(inv.map(classOf)));
    rows.push({ id: rp.id, what: rp.what, skip, errors: inv, classes, asserts });
    const bad = inv.length + asserts.length;
    log(`  ${bad ? "FIRES" : "clean"}  ${rp.id} — ${inv.length} console error(s), ${classes.length} class(es), ${asserts.length} assertion(s)` + (skip ? ` [path incomplete: ${skip}]` : ""));
    inv.slice(0, 6).forEach(t => log(`      ${t.slice(0, 200)}`));
    asserts.slice(0, 6).forEach(t => log(`      ! ${t}`));
  }
  return rows;
}

/* --- main ------------------------------------------------------------------ */
const lines = [];
const log = s => { lines.push(s); console.log(s); };

const browser = await chromium.launch();
log(`driving ${FILE}`);

log("\n[1] deliberate enumeration");
const en = await passEnumerate(browser, log);
const all = Array.from(en.seen.entries());
const driven = all.filter(([, v]) => v.driven);
const notDriven = all.filter(([, v]) => !v.driven);
log(`  controls enumerated: ${all.length}`);
log(`  controls driven:     ${driven.length}`);
log(`  not driven:          ${notDriven.length}`);
notDriven.forEach(([k, v]) => log(`     - ${k}   [${v.reason || "reachable but never selected"}]`));
log(`  invariant violations during enumeration: ${en.violations.length}`);
{
  const cls = new Map();
  en.violations.forEach(v => { const c = classOf(v.text); if (!cls.has(c)) cls.set(c, v); });
  cls.forEach((v, c) => { log(`     ${c}`); log(`        path: ${v.path.slice(-4).join("  →  ")}`); });
}

log("\n[2] randomised on top");
const rn = await passRandom(browser, log);
log(`  invariant violations during random drive: ${rn.violations.length}`);
{
  const cls = new Map();
  rn.violations.forEach(v => { const c = classOf(v.text); if (!cls.has(c)) cls.set(c, v); });
  cls.forEach((v, c) => { log(`     ${c}`); log(`        path: ${v.path.slice(-4).join("  →  ")}`); });
}

log("\n[3] scripted repros");
const rp = await passRepros(browser, log);

await browser.close();

const totalClasses = new Set(
  en.violations.concat(rn.violations).map(v => classOf(v.text))
    .concat(...rp.map(r => r.classes)));
const assertFails = rp.reduce((n, r) => n + r.asserts.length, 0);
log(`\nSUMMARY  controls ${driven.length}/${all.length} driven · ` +
    `enumeration violations ${en.violations.length} · random violations ${rn.violations.length} · ` +
    `repro console errors ${rp.reduce((n, r) => n + r.errors.length, 0)} · repro assertions ${assertFails} · ` +
    `distinct classes ${totalClasses.size}`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    file: FILE,
    controls: { total: all.length, driven: driven.length, notDriven: notDriven.map(([k, v]) => ({ key: k, reason: v.reason })) },
    enumeration: en.violations, random: rn.violations, repros: rp,
    distinctClasses: Array.from(totalClasses)
  }, null, 2));
}

process.exit(totalClasses.size || assertFails ? 1 : 0);
