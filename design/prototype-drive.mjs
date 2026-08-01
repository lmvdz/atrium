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
   inventory is rebuilt with the DOM.

   AND A KEY IS A CONTROL (round 13). Round 12 tagged `click`, `pointerdown` and
   `mousedown` only. Three write paths on this page are keyboard-only twins of a
   button — Enter in `#cinput` calls send(), Enter in `#vinput` calls doVerify(),
   Enter in `#rinput` calls reopen() — so all three sat outside the 226-key
   denominator entirely, and the report that counted them called itself an
   enumeration. `keydown` is tagged now, the tag records WHICH event types an
   element listens for, and the drive presses Enter on an element whose only
   listener is a key. */
const INIT = `
(() => {
  const ACTION = ["id","data-fx","data-open","data-receipt","data-rcroom","data-jump","data-jumproom",
                  "data-pin","data-reply","data-verify","data-opt","data-filter","data-scope",
                  "data-lens-obj","data-corr","data-obj","data-msg","data-bind","data-about","data-writes"];
  const TYPES = ["click", "pointerdown", "mousedown", "keydown"];
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      if (TYPES.indexOf(type) >= 0 && this instanceof Element && this !== document.documentElement) {
        const had = (this.getAttribute("data-ctl") || "").split(",").filter(Boolean);
        if (had.indexOf(type) < 0) had.push(type);
        this.setAttribute("data-ctl", had.join(","));
      }
    } catch (e) {}
    return orig.call(this, type, fn, opts);
  };
  window.__ctlKey = function (el) {
    const parts = [el.tagName.toLowerCase()];
    for (const a of ACTION) if (el.hasAttribute(a)) parts.push(a + "=" + el.getAttribute(a));
    let label = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 44);
    label = label.replace(/\\d{1,2}:\\d{2}/g, "##:##").replace(/\\b\\d+\\b/g, "#");
    const types = (el.getAttribute("data-ctl") || "").split(",").filter(Boolean).sort().join("+");
    return parts.join(" ") + " [" + types + "]" + (label ? " :: " + label : "");
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
      const types = (el.getAttribute("data-ctl") || "").split(",").filter(Boolean);
      return { i, key: window.__ctlKey(el), visible: vis, disabled: !!el.disabled,
               tag: el.tagName.toLowerCase(), types: types,
               keyOnly: types.length === 1 && types[0] === "keydown" };
    });
  };
  window.__drive = function (idx) {
    const el = document.querySelector('[data-ctl-i="' + idx + '"]');
    if (!el) return false;
    const types = (el.getAttribute("data-ctl") || "").split(",").filter(Boolean);
    if (types.length === 1 && types[0] === "keydown") {
      /* a field whose only listener is a key needs characters before Enter does
         anything — the same prefill the pointer twin gets */
      if (!el.value) el.value = "driven by the enumerator, through the key rather than the button";
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    }
    el.click();
    return true;
  };

  /* =========================================================================
   * THE WRITE ALPHABET AND THE SEQUENCE HARNESS (round 13)
   *
   * A denominator computed from one render is not a denominator over reachable
   * states. \`Ask justin instead\` is re-offered after a take-back and states a
   * value the record holds — and the control does not EXIST until two unrelated
   * objects have been cleared, because until then Q1 is a compact pin row that
   * paints only its primary action. Round 12's driver drove 219 of 225 controls
   * and did not find it. Not "could not": its greedy walk clicks whatever the
   * render painted and then a random visible control, so with the right dice it
   * would clear P1 and K2 and paint the card. What it could not do is TRY — the
   * sequence is not in its search space, only in its luck, and a denominator you
   * reach by luck is not a denominator. (That sentence began this round as "could
   * not have found it", which is a claim about reach, written from memory, in the
   * round whose whole subject is claims about reach written from memory.)
   *
   * So the alphabet is not the DOM. It is (object, action) out of the page's own
   * \`offeredActions()\`, and the harness BRINGS THE CONTROL INTO EXISTENCE
   * before driving it — switching room, forcing the pin card open, opening the
   * receipt — and then clicks the real element, so every render invariant fires
   * exactly as it would for a reader who navigated there. An offered action with
   * no reachable control anywhere is reported rather than skipped.
   *
   * WHAT THIS PASS DOES NOT COVER, SAID PLAINLY, BECAUSE THE ROUND IS ABOUT
   * CLAIMS THAT OUTRUN THEIR MECHANISM:
   *
   *   - The alphabet is WRITES. Navigation, filters, folds, receipts, replies,
   *     mark-seen and the unbound composer are not in it, and the state
   *     signature is the RECORDS — it does not distinguish two states that
   *     differ only in a seen cursor or in how many messages a room holds.
   *     Those controls are driven by passes 1 and 2, which walk the DOM; they
   *     are not enumerated to a depth.
   *   - The harness NAVIGATES BY ASSIGNMENT — it sets the open pin card and the
   *     open receipt rather than clicking its way there. The frame is one a
   *     reader can reach, and the write is a real click in it; the route to the
   *     frame is not itself driven.
   *   - Breadth beyond the per-level budget is not walked. The report prints how
   *     many states were dropped at each level and refuses to call that level
   *     covered.
   * ====================================================================== */
  window.__seqAlphabet = function () {
    const out = [];
    Object.keys(S.rooms).forEach(rk => (S.rooms[rk].objects || []).forEach(o => {
      offeredActions(o).forEach(a => out.push(rk + "/" + o.id + "/" + a));
    }));
    return out;
  };
  /* the state, as the RECORD holds it. Navigation is not part of it: the
     harness re-derives whatever frame it needs, so two paths that wrote the
     same things are the same state however the reader got there. */
  window.__seqSig = function () {
    const parts = [];
    Object.keys(S.rooms).sort().forEach(rk => (S.rooms[rk].objects || []).slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1)).forEach(o => {
        const rec = o.recorded || {};
        const f = Object.keys(rec).sort()
          .map(k => k + "=" + rec[k].map(e => String(e.value)).join(">")).join("|");
        parts.push(o.id + "{" + f + "}/" + String(o.owedTo) + "/" + (o.resolvedAt != null ? 1 : 0) +
                   "/" + (o.options || []).length);
      }));
    return parts.join(";");
  };
  const shownEl = el => { const r = el.getBoundingClientRect();
                          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  /* WHICH OBJECT A CONTROL ACTS ON — asked of the page when the page can answer,
     and worked out here when it cannot. The harness has to run against an OLDER
     build than the one it ships with, because "this check fires on the previous
     round as committed" is the only evidence that a check is a check; a harness
     that calls a function this round introduced can only ever be run forwards. */
  const owner = function (b) {
    if (typeof controlObject === "function") return controlObject(b);
    const find = x => obj(room(), x) || Object.keys(S.rooms).map(k => obj(S.rooms[k], x)).filter(Boolean)[0] || null;
    if (b.id === "cinput" || b.id === "sendBtn") return S.ui.bound ? find(S.ui.bound) : null;
    if (b.id === "vinput" || b.id === "vgo") return S.ui.verifying ? find(S.ui.verifying) : null;
    if (b.id === "rinput" || b.id === "rgo") return S.ui.reopening ? find(S.ui.reopening) : null;
    const host = b.closest("[data-obj], [data-lens-obj], [data-corr-obj], .rc-foot, .acard, .acomp, .mrow");
    const id = b.dataset.obj || b.dataset.verify ||
               (host && (host.dataset.obj || host.dataset.lensObj || host.dataset.corrObj));
    return id ? find(id) : (S.ui.receiptId ? find(S.ui.receiptId) : null);
  };
  window.__seqDrive = function (step) {
   try {
    const bits = String(step).split("/");
    const rk = bits[0], objId = bits[1], action = bits[2], driver = bits[3] || "pointer";
    if (!S.rooms[rk]) return { ok: false, why: "no such room" };
    const o = (S.rooms[rk].objects || []).filter(x => x.id === objId)[0];
    if (!o) return { ok: false, why: "no such object" };
    if (offeredActions(o).indexOf(action) < 0) return { ok: false, why: "not offered here" };
    /* a deterministic frame: the reader's navigation, done by the harness */
    if (S.roomId !== rk) switchRoom(rk, true);
    S.ui.feedFilter = null; S.ui.receiptId = null; S.ui.bound = null; S.ui.replyTo = null;
    S.ui.about = null; S.ui.verifying = null; S.ui.reopening = null; S.ui.prefill = null;
    S.ui.pinFolded = false; S.ui.lensFocus = false;
    S.ui.pinOpen = objId;
    render();
    const forO = sel => Array.prototype.filter.call(document.querySelectorAll(sel),
      b => shownEl(b) && owner(b) === o);
    const press = el => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    const openReceipt = () => { S.ui.receiptId = objId; render(); };
    let el = null;
    if (action === "opt") {
      el = forO("[data-opt]")[0] || (openReceipt(), forO("[data-opt]")[0]);
      if (!el) return { ok: false, why: "no option control" };
      el.click();
    } else if (action === "typed") {
      const bind = forO("[data-bind]")[0] || (openReceipt(), forO("[data-bind]")[0]);
      if (!bind) return { ok: false, why: "no bound-composer control" };
      bind.click();
      const input = document.getElementById("cinput");
      if (!input) return { ok: false, why: "the composer did not open" };
      input.value = "typed by the enumerator, in the reader's own words";
      if (driver === "key") press(input);
      else { const b = document.getElementById("sendBtn"); if (!b) return { ok: false, why: "no send control" }; b.click(); }
    } else if (action === "verify") {
      const v = forO("[data-verify]")[0];
      if (!v) return { ok: false, why: "no verify disclosure" };
      v.click();
      const input = document.getElementById("vinput");
      if (!input) return { ok: false, why: "the verify prompt did not open" };
      input.value = "checked against the staging rehearsal log by the enumerator";
      if (driver === "key") press(input);
      else { const b = document.getElementById("vgo"); if (!b) return { ok: false, why: "no verify submit" }; b.click(); }
    } else if (action === "reopen") {
      openReceipt();
      const rb = document.getElementById("rcReopen");
      if (!rb || owner(rb) !== o) return { ok: false, why: "the receipt offers no reopen" };
      rb.click();
      const input = document.getElementById("rinput");
      if (!input) return { ok: false, why: "the reopen prompt did not open" };
      input.value = "reopened by the enumerator, with a reason";
      if (driver === "key") press(input);
      else { const b = document.getElementById("rgo"); if (!b) return { ok: false, why: "no reopen submit" }; b.click(); }
    } else {
      el = forO('[data-fx="' + action + '"]')[0] || (openReceipt(), forO('[data-fx="' + action + '"]')[0]);
      if (!el) return { ok: false, why: "no control for this action" };
      el.click();
    }
    return { ok: true };
   } catch (e) { return { ok: false, why: "threw: " + (e && e.message) }; }
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
  await page.evaluate("window.__drive(" + Number(i) + ")");
  await page.waitForTimeout(16);
}

/* ===========================================================================
 * PASS 0 — THE SEQUENCE ENUMERATION, TO A STATED DEPTH.
 *
 * WHY THIS EXISTS. Round 12's driver reported "225 enumerated, 219 driven, 0
 * violations" and shipped two live invariant violations at depth 5, on controls
 * that do not exist until two prior writes have happened. Both numbers were
 * true. Neither was a denominator: a count of controls ON ONE RENDER is not a
 * count of controls over reachable states, and the same greedy walk enumerated
 * 226 keys on one machine and 225 on another because which keys it ever SAW
 * depended on which random control it happened to click.
 *
 * This pass walks STATES. A state is what the records hold — navigation is not
 * part of it, because the harness re-derives whatever frame it needs. Every
 * state is expanded by every (object, action) the page itself offers there, in
 * both the pointer and the keyboard form where a control has both, and each
 * transition is driven through the real DOM so every render invariant fires.
 *
 * WHAT IT REPORTS, AND WHAT IT DOES NOT. Breadth is complete while the frontier
 * fits the per-level budget and TRUNCATED, LOUDLY, when it does not: the report
 * prints the depth, the states reached at each level, and how many states were
 * left unexpanded. A truncated level is not a covered level and this says so
 * rather than quoting one number that sounds like completeness.
 * ======================================================================== */
async function seqStep(page, errors, path) {
  const errAt = errors.length;
  await page.goto(URL);
  await page.waitForFunction("typeof render === 'function'", null, { timeout: 90000 });
  const failed = [];
  for (const step of path) {
    const res = await page.evaluate(s => window.__seqDrive(s), step);
    if (!res.ok) failed.push(step + " (" + res.why + ")");
    await page.waitForTimeout(8);
  }
  const out = await page.evaluate(() => ({
    sig: window.__seqSig(),
    alphabet: window.__seqAlphabet(),
    ctls: window.__ctls().map(c => ({ key: c.key, visible: c.visible, disabled: c.disabled })),
    /* the walk's own answer to "what do you not cover", taken from the live DOM
       in every state, so the artifact this writes is the mechanism's output and
       not a recollection of it (round 13, D5) */
    uncovered: typeof window.__uncoveredRecordWords === "function"
      ? window.__uncoveredRecordWords().map(u => u.field + "  " + JSON.stringify(u.text) +
          "  [" + u.words.join(", ") + "]" + (u.control ? "  (inside a control)" : ""))
      : []
  }));
  out.failed = failed;
  out.violations = invariantsOnly(errors.slice(errAt));
  return out;
}

async function passSequences(browser, log) {
  const DEPTH = Number(argOf("--depth", "5"));
  const POOL = Number(argOf("--pool", "3"));
  const BUDGET = Number(argOf("--budget", "150"));
  /* a control has a keyboard form when the page listens for a key on it; these
     three are the write paths whose Enter handler was outside the denominator */
  const KEYED = { typed: 1, verify: 1, reopen: 1 };
  const UNCOVERED_DEPTH = 2;

  const workers = [];
  for (let i = 0; i < POOL; i++) workers.push(await newPage(browser));

  const seen = new Map();          // signature -> { depth, path }
  const drivenSteps = new Set();   // (object, action, driver) actually driven
  const offeredSteps = new Set();  // (object, action, driver) the page offered
  const unreachable = new Map();   // step -> why
  const ctlSeen = new Map();       // control key -> { visible, driven:false }
  const uncovered = new Set();     // the walk's own "what I do not cover", unioned over states
  const violations = [];
  const levels = [];

  const noteCtls = list => list.forEach(c => {
    if (!ctlSeen.has(c.key)) ctlSeen.set(c.key, { visible: false, disabled: c.disabled });
    if (c.visible && !c.disabled) ctlSeen.get(c.key).visible = true;
  });
  const stepsOf = alphabet => {
    const out = [];
    alphabet.forEach(a => {
      out.push(a + "/pointer");
      if (KEYED[a.split("/")[2]]) out.push(a + "/key");
    });
    return out;
  };

  /* level 0 */
  const root = await seqStep(workers[0].page, workers[0].errors, []);
  noteCtls(root.ctls);
  root.uncovered.forEach(u => uncovered.add(u));
  root.violations.forEach(t => violations.push({ text: t, path: [], where: "load" }));
  seen.set(root.sig, { depth: 0, path: [] });
  let frontier = [{ sig: root.sig, path: [], steps: stepsOf(root.alphabet), fresh: root.ctls.length }];
  levels.push({ depth: 0, states: 1, expanded: 1, truncated: 0, transitions: 0 });
  log(`  depth 0: 1 state · ${root.alphabet.length} (object, action) pairs offered`);

  for (let d = 1; d <= DEPTH && frontier.length; d++) {
    /* WHICH STATES TO EXPAND WHEN THE FRONTIER DOES NOT FIT. Not the first N by
       signature — that is arbitrary, and an arbitrary sample of a level is the
       weakest thing a bounded search can do. States are ranked by how many
       control keys they paint that no state has painted yet, so the budget is
       spent bringing NEW CONTROLS into existence, which is the failure this pass
       exists for. Ties break on the signature, so the run is deterministic.
       `fresh` is counted when a state is DISCOVERED, against what was known
       before its own level ran. Reading it here would return zero for every
       state, because this level's noteCtls() has already marked them all seen —
       which is what the first version of this ranking did: an ordering that
       claimed to prefer novelty and did not. The round's own defect class, in
       the round's own instrument, caught by reading its own diff. */
    const ordered = frontier.slice().sort((a, b) =>
      ((b.fresh || 0) - (a.fresh || 0)) || (a.sig < b.sig ? -1 : 1));
    /* the levels the committed uncovered-set artifact is taken from are NEVER
       truncated, whatever the budget: a generated file whose contents depend on
       how far a particular run got cannot be compared against a later run, and
       "the committed file must match the live walk" would be a coin toss rather
       than a check. Complete breadth at depths 1 and 2 is the guarantee the
       artifact rests on, so the budget starts applying below it. */
    const levelBudget = d <= UNCOVERED_DEPTH ? Infinity : BUDGET;
    const expand = ordered.slice(0, levelBudget);
    const truncated = ordered.length - expand.length;
    const jobs = [];
    expand.forEach(st => st.steps.forEach(step => {
      offeredSteps.add(step);
      jobs.push({ path: st.path.concat([step]), step });
    }));
    const results = [];
    let next = 0;
    await Promise.all(workers.map(async w => {
      for (;;) {
        const k = next++;
        if (k >= jobs.length) return;
        const j = jobs[k];
        const r = await seqStep(w.page, w.errors, j.path);
        results.push({ j, r });
        if (results.length % 200 === 0) log(`     ... ${results.length}/${jobs.length} transitions at depth ${d}`);
      }
    }));
    const nextFrontier = [];
    /* the novelty ranking is computed against what was known BEFORE this level,
       so every child of this level is ranked on the same footing */
    results.forEach(({ j, r }) => { r.fresh = r.ctls.filter(c => !ctlSeen.has(c.key)).length; });
    results.forEach(({ j, r }) => {
      noteCtls(r.ctls);
      /* THE ARTIFACT IS TAKEN FROM A FIXED SET OF STATES, not from however far
         this particular run got. The union over depths 0..UNCOVERED_DEPTH is
         complete breadth at any budget above the level-2 frontier, so the
         committed file is reproducible by anyone who runs the driver with any
         --depth >= 2 — which is what makes "the committed file must match the
         live walk" a check rather than a coin toss. */
      if (d <= UNCOVERED_DEPTH) r.uncovered.forEach(u => uncovered.add(u));
      if (r.failed.length) r.failed.forEach(f => unreachable.set(f.split(" (")[0], f));
      else drivenSteps.add(j.step);
      r.violations.forEach(t => violations.push({ text: t, path: j.path.slice(), where: "sequence d" + d }));
      if (seen.has(r.sig)) return;
      seen.set(r.sig, { depth: d, path: j.path });
      nextFrontier.push({ sig: r.sig, path: j.path, steps: stepsOf(r.alphabet), fresh: r.fresh });
    });
    levels.push({ depth: d, states: nextFrontier.length, expanded: expand.length,
                  truncated, transitions: jobs.length });
    log(`  depth ${d}: ${jobs.length} transitions driven from ${expand.length} state(s)` +
        (truncated ? ` (${truncated} state(s) left unexpanded — frontier budget ${BUDGET})` : " (complete breadth)") +
        ` → ${nextFrontier.length} new state(s)`);
    frontier = nextFrontier;
  }

  for (const w of workers) await w.ctx.close();
  return { seen, levels, violations, drivenSteps, offeredSteps, unreachable, ctlSeen, uncovered,
           depth: DEPTH, budget: BUDGET };
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

/* ===========================================================================
 * PASS 3 — THE SCRIPTED REPROS. Each one is a named path, and EACH ONE FIRES
 * ON fix/prototype-frame-r12 AS COMMITTED. That is the whole of their value: a
 * check written after the fix, against the fixed build, measures nothing. Run
 * them against the previous round with --file and quote the count.
 * ======================================================================== */
const REPROS = [
  {
    /* ROUND 13, D1. Five deliberate clicks. The last control does not EXIST
       until the first two have cleared P1 and K2, because until then Q1 is a
       compact pin row and pinActions(o, primaryOnly) paints one button. That is
       why round 12's driver — which enumerated what each render happened to
       paint — drove 219 controls and could not have reached it. */
    id: "R13-D1-reassign-names-a-recorded-value",
    what: "hand Q1 on, take it back, and the re-offered control names a value the assignee history holds",
    async run(page) {
      if (!await clickText(page, "Keep dual-write through 14 Aug")) return "P1's answer not offered";
      if (!await clickText(page, "Mark signed off")) return "K2's sign-off not offered";
      if (!await clickText(page, "Ask justin instead")) return "reassign not offered";
      if (!await clickText(page, "Does legal approve")) return "Q1 not reachable after the hand-off";
      if (!await clickText(page, "Take it back")) return "nothing takes it back";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const q = obj(room(), "Q1");
        if (!q) return ["Q1 is not in this room"];
        const out = [];
        const hist = (q.recorded.assignee || []).map(e => e.value);
        if (hist.length < 3) out.push("the round trip did not land: assignee history is " + JSON.stringify(hist));
        /* AND THE SAME QUESTION ASKED OF THE DOM. A control inside a declared
           subject that prints a value that record holds is either read out of it
           or declares — and proves — that it is about to write it. */
        const bad = [];
        document.querySelectorAll('[data-obj="Q1"] button, [data-lens-obj="Q1"] button').forEach(b => {
          if (b.querySelector("[data-said], [data-said-parts]") || b.closest("[data-said], [data-said-parts]")) return;
          const t = (b.textContent || "").toLowerCase();
          hist.forEach(v => {
            if (typeof v !== "string" || !v) return;
            if (!new RegExp("(^|[^\\w-])" + v.toLowerCase() + "($|[^\\w-])").test(t)) return;
            if (b.hasAttribute("data-writes")) return;      // declares it, and the page proves it
            bad.push('a control inside Q1 says ' + JSON.stringify(v) + ' — a value the assignee history holds — ' +
                     'without reading it and without declaring that it writes it: ' + JSON.stringify(b.textContent.trim()));
          });
        });
        return out.concat(Array.from(new Set(bad)));
      });
    }
  },
  {
    /* ROUND 13, D2. The same class round 12 fixed in answerDecision, in the
       function beside it. */
    id: "R13-D2-reanswer-verbatim",
    what: "answer, reopen, answer the same thing — the verbatim branch reads the answer it says did not change",
    async run(page) {
      if (!await clickText(page, "Answer — retention is 90 days")) return "the one-click answer is not offered";
      if (!await clickText(page, "Does legal approve")) return "Q1's lens item not found";
      if (!await clickText(page, "Reopen")) return "the receipt offers no Reopen";
      if (!await clickText(page, "Reopen")) return "the reopen prompt did not submit";
      if (!await clickText(page, "Answer — retention is 90 days")) return "the answer is not offered again";
      return null;
    }
  },
  {
    /* ROUND 13, D3. Two counts of the same thing on one screen. Measured in the
       DOM, so it does not depend on either build shipping the checker. */
    id: "R13-D3-two-unverified-counts",
    what: "the lens and the pin trailer count unverified over the same records and agree",
    async run(page) {
      await clickText(page, "Keep dual-write through 14 Aug");
      await clickText(page, "Mark signed off");
      await clickText(page, "Ask justin instead");
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const lens = (document.getElementById("lensSummary") || {}).textContent || "";
        const trail = (document.getElementById("pinTrailer") || {}).textContent || "";
        const a = lens.match(/(\d+)\s+unverified/);
        const b = trail.match(/(\d+)\s+of\s+(\d+)\s+unverified/);
        const owed = (typeof attention === "function") ? attention(room()).length : null;
        if (!a || !b) return out;
        /* the trailer's scope is the records outside the pin; when nothing is
           owed the two scopes are identical and the counts must be too */
        if (owed === 0 && Number(a[1]) !== Number(b[1]))
          out.push('the lens says "' + a[0] + '" and the pin trailer says "' + b[0] + '" over the same ' +
                   b[2] + " records, with nothing owed, so there is no scope difference to explain it");
        return out;
      });
    }
  },
  {
    /* ROUND 13, D4. The caveat was conditioned on whether anything was owed
       rather than on whether an overlap existed. */
    id: "R13-D4-overlap-caveat",
    what: "an objective header whose objects also sit elsewhere says so, owed or not",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const r = room();
        r.objectives.forEach(ob => {
          const mine = r.objects.filter(o => o.objectives.includes(ob.id));
          const overlap = mine.filter(o => o.objectives.length > 1).length;
          if (!overlap) return;
          const head = document.querySelector('[data-objective="' + ob.id + '"]');
          if (!head) return;
          const said = (head.title || "") + " " + (head.textContent || "");
          if (!/overlap|also sit|of the \d+|of \d+ objects/i.test(said))
            out.push('"' + ob.title + '" has ' + overlap + " object(s) that also sit under another objective and " +
                     "nothing on it — text or accessible name — says the counts overlap: " + JSON.stringify(said.trim().slice(0, 90)));
        });
        return out;
      });
    }
  },
  {
    /* ROUND 13, D6. A count that speaks for records, painted with no declared
       subject and no mint, is a count no instrument on this page can see. */
    id: "R13-D6-aggregates-declare-a-subject",
    what: "every on-screen count of records is minted or declares whose records it counts",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const named = { surfNeedsN: "the NEEDS YOU tab", surfStateN: "the CURRENT STATE tab" };
        Object.keys(named).forEach(id => {
          const el = document.getElementById(id);
          if (!el) return;
          if (!el.closest("[data-said], [data-said-parts], [data-obj], [data-agg]"))
            out.push(named[id] + " counts records and sits inside no mint and no declared subject: " +
                     JSON.stringify((el.textContent || "").trim()));
        });
        /* THE MINT CAN BE A DESCENDANT, NOT ONLY AN ANCESTOR (round 13
           self-review — this assertion fired on this round's own build, and the
           assertion was the thing that was wrong). The rail badge is a glyph
           plus a number, and only the NUMBER is a claim about records: closest()
           asks whether the whole badge sits inside a mint, which it does not and
           should not. The question is whether the digits do. */
        document.querySelectorAll("#railRooms .pill").forEach(p => {
          const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
          let n;
          while ((n = w.nextNode())) {
            if (!/\d/.test(n.nodeValue)) continue;
            if (n.parentElement.closest("[data-said], [data-said-parts], [data-obj], [data-agg]")) continue;
            out.push("a rail owed badge counts records and its digits sit inside no mint and no declared subject: " +
                     JSON.stringify((p.textContent || "").trim()));
          }
        });
        return out;
      });
    }
  },
  {
    /* ROUND 13, D7. One open receipt certified the tier for every reopenable
       object in the file, because the lookup was a bare document.querySelector. */
    id: "R13-D7-friction-tier-is-per-object",
    what: "a friction tier is credited for the object whose control was inspected, not globally",
    async run(page) {
      if (!await clickText(page, "Dual-write stays on until parity")) return "D1's lens item not found";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        if (typeof window.__frictionTiers !== "function") return ["the page reports no friction tiers"];
        const t = window.__frictionTiers();
        const open = S.ui.receiptId;
        (t.verified || []).forEach(k => {
          if (k.indexOf("|") < 0)
            return out.push('a friction tier is credited as "' + k + '" with no object — one control anywhere ' +
                            "certifies this action for every object in every room");
          const who = k.split("|")[0], tier = k.split("|")[2];
          if (tier === "2" && who !== open)
            out.push('tier 2 is credited for ' + who + ' while the open receipt is ' + open +
                     " — the control that was inspected does not belong to that object");
        });
        return out;
      });
    }
  },
  {
    /* ROUND 13, D8. The projection was a click behind the write, and the check
       that was supposed to catch that iterated the table's own keys. */
    id: "R13-D8-projection-matches-the-write",
    what: "what the page predicts a reopen offers is what it offers after the reopen",
    async run(page) {
      const before = await page.evaluate(() => offeredAfter(obj(room(), "D1"), "reopen"));
      await page.evaluate(() => { window.__predicted = null; });
      await page.evaluate(b => { window.__predicted = b; }, before);
      if (!await clickText(page, "Dual-write stays on until parity")) return "D1's lens item not found";
      if (!await clickText(page, "Reopen")) return "the receipt offers no Reopen";
      if (!await clickText(page, "Reopen")) return "the reopen prompt did not submit";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const got = offeredActions(obj(room(), "D1")).slice().sort().join(",");
        const want = (window.__predicted || []).slice().sort().join(",");
        return got === want ? []
          : ['offeredAfter(D1,"reopen") predicted [' + want + "] and the reopen actually offers [" + got +
             "] — the reversibility audit projects from that prediction"];
      });
    }
  },
  {
    /* ROUND 13, D9. The splitter treated the page's own intra-sentence
       separator as a clause boundary, so any sentence in house style was
       exempt from the pairing rule by construction. */
    id: "R13-D9-house-style-is-not-an-exemption",
    what: "a middot run whose quantifier names no field of its own is checked as one clause",
    async run(page) {
      await clickText(page, "Answer — retention is 90 days");
      await clickText(page, "Does legal approve");
      await clickText(page, "Reopen");
      await clickText(page, "Reopen");
      await clickText(page, "Answer — retention is 90 days");
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const probe = "superseded answer · replaced 09:17 · kept on the record";
        if (typeof clausesOf === "function") {
          const cl = clausesOf(probe);
          if (!cl.some(c => /answer/.test(c) && /kept/.test(c)))
            out.push("clausesOf() puts a field's own word and the quantifier about it in different clauses, so the " +
                     "pairing rule cannot see them together: " + JSON.stringify(cl));
        }
        /* and the row itself: a permanent feed row that states a field and a
           continuity quantifier is read out of the record or it is a literal */
        document.querySelectorAll("#feed .tag").forEach(el => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!/supersed/i.test(t)) return;
          if (!el.querySelector("[data-said], [data-said-parts]"))
            out.push("the superseded-answer row tag is a literal: " + JSON.stringify(t));
        });
        return out;
      });
    }
  },
  {
    /* ROUND 13, D10. Four permanently-disabled zero chips and a two-clause
       disclaimer explaining the zeros — the shape round 12's own prune doctrine
       names, one column left of the pane round 12 pruned. */
    id: "R13-D10-no-zero-chips",
    what: "no divider paints a chip that filters nothing, or a disclaimer explaining a zero",
    async run(page) {
      await clickText(page, "Keep dual-write through 14 Aug");
      await clickText(page, "Mark signed off");
      await clickText(page, "Answer — retention is 90 days");
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll(".syl .cnt").forEach(b => {
          const t = (b.textContent || "").trim();
          if (/^0\b/.test(t) || b.disabled)
            out.push("a divider paints a chip that filters nothing: " + JSON.stringify(t) + (b.disabled ? " [disabled]" : ""));
        });
        document.querySelectorAll(".syl .when").forEach(w => {
          const t = (w.textContent || "").replace(/\s+/g, " ").trim();
          if (/\b0 unseen\b/.test(t) && /never counted back to you/.test(t))
            out.push("a divider prints a zero and then two clauses explaining the zero: " + JSON.stringify(t.slice(0, 120)));
        });
        return out;
      });
    }
  },
  {
    /* ROUND 12's D8, kept as a regression: a permanent feed row's state tag is
       minted, not a value copied off the object. */
    id: "R12-D8-row-state-tags",
    what: "every feed-row state tag is minted, not a value copied off the object",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("#feed .tag").forEach(el => {
          const host = el.closest("[data-obj], [data-lens-obj]");
          if (!host) return;
          const o = obj(room(), host.dataset.obj || host.dataset.lensObj) || null;
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
    /* ROUND 12's D6b, kept as a regression: the take-back round trip. */
    id: "R12-D6b-takeback-round-trip",
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
        const q = obj(room(), "Q1");
        if (!q) return ["Q1 is not in this room"];
        const out = [];
        if (q.owedTo !== S.me) out.push("taking it back did not put it back on your list: owedTo=" + q.owedTo);
        if ((q.recorded.assignee || []).length < 3)
          out.push("the hand-off and the take-back are not both on the record: " +
                   JSON.stringify((q.recorded.assignee || []).map(e => e.value)));
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

const docFails = [];

const browser = await chromium.launch();
log(`driving ${FILE}`);

log("\n[0] write-sequence enumeration over reachable states");
const sq = await passSequences(browser, log);
log(`  invariant violations during sequence enumeration: ${sq.violations.length}`);
{
  const cls = new Map();
  sq.violations.forEach(v => { const c = classOf(v.text); if (!cls.has(c)) cls.set(c, v); });
  cls.forEach((v, c) => { log(`     ${c}`); log(`        path: ${v.path.join("  →  ") || "(on load)"}`); });
}
{
  const notDriven = Array.from(sq.offeredSteps).filter(s => !sq.drivenSteps.has(s)).sort();
  log(`  (object, action, driver) steps offered: ${sq.offeredSteps.size} · driven: ${sq.drivenSteps.size}`);
  if (notDriven.length) {
    log(`  OFFERED BUT NOT DRIVEN — an action the page offers with no control the harness could reach:`);
    notDriven.forEach(s => log(`     - ${s}   [${sq.unreachable.get(s) || "no reason recorded"}]`));
  }
}

/* --- THE CLAIM ABOUT REACH, GENERATED (round 13, D5) -----------------------
   Three rounds running, the mechanism was real and the sentence describing what
   it produces was written from memory. So the sentence is not written any more:
   this is the walk's own output, unioned over every state the enumeration
   reached, sorted, and committed beside the page. The comment in the page cites
   this file and names no examples of its own. */
const UNCOVERED_OUT = argOf("--uncovered", "");
const uncoveredLines = Array.from(sq.uncovered).sort();
{
  const wanted = path.join(HERE, "prototype-uncovered.txt");
  const header =
    "# WHAT THE RECORD WALK DOES NOT COVER — generated, do not hand-edit.\n" +
    "#\n" +
    "# Produced by window.__uncoveredRecordWords() in design/prototype-frame.html,\n" +
    "# unioned over every state design/prototype-drive.mjs reaches, and regenerated by\n" +
    "#   node design/prototype-drive.mjs --uncovered design/prototype-uncovered.txt\n" +
    "#\n" +
    "# Each row is page-authored text that uses a recorded field's own vocabulary and\n" +
    "# sits inside no declared subject and no mint. It is not an error list. It is the\n" +
    "# answer to \"what is uncovered\", computed rather than recalled.\n" +
    "#\n" +
    "# subject: the union over every state reachable in 0, 1 or 2 writes — complete\n" +
    "# breadth at those depths, so this file does not depend on how far a run got.\n" +
    "#\n" +
    `# rows: ${uncoveredLines.length}\n`;
  const body = header + uncoveredLines.map(l => l + "\n").join("");
  if (UNCOVERED_OUT) { fs.writeFileSync(UNCOVERED_OUT, body); log(`\n  wrote ${UNCOVERED_OUT} (${uncoveredLines.length} row(s))`); }
  /* AND THE COMMITTED CLAIM IS COMPARED AGAINST THE LIVE ONE. A generated file
     that nobody re-generates is a remembered list with extra steps. */
  const committed = fs.existsSync(wanted) ? fs.readFileSync(wanted, "utf8") : null;
  if (committed == null) {
    log(`\n  UNCOVERED-SET ARTIFACT MISSING: ${wanted} does not exist — the enumerator's reach is claimed in a ` +
        `comment and written down nowhere, which is the exact shape of the last three rounds' false claims`);
    docFails.push("the uncovered-set artifact is missing");
  } else {
    const live = uncoveredLines.join("\n");
    const have = committed.split("\n").filter(l => l && l[0] !== "#").join("\n");
    if (live !== have) {
      log(`\n  UNCOVERED-SET ARTIFACT IS STALE: the committed file and the live walk disagree`);
      const liveSet = new Set(uncoveredLines), haveSet = new Set(have.split("\n").filter(Boolean));
      uncoveredLines.filter(l => !haveSet.has(l)).forEach(l => log(`     + live only: ${l}`));
      Array.from(haveSet).filter(l => !liveSet.has(l)).forEach(l => log(`     - file only: ${l}`));
      docFails.push("the uncovered-set artifact does not match the live walk");
    } else {
      log(`\n  uncovered-set artifact matches the live walk (${uncoveredLines.length} row(s))`);
    }
  }
  /* AND THE PAGE'S OWN COMMENT MAY NOT NAME AN EXAMPLE. Every backticked string
     in the uncoveredRecordWords doc block that reads like page text is a claim
     about what this walk produces, and it is checked against what it produces.
     Round 12's block named five families and not one of them could ever appear:
     the first is rejected by the walker's own declared-subject guard and the
     rest are bare integers with no recorded vocabulary. */
  const src = fs.readFileSync(FILE, "utf8");
  const block = (src.split("AND WHAT THE WALK DOES NOT COVER")[1] || "").split("function uncoveredRecordWords")[0];
  const quoted = Array.from(block.matchAll(/`([^`]{4,})`/g)).map(m => m[1])
    .filter(q => !/^[\w.$/#(){}\[\]:=\-]+$/.test(q));      // an identifier or a path is not page text
  const liveText = uncoveredLines.join("\n");
  const bogus = quoted.filter(q => liveText.indexOf(q) < 0);
  if (bogus.length) {
    log(`  A COMMENT NAMES ${bogus.length} EXAMPLE(S) THIS WALK DOES NOT PRODUCE:`);
    bogus.forEach(q => log(`     - ${JSON.stringify(q)}`));
    docFails.push(`the uncovered-set comment names ${bogus.length} example(s) the walk cannot produce`);
  } else if (quoted.length) {
    log(`  the uncovered-set comment names ${quoted.length} example(s), all present in the live walk`);
  } else {
    log(`  the uncovered-set comment names no examples of its own — it cites the generated file`);
  }
}

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
  sq.violations.concat(en.violations, rn.violations).map(v => classOf(v.text))
    .concat(...rp.map(r => r.classes)));
const assertFails = rp.reduce((n, r) => n + r.asserts.length, 0);

/* THE CONTROL INVENTORY IS THE UNION OVER EVERY STATE VISITED, not the keys one
   greedy walk happened to see. Round 12 reported 226 and a second run of the
   same script on another machine enumerated 225: the walk picked a random
   visible control whenever it had nothing new, so the inventory was a function
   of the seed. A union over a deterministic breadth-first state walk is stable
   and monotone, and it is a different number from "controls driven" and from
   "states reached" — three numbers, because they are three facts. */
const inventory = new Map();
sq.ctlSeen.forEach((v, k) => inventory.set(k, { visible: v.visible, driven: false }));
all.forEach(([k, v]) => {
  if (!inventory.has(k)) inventory.set(k, { visible: v.visible, driven: false });
  if (v.driven) inventory.get(k).driven = true;
});
const drivenKeys = Array.from(inventory.values()).filter(v => v.driven).length;
const statesReached = sq.seen.size;
const truncatedLevels = sq.levels.filter(l => l.truncated);

log(`\nSUMMARY`);
log(`  controls enumerated (union over every state reached): ${inventory.size}`);
log(`  controls driven:                                      ${drivenKeys}`);
log(`  states reached at depth ${sq.depth}:${" ".repeat(Math.max(1, 29 - String(sq.depth).length))}${statesReached}`);
log(`  write steps offered / driven: ${sq.offeredSteps.size} / ${sq.drivenSteps.size}`);
sq.levels.forEach(l => log(`     depth ${l.depth}: ${l.states} new state(s) from ${l.transitions} transition(s)` +
  (l.truncated ? ` · ${l.truncated} state(s) LEFT UNEXPANDED (budget ${sq.budget})` : "")));
if (truncatedLevels.length)
  log(`  BREADTH IS NOT COMPLETE at depth ${truncatedLevels.map(l => l.depth).join(", ")} — ` +
      `${truncatedLevels.reduce((n, l) => n + l.truncated, 0)} state(s) were never expanded. ` +
      `This is a sampled level, not a covered one.`);
else
  log(`  breadth is complete at every depth up to ${sq.depth}`);
{
  const undriven = Array.from(inventory.entries()).filter(([, v]) => !v.driven);
  log(`  THE UNEXERCISED SET (${undriven.length}):`);
  undriven.forEach(([k, v]) => log(`     - ${k}   [${v.visible ? "reachable, never selected" : "never on screen"}]`));
}
if (docFails.length) log(`  DOCUMENTATION CHECKS FAILED (${docFails.length}): ${docFails.join(" · ")}`);
log(`  violations — sequence ${sq.violations.length} · enumeration ${en.violations.length} · ` +
    `random ${rn.violations.length} · repro console ${rp.reduce((n, r) => n + r.errors.length, 0)} · ` +
    `repro assertions ${assertFails} · distinct classes ${totalClasses.size}`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    file: FILE,
    controls: { enumerated: inventory.size, driven: drivenKeys,
                unexercised: Array.from(inventory.entries()).filter(([, v]) => !v.driven).map(([k, v]) => ({ key: k, visible: v.visible })) },
    sequences: { depth: sq.depth, budget: sq.budget, statesReached, levels: sq.levels,
                 stepsOffered: Array.from(sq.offeredSteps).sort(),
                 stepsNotDriven: Array.from(sq.offeredSteps).filter(s => !sq.drivenSteps.has(s)).sort() },
    sequenceViolations: sq.violations, enumeration: en.violations, random: rn.violations, repros: rp,
    distinctClasses: Array.from(totalClasses)
  }, null, 2));
}

process.exit(totalClasses.size || assertFails || docFails.length ? 1 : 0);
