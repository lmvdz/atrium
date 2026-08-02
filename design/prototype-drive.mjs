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
 * fire on the PREVIOUS round as committed and be silent after.
 *
 * AND EVERY NUMBER IT REPORTS IS A NUMBER ABOUT A VIEWPORT (round 14, D2). It
 * used to be one viewport, hard-coded, unnamed — see WIDTHS below.
 *
 * Usage:
 *   node design/prototype-drive.mjs [--file <path>] [--depth N] [--random N]
 *                                   [--widths 1440,1279,1024] [--height 900]
 *                                   [--only repros|occlusion] [--json out]
 *                                   [--uncovered <path>] [--counts <path>]
 *
 * Point it at the previous round and quote the count:
 *   node design/prototype-drive.mjs --only repros --file /tmp/r13.html
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

/* --- THE VIEWPORT IS PART OF THE DENOMINATOR (round 14, D2) ----------------
 * Round 13 reported controls, states and depths and every one of those numbers
 * was a number about 1440×900, because `newPage()` hard-coded it — as did
 * prototype-shot.mjs, prototype-probe.mjs and prototype-smoke.mjs. A live
 * invariant violation existed at every supported width at or below 1279 — the
 * rail painting `# users-migra…`, a control's own label in an ellipsis, on the
 * room you are standing in, BECAUSE you had cleared your work — and it survived
 * thirteen rounds and six reviewers driving the page, silent from 1280 up.
 *
 * So the width is a declared set, not a constant. The enumeration still runs at
 * one width (a state walk at N widths is N times the work for the same states),
 * and every OTHER pass — the deliberate enumeration, the random drive and every
 * scripted repro — runs at each width in this set, which is what makes the
 * report's numbers say which viewports they are about.
 *
 * WHICH WIDTHS, AND WHY THE FLOOR IS 1120. The layout has two breakpoints, at
 * 1440 and 1280, so the set has a member on each side of each of them. The last
 * member is the narrowest width the page actually supports, and that number was
 * MEASURED rather than assumed: below 1120 the three-column grid stops shrinking
 * and pushes the lens off the right edge — `documentElement.scrollWidth` stays at
 * 1120 in a 1024px window, on r13 and r12 as well as here. Driving 1024 would be
 * driving a viewport the page has never fitted, and reporting numbers about it
 * would be the same error as reporting numbers about 1440 alone. The page asserts
 * the floor itself now (checkViewportFitInvariant), so it cannot rise in silence.
 * ------------------------------------------------------------------------- */
/* `--only repros` runs pass 3 alone, which is how a repro suite is pointed at the
   PREVIOUS round's build without paying for a state walk of it. Every repro here
   must fire on fix/prototype-frame-r13 as committed; that claim is only worth
   something if re-running it is cheap. */
const ONLY = argOf("--only", "");
const WIDTHS = String(argOf("--widths", "1440,1366,1279,1160,1120")).split(",").map(Number).filter(Boolean);
const HEIGHT = Number(argOf("--height", "900"));
const SEQ_WIDTH = Number(argOf("--seq-width", String(WIDTHS[0])));

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

/* ===========================================================================
 * WHAT IS PAINTED, AGAINST WHAT IS LAID OUT (round 16, D1 and D2)
 *
 * The third question, and the one three instruments and fifteen rounds could
 * not ask. `scrollWidth === clientWidth` held on both of round 16's defects:
 * NOTHING WAS CLIPPED, it was PAINTED OVER, and occlusion happens entirely
 * outside the question "does this text overflow its own box". The reachability
 * rule could not see it either, and that is the interesting half: the rule is
 * stated as a pair and the pair is complete — a control you can see must be
 * reachable, a control you cannot see must not be touchable — and BOTH HALVES
 * PASS on an element that is 70% covered, because the occluder is itself
 * visible and itself reachable.
 *
 *   THE RULE: a control or a sentence you can see must not be painted over by
 *   another element you can also see.
 *
 * HOW IT IS MEASURED. Per PAINTED CHARACTER, not per box. Every text node the
 * page is painting gets a Range per character; the character's own centre is
 * put to `document.elementFromPoint`; and if what answers is neither the
 * character's owner nor inside it, and is itself visible, and `paintsAbove()`
 * agrees that it really is on top (the hit test only NOMINATES — see (c)), and
 * something between it and the two elements' common ancestor actually paints (a
 * background with alpha, or a background image — an element that paints nothing
 * hides nothing), then that character is covered and the finding names it.
 * A box test would
 * have reported the 2px of `.acts` that overhangs m10's line and would have
 * missed nothing that matters; a character test says `Eyeballed off last week's
 * b|ill — that's not|` and quotes the 14 characters a reader lost.
 *
 * WHY IT LIVES IN THE HARNESS AND NOT ON THE PAGE. The strip is painted only
 * while a row is HOVERED. A render-time checker has no hover to look at, so a
 * page-side version of this rule would be a fourth instrument that cannot see
 * the class it was built for — which is this file's own "a wrong instrument
 * invents defects" failure, arriving inside the fix for something else. The
 * harness has a real mouse. It is also why there is ONE implementation: it is
 * injected into whatever build `--file` points at, so r15 as committed and r16
 * are measured by identical code, which is the whole value of a repro.
 *
 * WHAT IT ENUMERATES FROM, said plainly rather than discovered next round.
 *   - THE OCCLUDER SET is every visible element that is `position: absolute |
 *     fixed | sticky`, or carries a positive `z-index`. That is the set that can
 *     paint over a sibling without the layout knowing. A text run is only
 *     sampled per character if one of its line rects intersects one of those.
 *   - THE COVERED SET is every text node under `<body>` that is displayed, not
 *     transparent, and not inside `script/style/template`. Characters whose
 *     centre falls outside their own element's visible box — scrolled out of a
 *     pane, or off the viewport — are counted as not painted and skipped.
 *   - THE STATES are whatever the caller drives. Pass 4 hovers every message row
 *     and then every on-screen control, at every declared width, in both themes.
 *
 * AND WHAT IT DOES NOT COVER.
 *   (a) IN-FLOW OVERLAP IS INVISIBLE TO IT. Two static boxes made to overlap by
 *       a negative margin, a transform, or a collapsed track are not in the
 *       occluder set. checkLayoutInvariant() catches that shape for `.center`'s
 *       own children and for nothing else.
 *   (b) IT ONLY SEES CHARACTERS. An icon, a rule, a chart, a focus ring or a
 *       border painted over by an overlay is not text and is not reported.
 *   (c) IT ASKS elementFromPoint FOR A CANDIDATE, so an overlay that is itself
 *       `pointer-events: none` is never nominated and never reported, however
 *       opaquely it paints. The toast is exactly that shape — and it is the
 *       COVERED side there, which `paintsAbove()` now gets right; it is the
 *       covering side that this cannot see. Nothing on this page covers text
 *       while refusing the pointer today.
 *   (c2) AND `paintsAbove()` IS AN APPROXIMATION OF THE PAINTING ALGORITHM,
 *       resolved at the two elements' common ancestor rather than through every
 *       stacking context between them. A z-index on an intermediate ancestor
 *       that reorders the branches would be read wrong.
 *   (d) IT IS A SAMPLE OF ONE POINT PER CHARACTER — the centre. A sliver of an
 *       overlay crossing the top 2px of a glyph does not fire.
 *   (e) IT CANNOT SEE A STATE NOBODY DRIVES. Pass 4's denominator is the rows
 *       and controls on screen at load, not every state the walk reaches.
 * ======================================================================== */
const OCCL = `
window.__occl = function () {
  var MINOP = 0.05;
  function cs(el) { return getComputedStyle(el); }
  function effOp(el) {
    var o = 1;
    for (var p = el; p && p.nodeType === 1; p = p.parentElement) o *= Number(cs(p).opacity);
    return o;
  }
  function shown(el) {
    for (var p = el; p && p.nodeType === 1; p = p.parentElement) {
      var s = cs(p);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
    return true;
  }
  /* a character scrolled out of its own pane is not painted, and asking
     elementFromPoint about it answers a question nobody asked */
  function visibleBox(el) {
    var r = el.getBoundingClientRect();
    var b = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (var p = el.parentElement; p && p.nodeType === 1; p = p.parentElement) {
      var s = cs(p);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      var pr = p.getBoundingClientRect();
      b.left = Math.max(b.left, pr.left); b.top = Math.max(b.top, pr.top);
      b.right = Math.min(b.right, pr.right); b.bottom = Math.min(b.bottom, pr.bottom);
    }
    b.left = Math.max(b.left, 0); b.top = Math.max(b.top, 0);
    b.right = Math.min(b.right, window.innerWidth); b.bottom = Math.min(b.bottom, window.innerHeight);
    return b;
  }
  var ALPHA = /rgba?\\(\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*(?:,\\s*([\\d.]+)\\s*)?\\)/;
  function paints(el) {
    var s = cs(el);
    if (s.backgroundImage && s.backgroundImage !== "none") return true;
    var m = ALPHA.exec(s.backgroundColor || "");
    return !!(m && (m[1] === undefined || Number(m[1]) > 0.05));
  }
  /* AND WHAT elementFromPoint ANSWERS IS NOT PAINT ORDER — it is hit order, and
     the two differ wherever \`pointer-events: none\` does. The toast is
     \`z-index: 40; pointer-events: none\`: it is painted OVER the feed and the
     hit test looks straight through it, so the first cut of this rule reported
     that a message row was covering the toast's own words. That is the
     "a wrong instrument invents defects" failure, caught on this rule's first
     run against the previous round. So the hit test only NOMINATES a candidate,
     and this decides: find the two elements' common ancestor, take the branch
     each one descends from, and compare those two siblings the way the painting
     algorithm does — z-index first, then positioned over in-flow, then document
     order. It is an approximation (it reads one level, at the common ancestor,
     rather than resolving every stacking context between), and it is the level
     at which every overlay on this page is decided. */
  function zRank(el) {
    var s = cs(el);
    if (s.zIndex !== "auto" && !isNaN(Number(s.zIndex))) return Number(s.zIndex);
    return s.position !== "static" ? 0.5 : 0;
  }
  function paintsAbove(a, b) {
    var anc = a;
    while (anc && !anc.contains(b)) anc = anc.parentElement;
    if (!anc || anc === a || anc === b) return false;
    var ba = a; while (ba.parentElement && ba.parentElement !== anc) ba = ba.parentElement;
    var bb = b; while (bb.parentElement && bb.parentElement !== anc) bb = bb.parentElement;
    if (ba === bb) return false;
    var za = zRank(ba), zb = zRank(bb);
    if (za !== zb) return za > zb;
    return !!(bb.compareDocumentPosition(ba) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  var overlays = [], all = document.querySelectorAll("body *");
  for (var i = 0; i < all.length; i++) {
    var el = all[i], s = cs(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    var pos = s.position;
    if (!(pos === "absolute" || pos === "fixed" || pos === "sticky") &&
        !(s.zIndex !== "auto" && Number(s.zIndex) > 0)) continue;
    if (effOp(el) < MINOP) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) continue;
    overlays.push({ el: el, r: r });
  }

  var findings = [], chars = 0, tested = 0;
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      var p = n.parentElement;
      if (!p || p.closest("script, style, template, title")) return NodeFilter.FILTER_REJECT;
      if (!String(n.nodeValue).trim()) return NodeFilter.FILTER_REJECT;
      if (!shown(p) || effOp(p) < MINOP) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var rng = document.createRange(), n;
  while ((n = w.nextNode())) {
    var owner = n.parentElement;
    rng.selectNodeContents(n);
    var lines = rng.getClientRects(), reachable = false;
    for (var L = 0; L < lines.length && !reachable; L++) {
      var lr = lines[L];
      if (lr.width < 0.5 || lr.height < 0.5) continue;
      for (var o = 0; o < overlays.length; o++) {
        var ov = overlays[o];
        if (ov.el.contains(owner) || owner.contains(ov.el)) continue;
        if (lr.right <= ov.r.left || lr.left >= ov.r.right || lr.bottom <= ov.r.top || lr.top >= ov.r.bottom) continue;
        reachable = true; break;
      }
    }
    if (!reachable) continue;
    var vb = visibleBox(owner), text = String(n.nodeValue);
    var covered = [], by = null, px0 = 0, px1 = 0;
    for (var c = 0; c < text.length; c++) {
      if (/\\s/.test(text[c])) continue;
      rng.setStart(n, c); rng.setEnd(n, c + 1);
      var cr = rng.getClientRects()[0];
      if (!cr || cr.width < 0.2 || cr.height < 0.2) continue;
      chars++;
      var cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
      if (cx < vb.left || cx > vb.right || cy < vb.top || cy > vb.bottom) continue;
      tested++;
      var hit = document.elementFromPoint(cx, cy);
      if (!hit || hit === owner || owner.contains(hit) || hit.contains(owner)) continue;
      if (effOp(hit) < MINOP) continue;                 // round 14 owns the invisible half
      if (!paintsAbove(hit, owner)) continue;           // hit order is not paint order
      var stop = hit;
      while (stop && !stop.contains(owner)) stop = stop.parentElement;
      var painter = null;
      for (var p2 = hit; p2 && p2.nodeType === 1 && p2 !== stop; p2 = p2.parentElement)
        if (paints(p2)) { painter = p2; break; }
      if (!painter) continue;                           // on top, and putting no pixels there
      if (!covered.length) px0 = cr.left;
      px1 = cr.right; covered.push(text[c]); by = painter;
    }
    if (!covered.length) continue;
    var host = owner.closest("[data-msg]") || owner.closest("[id]") || owner;
    findings.push({
      text: text.replace(/\\s+/g, " ").trim().slice(0, 80),
      covered: covered.join(""), n: covered.length, px: Math.round((px1 - px0) * 10) / 10,
      owner: owner.tagName.toLowerCase() + (owner.className ? "." + String(owner.className).split(" ")[0] : ""),
      where: (host.getAttribute && host.getAttribute("data-msg")) || host.id || String(host.className || "?").split(" ")[0],
      by: by.tagName.toLowerCase() + (by.className ? "." + String(by.className).split(" ")[0] : "") +
          " :: " + String(by.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 26),
      w: window.innerWidth
    });
  }
  return { findings: findings, overlays: overlays.length, chars: chars, tested: tested };
};
`;

/* --- one browser session ---------------------------------------------------- */
async function newPage(browser, width) {
  const ctx = await browser.newContext({ viewport: { width: Number(width) || SEQ_WIDTH, height: HEIGHT } });
  await ctx.addInitScript(INIT);
  await ctx.addInitScript(OCCL);
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
/* A LOAD THAT LOSES A RACE FOR A CORE IS NOT A DEFECT IN THE PAGE (round 18).
   This pass reloads the file once per state and waits 90s for the script to
   define `render`. On a 4-core box shared with another job that wait was blown
   at transition 2,800 of 5,303 — one starved load, and ninety minutes of walk
   thrown away with it. The retry is bounded at two attempts and COUNTED, so a
   page that genuinely hangs still fails the run and a run that needed retries
   says how many it needed rather than quietly looking clean. */
let SEQ_RELOADS = 0;
async function seqStep(page, errors, path) {
  const errAt = errors.length;
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(URL);
      await page.waitForFunction("typeof render === 'function'", null, { timeout: 90000 });
      break;
    } catch (e) {
      if (attempt) throw e;
      SEQ_RELOADS++;
    }
  }
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
      : [],
    /* and the same thing for NUMBERS (round 14, D1): every numeral on screen and
       what read it, straight out of the mechanism that reads them */
    numbers: typeof window.__numberReach === "function" ? window.__numberReach() : []
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
  const stepSeen = new Set();      // every (object, action, driver) any state has ever OFFERED
  const uncovered = new Set();     // the walk's own "what I do not cover", unioned over states
  const numbers = new Set();       // every numeral on screen and what read it, unioned over states
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
  root.numbers.forEach(u => numbers.add(u));
  root.violations.forEach(t => violations.push({ text: t, path: [], where: "load" }));
  seen.set(root.sig, { depth: 0, path: [] });
  const rootSteps = stepsOf(root.alphabet);
  rootSteps.forEach(s => stepSeen.add(s));
  let frontier = [{ sig: root.sig, path: [], steps: rootSteps, fresh: root.ctls.length, freshSteps: rootSteps.length }];
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
       the round's own instrument, caught by reading its own diff.

       AND ONE KEY IS NOT A RANKING WHERE IT MATTERS (round 14, D3). Measured on
       round 13's own instrument: frontier novelty was zero for 70 of 83 states
       at depth 3, 81 of 92 at depth 4 and 83 of 88 at depth 5 — so past depth 2,
       where the budget does not yet bind, the tie-break WAS the policy and the
       ranking this comment describes was signature order. That is exactly "an
       arbitrary sample of a level", which the paragraph above calls the weakest
       thing a bounded search can do, arriving inside the fix for it.
       Every control key exists by depth 3; what does NOT is the set of (object,
       action) pairs the page OFFERS, which keeps growing as records move. So the
       second key is offered-step novelty, and the report prints how many states
       each key could still tell apart at each level — a ranking that has gone
       inert says so rather than being described as a preference it no longer
       expresses. */
    const ordered = frontier.slice().sort((a, b) =>
      ((b.fresh || 0) - (a.fresh || 0)) ||
      ((b.freshSteps || 0) - (a.freshSteps || 0)) ||
      (a.sig < b.sig ? -1 : 1));
    const inertCtl = frontier.filter(s => !(s.fresh || 0)).length;
    const inertBoth = frontier.filter(s => !(s.fresh || 0) && !(s.freshSteps || 0)).length;
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
      if (d <= UNCOVERED_DEPTH) { r.uncovered.forEach(u => uncovered.add(u)); r.numbers.forEach(u => numbers.add(u)); }
      if (r.failed.length) r.failed.forEach(f => unreachable.set(f.split(" (")[0], f));
      else drivenSteps.add(j.step);
      r.violations.forEach(t => violations.push({ text: t, path: j.path.slice(), where: "sequence d" + d }));
      if (seen.has(r.sig)) return;
      seen.set(r.sig, { depth: d, path: j.path });
      const steps = stepsOf(r.alphabet);
      const freshSteps = steps.filter(s => !stepSeen.has(s)).length;
      steps.forEach(s => stepSeen.add(s));
      nextFrontier.push({ sig: r.sig, path: j.path, steps, fresh: r.fresh, freshSteps });
    });
    levels.push({ depth: d, states: nextFrontier.length, expanded: expand.length,
                  truncated, transitions: jobs.length,
                  frontier: frontier.length, inertCtl, inertBoth });
    log(`  depth ${d}: ${jobs.length} transitions driven from ${expand.length} state(s)` +
        (truncated ? ` (${truncated} state(s) left unexpanded — frontier budget ${BUDGET})` : " (complete breadth)") +
        ` → ${nextFrontier.length} new state(s)` +
        `  [ranking: ${inertCtl}/${frontier.length} states tied at zero on control novelty, ` +
        `${inertBoth} still tied after step novelty]`);
    frontier = nextFrontier;
  }

  for (const w of workers) await w.ctx.close();
  return { seen, levels, violations, drivenSteps, offeredSteps, unreachable, ctlSeen, uncovered, numbers,
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
      /* AND EACH SESSION OPENS AT A DIFFERENT SUPPORTED WIDTH (round 14, D2) —
         the layout has two breakpoints and thirteen rounds of enumeration only
         ever saw the widest band */
      const width = WIDTHS[sessions % WIDTHS.length];
      const { ctx, page, errors } = await newPage(browser, width);
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
    const width = WIDTHS[s % WIDTHS.length];
    const { ctx, page, errors } = await newPage(browser, width);
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
        violations.push({ text: t, path: path0.slice(), where: "random s" + s + " @" + width }));
    }
    await ctx.close();
  }
  log(`  ${RANDOM_SESSIONS} sessions × up to ${RANDOM_CLICKS} clicks = ${clicks} clicks, across widths ${WIDTHS.join(", ")}`);
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
/* hover a row the way a reader does: a real pointer, parked in the row's text
   column, well left of anything the hover reveals. Returns the row's geometry. */
async function hoverRow(page, msg) {
  const r = await page.evaluate(m => {
    const el = document.querySelector(`#feed .mrow[data-msg="${m}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const b = el.getBoundingClientRect();
    return { top: b.top, left: b.left, right: b.right, h: b.height };
  }, msg);
  if (!r) return null;
  await page.mouse.move(r.left + 160, r.top + Math.min(8, r.h / 2));
  await page.waitForTimeout(140);
  return r;
}

/* the pin's one-click control for an object, by the object rather than by its
   label — a label moves when a fixture is reworded, an object id does not */
async function clickIn(page, sel) {
  const ok = await page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }, sel);
  await page.waitForTimeout(160);
  return ok;
}

/* THE SCAN R17-D1 RUNS IN TWO STATES. Every surface painting an elapsed time
   for an open question, against the record's own two timestamps — the ask time
   the object holds and the room clock. It measures rather than pattern-matches,
   so it reports by how much and from what. */
const D1_SCAN = () => {
  const out = [];
  const mins = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
                      return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const want = o => {
    const a = mins(o.askedAt), b = mins(S.now);
    if (a == null || b == null || b < a) return null;
    const d = b - a;
    return d < 60 ? d + "m" : Math.floor(d / 60) + "h" + (d % 60 ? " " + (d % 60) + "m" : "");
  };
  const open = {};
  Object.keys(S.rooms).forEach(k => (S.rooms[k].objects || []).forEach(o => {
    if (o.verification === "open" && o.askedAt && !o.reopenedAt) open[o.id] = o;
  }));
  const only = Object.keys(open);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest("script, style, template")) return NodeFilter.FILTER_REJECT;
      const r = p.getBoundingClientRect();
      if (!r.width || !r.height) return NodeFilter.FILTER_REJECT;
      return /\bopen\s+\d/i.test(String(n.nodeValue)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  let n;
  while ((n = walker.nextNode())) {
    const m = /\bopen\s+(\d+\s*(?:h|m)(?:\s+\d+\s*m)?)\b/i.exec(String(n.nodeValue));
    if (!m) continue;
    const said = m[1].replace(/\s+/g, " ").trim();
    const p = n.parentElement;
    const host = p.closest("[data-obj], [data-lens-obj], [data-fact-obj]");
    const id = host && (host.dataset.obj || host.dataset.lensObj || host.dataset.factObj);
    const o = open[id] || (only.length === 1 ? open[only[0]] : null);
    if (!o) { out.push("a surface paints " + JSON.stringify("open " + said) +
                       " and nothing on it says which record it is about"); continue; }
    const w = want(o);
    if (w === said) continue;
    out.push("a surface says " + o.id + " has been " + JSON.stringify("open " + said) + " — the record says it " +
             "was asked at " + JSON.stringify(o.askedAt) + " and the room clock says " + JSON.stringify(S.now) +
             ", which is " + JSON.stringify("open " + (w == null ? "a time this page cannot subtract" : w)) +
             " · painted in " + ((p.closest("[id]") || {}).id || p.className));
  }
  return Array.from(new Set(out));
};

/* THE SCAN R18-D1 RUNS. Feed rows grouped by the object they narrate and the
   tick they were minted in, then every row after the first held against every
   word pair the rows before it painted. Human-authored characters and reply
   previews are removed on both sides, and a row's own state tag is removed from
   the side being scanned — `objectTag()` re-derives the OBJECT's state on every
   row about it, deliberately, which is why two seeded rows about D1 both read
   `accepted · lars` and why that is not this rule's business. The tag is still
   INDEXED, because `nothing inferred` reached the ledger line from exactly
   there. This is the harness's copy of checkEchoInvariant(), so it can be
   pointed at a build that has no such check. */
const ECHO_SCAN = () => {
  const words = (el, drop) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('[data-voice="human"], .mreply' + (drop || "")).forEach(n => n.remove());
    return String(c.textContent || "").toLowerCase()
      .replace(/[^a-z0-9%$#]+/g, " ").trim().split(/\s+/).filter(Boolean);
  };
  const groups = {};
  document.querySelectorAll("#feed .mrow[data-obj]").forEach(el => {
    const body = el.querySelector(".m");
    const t = ((el.querySelector(".t") || {}).textContent || "").trim();
    if (!body || !t) return;
    const k = el.dataset.obj + "@" + t;
    (groups[k] = groups[k] || []).push({ id: el.dataset.msg,
      said: words(body, ", .tag"), all: words(body) });
  });
  const out = [];
  Object.keys(groups).forEach(k => {
    const g = groups[k];
    for (let i = 1; i < g.length; i++) {
      const earlier = {};
      for (let p = 0; p < i; p++)
        for (let n = 0; n + 1 < g[p].all.length; n++)
          earlier[g[p].all[n] + " " + g[p].all[n + 1]] = g[p].id;
      let run = [], from = null, best = [], bestFrom = null;
      const close = () => { if (run.length > best.length) { best = run; bestFrom = from; } run = []; from = null; };
      for (let n = 0; n + 1 < g[i].said.length; n++) {
        const pair = g[i].said[n] + " " + g[i].said[n + 1];
        if (earlier[pair]) { if (!run.length) { run = [g[i].said[n]]; from = earlier[pair]; } run.push(g[i].said[n + 1]); }
        else close();
      }
      close();
      if (best.length)
        out.push("two feed rows narrate " + k.split("@")[0] + " in the same tick and " + g[i].id +
                 " repeats " + JSON.stringify(best.join(" ")) + " from " + bestFrom +
                 " — one event, stated twice");
    }
  });
  return Array.from(new Set(out));
};

/* THE SCAN R19-D1 RUNS, AND IT IS A SCAN AND NOT A ROUTE. Every visible run the
   page AUTHORED, held against a closed list of English spatial locators. A run
   that carries one is a finding unless it declares which record it points at and
   in which direction — and then the direction is measured against the painted
   boxes, so a declaration is not an exemption.

   THIS IS THE HARNESS'S COPY OF checkLocatorInvariant(), for the reason
   ECHO_SCAN is the harness's copy of checkEchoInvariant(): it has to be
   pointable at a build that predates the rule.

   AN EARLIER CUT CARRIED A DECLARED TABLE — one row, C3's "the parity run BELOW
   happens to agree with this", which this round was told was not a defect and
   was twice adjudicated as holding at every reachable scroll position. The table
   measured it rather than whitelisting it, and the measurement disagreed: three
   clicks from boot on r18 as committed (C3 in the lens, its receipt, the `·31
   routine` strip) the 31 routine rows expand, m9 leaves the viewport, and the
   only parity run a reader can see renders 19-139px ABOVE that sentence at every
   declared width in both themes. The adjudications had asked whether SCROLLING
   could falsify it; what falsifies it is a control that changes what is in the
   feed. So the sentence names its referent like the other fifteen, the table has
   no rows left, and the rule is flat with no way through it.

   WHAT IT DOES NOT COVER, before somebody discovers it next round: a paraphrase.
   "the line you just read", "two panels left", "scroll down for it" walk past a
   word list, and no word list can be complete over English. What it buys is that
   the FORM this artifact has now shipped four times cannot ship a fifth time in
   silence. Text the page RECITES rather than asserts is out — a person's typed
   words, a seeded message, a provenance excerpt — for the same reason every
   other page-integrity rule here exempts them. */
const LOCATOR_WORDS = [
  "above", "below", "beneath", "underneath", "overhead",
  "beside", "alongside", "adjacent", "to the left", "to the right",
  "on the left", "on the right", "leftmost", "rightmost",
  "the row above", "the row below", "the row before", "the row after",
  "the line above", "the line below", "further up", "further down",
  "higher up", "lower down", "at the top", "at the bottom", "topmost"
];
const LOCATOR_SCAN = ({ words }) => {
  const RECITED = '[data-voice="human"], .sysex, [data-cited], .prov';
  const RE = new RegExp("\\b(?:" + words.join("|") + ")\\b", "i");
  /* rendered at all, not "in the viewport": a locator is non-compliant wherever
     it sits, and scrolled out is not a defence. Same test as the page's own
     rule, which uses shown() for exactly this reason. */
  const rendered = el => {
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      if (p.hidden) return false;
      const cs = getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    return true;
  };
  const out = [];
  const seen = {};
  document.querySelectorAll("body *").forEach(el => {
    if (el.children.length) return;
    if (el.closest("script, style, template")) return;
    if (el.closest(RECITED)) return;
    if (el.getAttribute("aria-hidden") === "true") return;
    if (!rendered(el)) return;
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    const m = RE.exec(raw);
    if (!m) return;
    const word = m[0].toLowerCase();
    const key = word + "|" + raw.slice(0, 80);
    if (seen[key]) return;
    seen[key] = 1;
    out.push("a sentence this page wrote says " + JSON.stringify(word) +
             " instead of naming what it means — " + JSON.stringify(raw.slice(0, 150)) +
             " · painted in " + ((el.closest("[id]") || {}).id || el.className) +
             " at y=" + Math.round(el.getBoundingClientRect().top));
  });
  return Array.from(new Set(out));
};

const REPROS = [
  {
    /* ROUND 19, D1 — THE THIRD INSTANCE OF ONE CLASS, AND THE ROUND IS THE
       ENUMERATION RATHER THAN THE SENTENCE.

       THE REPORTED ROUTE. Boot, #users-migration, open `Sign off the rollback
       runbook` from the pin, `Reschedule to today 17:00`, open K2's receipt.
       WHAT HAPPENED says "lars moved the due date from yesterday 17:00 to today
       17:00 — THE DATE IT MOVED FROM STAYS ABOVE, and it is still owed", at
       y=252 at 1440. Measured painted rects of every occurrence on that screen:

         today 17:00       114   receipt state line   ABOVE
         today 17:00       235   pin card             ABOVE
         yesterday 17:00   252   the claim's own sentence
         yesterday 17:00   431   correction chain     179px BELOW
         yesterday 17:00   540   closing note         292px BELOW

       No width and no theme puts `yesterday 17:00` above that sentence. Both
       readings available to a person are false — either the old date was not
       retained, or the commitment was never late — and by then the `overdue 16h`
       chip is gone from every surface, so the reader with the most at stake is
       the one checking that a reschedule did not quietly erase a missed
       deadline. It fires on exactly the branch where the date MOVES.

       WHY THIS IS A SCAN AND NOT A THIRD ROUTE-SHAPED REPRO. Round 17 removed
       this shape from K2's seeded `why` and wrote R17-D3, which drives ONE route
       and asserts on the pin's `.why`. The sentence came back through the
       SYNTHESIZED branch of the same function, four clicks from boot — and
       R17-D3's own assertion, run on that state instead of on the state it
       drives, reports it on r18 as committed. A scripted path checks the path.
       So this repro drives two routes into one scan over every visible run the
       page authored, and the page itself now carries the rule on the render
       (checkLocatorInvariant), which is the part a fixed route cannot do.

       FIRES ON r18 AS COMMITTED at every width in both themes. */
    id: "R19-D1-a-sentence-names-what-it-points-at",
    what: "no run the page authored says where something is unless it declares a record and the geometry agrees",
    async run(page) {
      if (!await clickIn(page, '#pinList [data-open="K2"]')) return "K2 does not open on the pin";
      if (!await clickIn(page, '[data-fx="resched"]')) return "K2 offers no reschedule";
      if (!await clickIn(page, '[data-receipt="K2"]')) return "K2's receipt is not reachable";
      return null;
    },
    async assert(page) {
      return await page.evaluate(LOCATOR_SCAN, { words: LOCATOR_WORDS });
    }
  },
  {
    /* ROUND 19, D1b — THE SAME CLASS IN THE SURFACE ROUND 17 FIXED.
       `whyOf()` has two branches. Round 17 rewrote the seeded one on K2 and left
       the synthesized one, whose supporting clause reads "the call at <tm> was
       <who>'s, AND IT IS ON THE RECORD BELOW". Reopen D1 and the pin paints it.
       R17-D3's own assertion reports it verbatim on this state, on r18:
         WHY on D1 points at a record below it — "you reopened this at 09:13, so
         it is pending and only you can settle it · the call at 29 Jul 11:20 was
         lars's, and it is on the record below."
       That is not a new finding by a new instrument. It is round 17's instrument
       driven four clicks further than round 17 drove it. */
    id: "R19-D1b-the-pins-rationale-names-the-record",
    what: "the synthesized rationale on the pin locates nothing by position",
    async run(page) {
      if (!await clickIn(page, '[data-lens-obj="D1"]')) return "D1 is not in the lens";
      if (!await clickIn(page, '[data-receipt="D1"]')) return "D1's receipt is not reachable";
      if (!await clickIn(page, "#rcReopen")) return "D1 offers no reopen";
      const typed = await page.evaluate(() => {
        const el = document.getElementById("rinput");
        if (!el) return false;
        el.focus(); el.value = "we need to revisit this"; el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      });
      if (!typed) return "the reopen prompt has no reason field";
      if (!await clickIn(page, "#rgo")) return "the reopen prompt has no confirm";
      return null;
    },
    async assert(page) {
      return await page.evaluate(LOCATOR_SCAN, { words: LOCATOR_WORDS });
    }
  },
  {
    /* ROUND 19, D2 — A COUNT SCOPED TO A SET IT NEVER NAMES.
       The pin trailer prints `~ 6 of 10 unverified · 1/3 objectives clear of
       you`. The left half counts the room's records MINUS the ones in the pin;
       the right half counts the whole room and says so. Nothing on the left
       said which set it was — no clause, no title, no aria-label — so clearing
       your queue walks the same sentence in the same place through 6 of 10 → 6
       of 11 → 7 of 12 → 8 of 13 while the tab beside it says 13 throughout.
       Every statement is true of its unstated set, which is why this is
       ambiguity rather than falsehood and why a blind critic correctly declined
       to hold on it. It is in scope because ROUND 12 REMOVED THE CLAUSE THAT
       CARRIED THE FACT (`beyond the N above`) and that clause was the scope.

       THE ASSERTION IS A COMPARISON, NOT A WORD COUNT: it takes the denominator
       the trailer prints and the number of records the room holds, and only when
       they DIFFER does it ask whether the sentence names a set. The compliant
       forms are allowlisted — the page's own vocabulary for the pin — rather
       than the violations being denylisted, which is unbounded.
       FIRES ON r18 AS COMMITTED, at boot and after clearing an item. */
    id: "R19-D2-a-count-names-the-set-it-counts-over",
    what: "a trailer count over a subset of the room says which subset",
    async run(page) {
      if (!await clickIn(page, '#pinList [data-opt="0"]')) return "P1 offers no one-click option";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const el = document.getElementById("pinTrailer");
        if (!el) return [];
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        const m = /(\d+)\s+of\s+(\d+)\s+unverified/.exec(t);
        if (!m) return [];
        const held = (typeof room === "function" && room() && room().objects) ? room().objects.length : null;
        if (held == null) return [];
        if (Number(m[2]) === held) return [];        // it counts the room; the room is the default subject
        /* the page's own words for the set outside the pin — the failure branch
           of this very phrase has said "outside your list" since round 12 */
        if (/outside your list|beyond your list|not in your list|everything else/i.test(t)) return [];
        return ['the pin trailer says "' + m[0] + '" over ' + m[2] + " records while the room holds " + held +
                ", so the number is scoped to the records outside the pin and the sentence does not say so — " +
                "the other half of the same line is scoped to the room and does: " + JSON.stringify(t)];
      });
    }
  },
  {
    /* ROUND 19, D3 — THREE INPUTS DESTROYED IN SILENCE, AGAINST THE FILE'S OWN
       RULE. dropPrefill()'s comment, round 8: "deleting somebody's draft to be
       safe is its own kind of dishonesty." The verify box and the reopen box are
       rebuilt from innerHTML on every render(), so ANY re-render took the
       characters with them: type evidence, press FOLD, gone. No sentence on
       screen claims otherwise, so this is data loss rather than a lie, and a
       blind critic correctly declined to hold on it — it is in scope because the
       artifact was citing an invariant it does not hold. */
    id: "R19-D3-a-typed-note-survives-a-render-it-did-not-cause",
    what: "the verify box keeps the evidence a person typed when something else re-renders the page",
    async run(page) {
      if (!await clickIn(page, '#feed [data-verify="C3"]')) return "C3 offers no verify";
      const typed = await page.evaluate(() => {
        const el = document.getElementById("vinput");
        if (!el) return false;
        el.focus(); el.value = "the July AWS bill"; el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      });
      if (!typed) return "the verify prompt has no evidence field";
      if (!await clickIn(page, "#pinFold")) return "the pin does not fold";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const el = document.getElementById("vinput");
        if (!el) return ["folding the pin closed the verify prompt outright"];
        return el.value === "the July AWS bill" ? []
          : ['the evidence a person typed was destroyed by an unrelated re-render — the box now holds ' +
             JSON.stringify(el.value) + ', and this file\'s own rule is that "deleting somebody\'s draft to be ' +
             'safe is its own kind of dishonesty"'];
      });
    }
  },
  {
    /* ROUND 19, D3b — the same defect in the other prompt. The reopen reason is
       the one whose loss costs most: the hint under it promises the sentence is
       kept "word for word and attributed to you", which is a promise about text
       the next render was deleting. */
    id: "R19-D3b-a-reopen-reason-survives-a-render-it-did-not-cause",
    what: "the reopen box keeps the reason a person typed when something else re-renders the page",
    async run(page) {
      if (!await clickIn(page, '[data-lens-obj="K0"]')) return "K0 is not in the lens";
      if (!await clickIn(page, '[data-receipt="K0"]')) return "K0's receipt is not reachable";
      if (!await clickIn(page, "#rcReopen")) return "K0 offers no reopen";
      const typed = await page.evaluate(() => {
        const el = document.getElementById("rinput");
        if (!el) return false;
        el.focus(); el.value = "the flag was flipped back"; el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      });
      if (!typed) return "the reopen prompt has no reason field";
      if (!await clickIn(page, "#pinFold")) return "the pin does not fold";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const el = document.getElementById("rinput");
        if (!el) return ["folding the pin closed the reopen prompt outright"];
        return el.value === "the flag was flipped back" ? []
          : ["the reason a person typed was destroyed by an unrelated re-render — the box now holds " +
             JSON.stringify(el.value) + ", under a hint promising it is kept word for word"];
      });
    }
  },
  {
    /* ROUND 19, D3c — the composer half. A one-click answer from the pin reads
       nothing out of the composer and emptied it anyway: type half a message,
       answer P1 from the card, and the half-message is gone. The typed path must
       still clear the box, because there the characters BECAME the statement of
       record — so this asserts both directions, and a fix that simply stopped
       clearing would fail its second half. */
    id: "R19-D3c-a-write-clears-the-composer-only-when-the-composer-wrote-it",
    what: "answering from the pin leaves a draft alone; answering from the composer consumes it",
    async run(page) {
      const typed = await page.evaluate(() => {
        const el = document.getElementById("cinput");
        if (!el) return false;
        el.focus(); el.value = "half a message about the cutover";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      });
      if (!typed) return "there is no composer";
      if (!await clickIn(page, '#pinList [data-opt="0"]')) return "P1 offers no one-click option";
      return null;
    },
    async assert(page) {
      return await page.evaluate(async () => {
        const out = [];
        const el = document.getElementById("cinput");
        if (!el) return ["the composer is gone"];
        if (el.value !== "half a message about the cutover")
          out.push("answering a decision from the pin destroyed a draft it never read — the composer now holds " +
                   JSON.stringify(el.value));
        /* AND THE OTHER DIRECTION, in the same state: bind the composer, send,
           and the box must be empty, because those characters are the statement
           of record now. A fix that just stopped clearing passes the first half
           of this repro and fails here. */
        const bind = document.querySelector('#pinList [data-bind="1"], #feed [data-bind="1"]');
        if (!bind) return out;
        bind.click();
        await new Promise(r => setTimeout(r, 120));
        const box = document.getElementById("cinput");
        box.focus(); box.value = "we hold until the freeze clears";
        box.dispatchEvent(new Event("input", { bubbles: true }));
        const send = document.getElementById("sendBtn");
        if (!send) return out;
        send.click();
        await new Promise(r => setTimeout(r, 200));
        const after = document.getElementById("cinput");
        if (after && after.value !== "")
          out.push("a typed answer left its own characters in the composer after recording them as the " +
                   "statement of record — the box still holds " + JSON.stringify(after.value));
        return out;
      });
    }
  },
  {
    /* ROUND 18, D1 — THE ONE THREE BLIND REVIEWERS FOUND WITHOUT BEING ASKED.
       One click. Answer P1 from the pin and the feed appends two rows, one tick
       apart, about one object, and the second prints the first back: `lars
       chose: Keep dual-write through 14 Aug` is the first row's body verbatim,
       `not worded by lars` is its note in other words, and `nothing inferred`
       is its tag. Two rows, ~50 words, one event.

       Nothing separates them and nothing can: appendMessage() and
       appendSystem() push into the same array on the same tick, and the only
       things renderFeed() can insert between two rows are the two dividers
       (fixed at earlier indices) and the routine strip (neither row is
       routine). So the second row is always the first row's neighbour, and
       every clause it repeats is a clause a reader sees twice in one block.

       IT ALSO FIRES ON THE TYPED PATH, which matters because the typed answer
       row's body is the human's own characters and is exempt: there the only
       thing repeated is `nothing inferred`, from tag to ledger line, and the
       rule catches it because a tag is indexed even though it is not scanned.
       All three paths are driven here.

       AND WHAT IT DOES NOT CATCH IS THE POINT OF SAYING WHAT IT DOES. Over these
       three paths on r17 it reports exactly three runs — `nothing inferred`,
       `unverified no sign off attached` and `lars chose keep dual write through
       14 aug`, one per path. It does not
       report `statement recorded verbatim, not worded by lars` sitting over a
       note that reads `these are not lars's words`, because that is a
       RESTATEMENT and not a repeat, and no word-level rule can see one. Those
       were cut by hand, by reading the screen. A mechanical rule keeps a prune
       pruned; it does not perform one.

       FIRES ON r17 AS COMMITTED at every width in both themes. */
    id: "R18-D1-one-event-is-stated-once",
    what: "two feed rows minted in the same tick about the same object paint no run of words twice",
    async run(page) {
      const seen = [];
      const sample = async () => { seen.push(...await page.evaluate(ECHO_SCAN)); };
      /* 1 — the TYPED path first, while P1 is still open. The answer row here is
             the human's own message, so everything but its tag is exempt. */
      if (!await clickText(page, "Answer in your own words", { within: "#pin" }))
        return "P1 offers no bound composer";
      await page.fill("#cinput", "Dual-write runs to the freeze and the legacy tail is force-re-authed on 15 Aug");
      await page.press("#cinput", "Enter");
      await page.waitForTimeout(140);
      await sample();
      /* 2 — a CHOSEN answer on a question, whose ledger line carries the
             consequence as well as the arrow */
      if (!await clickText(page, "Answer — retention is 90 days")) return "Q1's answer not offered";
      await sample();
      /* 3 — and a CHOSEN answer on a decision, which is the pair the reviewers
             read: reopen P1 from its receipt and take the card's option */
      if (!await clickText(page, "the receipt for P1")) return "no route to P1's receipt";
      if (!await clickIn(page, "#rcReopen")) return "the receipt offers no Reopen";
      if (!await clickIn(page, "#rgo")) return "the reopen prompt offers no confirm";
      if (!await clickText(page, "Keep dual-write through 14 Aug")) return "the reopened decision offers no option";
      await sample();
      await page.evaluate(f => { window.__r18d1 = f; }, Array.from(new Set(seen)));
      return null;
    },
    async assert(page) {
      const later = await page.evaluate(ECHO_SCAN);
      const before = await page.evaluate(() => window.__r18d1 || []);
      return Array.from(new Set(before.concat(later)));
    }
  },
  {
    /* ROUND 18, D2 — the same rule, one column left. Clear your list and the
       pin says it is empty twice: `nothing owed — this is the whole list` in
       the count slot and `NOTHING NEEDS YOU IN THIS ROOM — THAT IS A RESULT,
       NOT AN ABSENCE` forty pixels under it. Two statements of one fact in the
       page's most valuable real estate, on the screen you reach by doing the
       work. And the clause that was cut, "this is the whole list", is a promise
       that nothing is folded away — worth making about a list with something in
       it, which is the state where it was never printed.

       FIRES ON r17 AS COMMITTED at every width in both themes. */
    id: "R18-D2-an-empty-list-says-so-once",
    what: "the pin's count and its empty state do not both announce the same emptiness",
    async run(page) {
      if (!await clickText(page, "Keep dual-write through 14 Aug")) return "P1's answer not offered";
      if (!await clickText(page, "Mark signed off")) return "K2 offers no sign-off";
      if (!await clickText(page, "Answer — retention is 90 days")) return "Q1's answer not offered";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const box = document.querySelector("#pinList .empty");
        if (!box) return [];
        const r = box.getBoundingClientRect();
        if (!r.width || !r.height) return [];
        /* THE ASSERTION IS THE DESIGN, NOT A WORD HEURISTIC. While the empty
           box is on screen it is the statement, so the count slot beside it
           states nothing. r17 printed both. */
        const count = String((document.getElementById("pinCount") || {}).textContent || "")
          .replace(/\s+/g, " ").trim();
        return count
          ? ["the pin announces the same emptiness twice: the count slot says " + JSON.stringify(count) +
             " over an empty state that already says " + JSON.stringify(String(box.textContent || "").trim())]
          : [];
      });
    }
  },
  {
    /* ROUND 17, D1. Zero clicks: at boot, on the pin and in the lens and in the
       receipt, `open 3h` over a record that says 09:11 and a room clock that
       says 09:12. Three hours before now is ~06:12, INSIDE the absence window
       (17:41 yesterday → 09:12 today) where this room has no events at all, and
       the earliest thing in today's record is 08:31 — so the record does not
       merely fail to support the number, it excludes it.

       Two sources, and the second is the one that mattered: `openFor: "3h"` on
       the seed, and `{ read: "verification", post: " 3h" }` on the chip — a
       literal pasted onto a genuine record read, which defeats say()'s
       point-read mutation BY CONSTRUCTION. Flip the verification and the
       sentence moves, so the read is provably load-bearing; the three characters
       beside it never budge. The number rule then filed `open #h` as
       `form:duration`, so the coverage artifact checked that a duration LOOKED
       like a duration and nothing compared it with the timestamp it is a
       duration FROM.

       THIS MEASURES, IT DOES NOT PATTERN-MATCH. It reads the elapsed time off
       every surface that paints one and subtracts the record's own two
       timestamps, so it says by how much and from what. It fires on r16 at every
       width on the load state, before any click. */
    id: "R17-D1-an-elapsed-time-equals-the-record-it-measures",
    what: "every rendered elapsed time is the distance between the two record timestamps it is about",
    /* TWO STATES, BECAUSE THE RECEIPT REPLACES THE LENS ITEM IT IS OPENED FROM.
       The pin and the lens both paint this at boot; opening the receipt swaps
       the lens list out for the receipt, so one sample can only ever see two of
       the three surfaces. Sample the load state, then open the receipt and
       sample again, and report the union. */
    async run(page) {
      const found = await page.evaluate(D1_SCAN);
      await page.evaluate(f => { window.__r17d1 = f; }, found);
      await clickIn(page, '#lensBody .oitem[data-lens-obj="Q1"]');
      return null;
    },
    async assert(page) {
      const later = await page.evaluate(D1_SCAN);
      const before = await page.evaluate(() => window.__r17d1 || []);
      return Array.from(new Set(before.concat(later)));
    }
  },
  {
    /* ROUND 17, D2. In #users-migration: lens → expand `Retire the legacy
       identity path` → D2 → Reopen → Reopen. The correction chain says `the
       source is still in the room →`. FORTY PIXELS ABOVE IT, in the same panel,
       the provenance entry for the same message says `jump to source in
       #identity-service →`. Clicking the chain's route leaves the room, and the
       page's own toast then reads "the source of that item lives here, not in
       the room you came from".

       `sourceRoom` is the fact both of the other two surfaces derive from, and
       `linkedObject`/`isAttentionRow` are room-scoped precisely so that no
       surface pretends an in-room row exists. This is behavioural: it captures
       the label, clicks it, and asks whether the room moved. */
    id: "R17-D2-a-route-label-says-where-it-goes",
    what: "a correction-chain route that leaves the room does not say the thing is still in it",
    async run(page) {
      await clickIn(page, '#lensBody .obj-head[data-objective="o2"]');
      if (!await clickIn(page, '#lensBody .oitem[data-lens-obj="D2"]')) return "D2 is not in this room's lens";
      if (!await clickIn(page, "#rcReopen")) return "the receipt offers no Reopen";
      if (!await clickIn(page, "#rgo")) return "the reopen prompt offers no confirm";
      const before = await page.evaluate(() => {
        const b = document.querySelector(".corr .bd button[data-jump]");
        if (!b) return null;
        return { label: (b.textContent || "").replace(/\s+/g, " ").trim(),
                 room: S.roomId, declared: b.dataset.jumproom || null,
                 note: (document.querySelector(".rc-foot .note") || {}).textContent || "",
                 obj: (b.closest("[data-corr-obj]") || { dataset: {} }).dataset.corrObj || null };
      });
      if (!before) return "the reopen wrote no correction entry with a route";
      await page.evaluate(() => { window.__r17d2 = null; });
      await page.evaluate(b => { window.__r17d2 = b; }, before);
      await clickIn(page, ".corr .bd button[data-jump]");
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const b = window.__r17d2;
        if (!b) return [];
        const out = [];
        const now = S.roomId;
        if (/still in the room/i.test(b.label) && now !== b.room)
          out.push("a route labelled " + JSON.stringify(b.label) + " left #" + b.room + " for #" + now +
                   " — and the page's own toast says the source lives here, not in the room you came from");
        if (b.declared && b.label.indexOf("#" + b.declared) < 0)
          out.push("a route that goes to #" + b.declared + " does not name it: " + JSON.stringify(b.label));
        if (/the row that carried it re-renders to say so/i.test(b.note) && b.declared)
          out.push("the receipt for " + b.obj + " says the row that carried it re-renders to say so — that row is in #" +
                   b.declared + " and does not render here at all");
        return out;
      });
    }
  },
  {
    /* ROUND 17, D2, second instance — X1 in #identity-service, whose own record
       note says "the sentence that raised it is in #users-migration and stays
       there. The pin says so and goes there rather than pretending a row here
       exists", while its correction chain said the proposal it replaced was
       still in this room. Answering it is one click from the pin. */
    id: "R17-D2b-a-cross-room-decisions-chain-says-which-room",
    what: "answering a decision whose source is in another room labels the route with that room",
    async run(page) {
      if (!await clickIn(page, '#railRooms .rrow[data-room="identity-service"]')) return "no route to #identity-service";
      if (!await clickIn(page, '#pinList [data-obj="X1"] button[data-opt="0"]'))
        return "X1 offers no one-click option on the pin";
      await clickIn(page, '#lensBody .obj-head[data-objective="p2"]');
      await clickIn(page, '#lensBody .oitem[data-lens-obj="X1"]');
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.corr .bd button[data-jump]').forEach(b => {
          const label = (b.textContent || "").replace(/\s+/g, " ").trim();
          const room = b.dataset.jumproom || null;
          if (!room) return;
          if (/still in the room/i.test(label))
            out.push("a route into #" + room + " says the thing is still in the room you are standing in: " +
                     JSON.stringify(label));
          else if (label.indexOf("#" + room) < 0)
            out.push("a route into #" + room + " does not name it: " + JSON.stringify(label));
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    /* ROUND 17, D3. Boot → answer P1 from the pin. K2 becomes the topmost item
       and its WHY line reads "yours — you own it, and the cutover decision above
       cannot be executed until it is signed." Nothing above it is a decision:
       the cutover renders at y≈203 in the lens and y≈379 in the feed, both
       BELOW. Seeded as `K2.why`, rendered only in pinCard, never re-derived —
       true in the seed state, false one click from boot.
       The proposition survives (the runbook does block the cutover); the
       LOCATOR does not. This measures the geometry rather than reading the
       sentence, so it says where the thing actually is. */
    id: "R17-D3-a-rationale-does-not-locate-by-position",
    what: "no WHY line points at a neighbour by position that is not in that position",
    async run(page) {
      if (!await clickIn(page, '#pinList [data-obj="P1"] button[data-opt="0"]'))
        return "P1 offers no one-click option on the pin";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const objOf = id => {
          let f = null;
          Object.keys(S.rooms).forEach(k => (S.rooms[k].objects || []).forEach(o => { if (o.id === id) f = o; }));
          return f;
        };
        document.querySelectorAll("#pinList [data-obj]").forEach(card => {
          const why = card.querySelector(".why");
          if (!why) return;
          const t = (why.textContent || "").replace(/\s+/g, " ").trim();
          const m = /\b([a-z]+)\s+(above|below)\b/i.exec(t);
          if (!m) return;
          const kind = m[1].toLowerCase(), where = m[2].toLowerCase();
          const top = card.getBoundingClientRect().top;
          /* A ROW SCROLLED OUT OF ITS OWN PANE IS NOT ON SCREEN, and counting
             one would make this report contradict its own evidence — the first
             cut of this listed `D1 at y=-58 in #feed (above)` under the words
             "no decision renders above it". A rect is only where the reader sees
             it if it survives the viewport and every scroll box over it. */
          const onScreen = el => {
            let r = el.getBoundingClientRect();
            if (!r.width || !r.height) return false;
            if (r.bottom <= 0 || r.top >= innerHeight) return false;
            for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
              const cs = getComputedStyle(a);
              if (!/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflow)) continue;
              const b = a.getBoundingClientRect();
              if (r.bottom <= b.top || r.top >= b.bottom) return false;
            }
            return true;
          };
          const found = [];
          ["pinList", "lensBody", "feed"].forEach(hostId => {
            const host = document.getElementById(hostId);
            if (!host) return;
            host.querySelectorAll("[data-obj], [data-lens-obj]").forEach(el => {
              const o = objOf(el.dataset.obj || el.dataset.lensObj);
              if (!o || o.kind !== kind) return;
              if (o.id === card.dataset.obj) return;
              if (!onScreen(el)) return;
              const r = el.getBoundingClientRect();
              if (found.some(f => f.id === o.id && f.host === hostId)) return;
              found.push({ id: o.id, host: hostId, y: Math.round(r.top),
                           side: r.top < top ? "above" : "below" });
            });
          });
          /* "above" is about the surface the reader is looking at — this
             sentence is painted in the pin card, so the pin is where it has to
             be true. The other two surfaces are reported as context. */
          if (found.some(f => f.side === where && f.host === "pinList")) return;
          out.push("the WHY line on " + card.dataset.obj + " points at a " + kind + " " + where + " it — " +
                   JSON.stringify(t) + " — and no " + kind + " renders " + where + " it in the pin, which is where " +
                   "this sentence is painted. On screen: " +
                   (found.length ? found.map(f => f.id + " at y=" + f.y + " in #" + f.host + " (" + f.side + ")").join(", ")
                                 : "there is no other " + kind + " on screen at all") +
                   " · this card is at y=" + Math.round(top));
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    /* ROUND 17, D4. At 1120 — the declared floor — `.trace .tx` had scrollWidth
       624 against clientWidth 328 and painted `you came from #identity-service ·
       following the sourc…`, dropping "which #identity-service owes you". The
       ellipsis discloses the truncation and the visible prefix is true, which is
       why round 16's reviewer correctly declined to hold on it. It is here
       because it was the one element left in the file carrying `overflow:hidden;
       text-overflow:ellipsis; white-space:nowrap` — the same shape as round 12's
       D4 — and this file's own doctrine says a minted sentence wraps.
       The rule is the general one, so a new one cannot appear in silence. */
    id: "R17-D4-nothing-paints-a-sentence-into-an-ellipsis",
    what: "no visible element clips its own text behind an ellipsis",
    async run(page) {
      if (!await clickIn(page, '#railRooms .rrow[data-room="identity-service"]')) return "no route to #identity-service";
      if (!await clickIn(page, '#pinList [data-obj="X1"] button[data-jumproom]'))
        return "X1's pin card offers no cross-room route";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("body *").forEach(el => {
          if (el.closest("script, style, template")) return;
          const cs = getComputedStyle(el);
          if (cs.textOverflow !== "ellipsis") return;
          if (cs.display === "none" || cs.visibility === "hidden") return;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          if (el.scrollWidth <= el.clientWidth + 1) return;
          out.push("a visible element paints its own text into an ellipsis: scrollWidth " + el.scrollWidth +
                   " / clientWidth " + el.clientWidth + " on " + (el.id ? "#" + el.id : el.className || el.tagName) +
                   " — " + JSON.stringify((el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90)));
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    /* ROUND 16, D1. Round 15 closed round 14's D1 by giving the reply preview a
       route to the row it quotes — `go to it →`, revealed on the same hover as
       the row's `Reply` chip, which is `position: absolute` over the same strip
       of pixels. 42 of the label's 60px were painted over by `Reply`, at 1440,
       1366, 1279, 1160 and 1120 alike; `document.elementFromPoint` at the
       label's own CENTRE returned `<button data-reply="1">Reply</button>`, and
       the click that read "jump to what I am quoting" opened `REPLYING · lars`
       — a reply to your own message. Nothing was clipped, so the legibility rule
       passed; the occluder was visible and reachable, so both halves of the
       reachability pair passed. This drives the whole path with a real mouse. */
    id: "R16-D1-a-controls-label-is-not-painted-over",
    what: "the reply preview's route control is painted whole, and the point at its own centre hit-tests to it",
    async run(page) {
      const r = await hoverRow(page, "m6");
      if (!r) return "the 08:36 row is not in this room";
      const rb = await page.evaluate(() => {
        const b = document.querySelector('#feed .mrow[data-msg="m6"] .acts button[data-reply]');
        if (!b) return null;
        const q = b.getBoundingClientRect();
        return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
      });
      if (!rb) return "the 08:36 row offers no Reply";
      await page.mouse.click(rb.x, rb.y);
      await page.waitForTimeout(150);
      await page.click("#cinput");
      await page.keyboard.type("noted");
      await page.click("#sendBtn");
      await page.waitForTimeout(300);
      /* the quotation is in the row the send just created */
      const q = await page.evaluate(() => {
        const rows = document.querySelectorAll("#feed .mrow");
        const el = rows[rows.length - 1];
        const m = el && el.querySelector(".mreply");
        if (!m) return null;
        el.scrollIntoView({ block: "center" });
        const b = m.getBoundingClientRect();
        return { x: b.left + 60, y: b.top + b.height / 2 };
      });
      if (!q) return "the sent reply carries no quotation";
      await page.mouse.move(q.x, q.y);
      await page.waitForTimeout(200);
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const rows = document.querySelectorAll("#feed .mrow");
        const el = rows[rows.length - 1];
        const j = el && el.querySelector(".mreply .jump");
        if (!j) return ["the reply row carries no route to the row it quotes"];
        const b = j.getBoundingClientRect();
        const label = (j.textContent || "").trim();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (!(hit === j || j.contains(hit)))
          out.push("the point at the centre of " + JSON.stringify(label) + " hit-tests to something else — the click " +
                   "a reader aims at this control lands on " + JSON.stringify((hit && hit.outerHTML || "").slice(0, 60)));
        (window.__occl().findings || []).forEach(f => {
          if (f.text.indexOf("go to it") < 0) return;
          out.push("a control's own label is painted over by another control: " + JSON.stringify(label) + " loses " +
                   f.n + " character(s) / " + f.px + "px — " + JSON.stringify(f.covered) + " — under " + f.by +
                   " at " + f.w + "px");
        });
        return out;
      });
    }
  },
  {
    /* ROUND 16, D2. The same overlay, on its own row. `top: -9px` put the strip
       across 11px of the row's 15px first line box, so pointing at a row to read
       it was the act that made it unreadable: at 1440 mateo's 08:41 claim
       rendered `Eyeballed off last week's b` and then a chip, and at 1120 dana's
       08:31 lost `— almost all iOS`, 92px, mid-sentence. Measured per painted
       character, on the feed as it loads, it fires on 5 of 17 rows at 1440,
       6 at 1279 and 10 at both 1160 and 1120, in both themes. The count is the
       number this class is reported in, so the assertion prints it. */
    id: "R16-D2-a-row-hover-covers-none-of-the-rows-own-words",
    what: "hovering a message row paints its action strip over none of that row's own characters",
    async run() { return null; },
    async assert(page) {
      const msgs = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#feed .mrow")).map(el => el.dataset.msg).filter(Boolean));
      const out = [];
      /* ROWS, NOT FINDINGS. One hover can cover characters in two of the row's
         own text nodes — the body and the note — and "6 of 18 rows" is the
         number this defect is reported in. Counting findings would have printed
         a bigger number for the same defect and called them rows. */
      let rows = 0;
      for (const m of msgs) {
        if (!await hoverRow(page, m)) continue;
        const f = await page.evaluate(m => window.__occl().findings.filter(x => x.where === m), m);
        if (f.length) rows++;
        f.forEach(x => out.push("hovering a row covers " + x.n + " of its own characters (" + x.px + "px) — " +
          JSON.stringify(x.covered) + " out of " + JSON.stringify(x.text) + " — under " + x.by));
      }
      if (out.length) out.unshift(rows + " of " + msgs.length + " rows lose characters when hovered at " +
                                  (await page.evaluate(() => window.innerWidth)) + "px");
      return out;
    }
  },
  {
    /* ROUND 14, D1. The rail's owed badge mints thirteen verification reads and
       its entire sentence is the characters `3`. No COUNTED_CLAIMS pattern
       matches it, no field word is in it for checkVocabulary or
       checkQuantifiers, and say()'s own read-mutation is gated on a field word
       appearing in the sentence — so all thirteen read-mutations are skipped
       too. Four instruments, one sentence, silence. Measured in the DOM against
       the page's own tables, so it fires on r13 as committed. */
    id: "R14-D1-every-number-in-a-mint-is-read",
    what: "every numeral in a minted sentence is read by a pattern, a declared predicate, the record or a declared form",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        if (typeof window.__numberReach === "function") {
          window.__numberReach()
            .filter(l => /^mint\s+(UNREAD|UNDECLARED|DECLARED-NOTHING)/.test(l))
            .forEach(l => out.push("a number in a minted sentence is read by nothing: " + l));
          return Array.from(new Set(out));
        }
        /* THE FALLBACK EXISTS ONLY FOR OLDER BUILDS, which is why it is allowed
           to be a smaller rule than the page's: a minted sentence whose whole
           text is a bare numeral cannot be matched by any phrasing pattern, by
           construction, and needs no table to say so. */
        out.push("this build cannot say how any number in a minted sentence was read — window.__numberReach is missing");
        document.querySelectorAll("[data-said], [data-said-parts]").forEach(el => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!/^[\d\s/·,.-]*\d[\d\s/·,.-]*$/.test(t)) return;
          const box = (window.PAINTED || [])[Number(el.dataset.said != null ? el.dataset.said : el.dataset.saidParts)];
          const owners = box ? new Set((box.claims || []).map(c => c.of)) : null;
          out.push("a minted sentence's entire text is a numeral, so no phrasing pattern can reach it: " +
                   JSON.stringify(t) + (owners ? " (minted from " + (box.claims || []).length + " reads)" : ""));
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    /* ROUND 14, D2. Live at every supported width at or below 1279 and silent
       from 1280 up — which is why thirteen rounds of harnesses, all four of them
       pinned to 1440×900, never saw it. It truncates BECAUSE you cleared your
       work: `· 40 unread` is wider than `◆3`, and the name was the only flexible
       track. */
    id: "R14-D2-rail-name-at-narrow-widths",
    what: "no control's label is painted into an ellipsis at any supported width, after the writes that widen the badge",
    async run(page) {
      if (!await clickText(page, "Keep dual-write through 14 Aug")) return "P1's answer not offered";
      if (!await clickText(page, "Mark signed off")) return "K2's sign-off not offered";
      if (!await clickText(page, "Answer — retention is 90 days")) return "the one-click answer is not offered";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll(".rrow .nm, .rrow .ct, .rrow .pill").forEach(el => {
          const cs = getComputedStyle(el);
          const clips = cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis";
          if (clips && el.scrollWidth > el.clientWidth + 1)
            out.push("a rail row is painting a room name into an ellipsis at " + window.innerWidth + "px: " +
                     JSON.stringify((el.textContent || "").trim()) + " — scrollWidth " + el.scrollWidth +
                     " > clientWidth " + el.clientWidth);
        });
        return out;
      });
    }
  },
  {
    /* ROUND 14, D6. `#pinCount` paints `3 items · hardest first` from
       attention(r).length — `owedTo` AND a verification, over every object in
       the room — on the most prominent surface on the page, inside no mint and
       no declared subject. This walks the DOM for the shape rather than naming
       the surface: a numeral outside every mint, immediately followed by one of
       the page's own nouns for a RECORD. Rows, messages, people and rooms are
       not records and never trip it. */
    id: "R14-D6-a-count-of-records-is-minted",
    what: "no numeral outside a mint is followed by the page's own noun for a record",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const RECORD_NOUNS = /^(items?|objects?)$/i;
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(n) {
            const p = n.parentElement;
            if (!p || p.closest("script, style, template")) return NodeFilter.FILTER_REJECT;
            if (p.closest("[data-said], [data-said-parts]")) return NodeFilter.FILTER_REJECT;
            const cs = getComputedStyle(p);
            if (cs.display === "none" || cs.visibility === "hidden") return NodeFilter.FILTER_REJECT;
            return /\d/.test(String(n.nodeValue)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        });
        let n;
        while ((n = w.nextNode())) {
          const text = String(n.nodeValue).replace(/\s+/g, " ").trim();
          const m = text.match(/(\d+)\s+([A-Za-z]+)/);
          if (!m || !RECORD_NOUNS.test(m[2])) continue;
          const host = n.parentElement.closest("[id]");
          out.push("a count of records sits inside no mint: " + ((host && host.id) || n.parentElement.className) +
                   " · " + JSON.stringify(text.slice(0, 70)));
        }
        return Array.from(new Set(out));
      });
    }
  },
  {
    /* ROUND 14, D7. CONVENTIONS ¶477 says there is one deliberate clip on this
       page. There were two, and the second one is the room's own purpose line,
       under a CSS comment calling its removal a round-1 defect. */
    id: "R14-D7-the-topic-is-painted-whole",
    what: "the room's topic is not truncated at any supported width",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const el = document.getElementById("roomTopic");
        if (!el) return ["the room has no topic element"];
        return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
          ? ["the room's topic is truncated at " + window.innerWidth + "px: " + el.scrollWidth + " > " + el.clientWidth +
             " — " + JSON.stringify((el.textContent || "").trim().slice(0, 70))]
          : [];
      });
    }
  },
  {
    /* ROUND 14, D8. A permanent divider on the first screen ended mid-sentence
       — a dangling possessive introduced in ROUND 2 and painted unchanged
       through twelve review rounds, six with a reviewer driving the page.
       Nothing here read the English. */
    id: "R14-D8-no-unfinished-sentence",
    what: "no rendered line ends on a function word or a possessive with nothing after it",
    /* the SEEN FROM HERE divider — the one that ended mid-sentence — is painted
       only once the group has been marked seen, which is why "it is on the first
       screen" and "no run path" were both true and the line survived twelve
       rounds. One click brings it into existence. */
    async run(page) {
      if (!await clickText(page, "mark this group seen")) return "nothing marks the group seen";
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        if (typeof window.__proseFindings === "function")
          return window.__proseFindings().map(f => "a rendered line is unfinished: " + f);
        /* the same closed class, inlined, for a build that has no such rule.
           Prepositions and auxiliaries are out for the same reason they are out
           of the page's own list: English strands them legitimately. */
        const TAIL = ["a","an","the","these","those","its","their","your","our","every","each","another",
          "and","or","but","nor","because","although","though","whereas","unless","than","whether"];
        const out = [];
        document.querySelectorAll("body *").forEach(el => {
          if (el.children.length) return;
          if (el.closest("script, style, template, .htext, .hq, blockquote")) return;
          if (el.getAttribute("aria-hidden") === "true") return;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return;
          const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
          const body = raw.replace(/[\s·—–\-→←↑↓:;,.!?'"“”‘’()\[\]…]+$/u, "");
          if (!body || !/\s/.test(body)) return;
          const last = (body.match(/[\w'’-]+$/u) || [""])[0];
          if (!last) return;
          if (/['’]s$/i.test(last) || TAIL.indexOf(last.toLowerCase()) >= 0)
            out.push("a rendered line is unfinished: " + JSON.stringify(raw.length > 100 ? "…" + raw.slice(-95) : raw));
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    /* ROUND 14, D9. `chips count rows · NEEDS YOU counts the items behind them`
       — a two-clause reconciliation on the first screen, existing only because
       two surfaces printed the same words over different denominators. ¶118's
       own shape, one column left of the pane round 12 pruned. */
    id: "R14-D9-no-count-reconciliation-clause",
    what: "no divider prints a sentence whose only job is to tell two counts apart",
    async run(page) {
      await clickText(page, "Keep dual-write through 14 Aug");
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll(".syl .when, .syl").forEach(el => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (/count(s)? rows|counts the items behind|this counts the rows/i.test(t))
            out.push("a divider reconciles two counts in prose instead of naming their units: " +
                     JSON.stringify(t.slice(0, 120)));
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    /* ROUND 14, D10. `~ 6 of 10 unverified` in the pin trailer and `13 objects ·
       9 unverified` in the lens: two true counts of the same word over two
       scopes, and nothing on screen said the scopes differed. */
    id: "R14-D10-unverified-counts-carry-their-denominator",
    what: "every on-screen unverified count prints the set it is counting over",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        [["lensSummary", "the lens"], ["pinTrailer", "the pin trailer"]].forEach(([id, who]) => {
          const el = document.getElementById(id);
          if (!el) return;
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          const m = t.match(/(?:(\d+)\s+of\s+(\d+)|(\d+))\s+unverified/);
          if (!m) return;
          if (m[2] == null)
            out.push(who + ' prints "' + m[0] + '" with no denominator, and another surface on the same screen ' +
                     "counts the same word over a different set: " + JSON.stringify(t.slice(0, 80)));
        });
        return out;
      });
    }
  },
  {
    /* ROUND 14, the unreproduced observation, closed by deleting the mechanism.
       `.mrow .acts` was `position: absolute; z-index: 3; pointer-events: auto`
       and hit-testable at `opacity: 0`, clearing `#unmarkSeen` by 1.4px at
       1440. Eighteen randomised sessions of 40 real mouse clicks could not steal
       a click, and the round predicted that "a row-spacing change is all it
       would take". THE MECHANISM WAS NAMED RIGHT AND THE TRIGGER WAS GUESSED
       WRONG (round 16): no row spacing changed, round 15 added a control
       UNDERNEATH the overlay, and the two defects that followed are R16-D1 and
       R16-D2 above. This repro keeps the half it was written for — a control at
       zero opacity may not take the pointer — and pass 4 asks the question this
       one cannot: whether a control you CAN see is painted over by another one
       you can also see. */
    id: "R14-D11-invisible-controls-are-untouchable",
    what: "no control a reader cannot see takes the pointer",
    async run() { return null; },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("button, a[href], [tabindex]:not([tabindex='-1'])").forEach(el => {
          let o = 1;
          for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
            if (typeof p.getAnimations === "function" && p.getAnimations().some(a => a.playState === "running")) return;
            o *= Number(getComputedStyle(p).opacity);
          }
          if (o >= 0.01) return;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return;
          const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (h === el || (h && el.contains(h)))
            out.push("a control at zero opacity still takes the pointer: " +
                     JSON.stringify((el.textContent || "").trim().slice(0, 30)) + " in ." + el.parentElement.className);
        });
        return Array.from(new Set(out));
      });
    }
  },
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
        /* the lens carries its own denominator from round 14 (D10), so the
           count is the first number when there are two and the only one when
           there is one — the regression has to keep reading r12's phrasing */
        const a0 = lens.match(/(?:(\d+)\s+of\s+)?(\d+)\s+unverified/);
        const a = a0 && [a0[0], a0[1] != null ? a0[1] : a0[2]];
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
       subject and no mint, is a count no instrument on this page can see.

       AND ITS OWN SHAPE IS THE DOCTRINE'S BANNED ONE (round 14, D6). This is
       three remembered selectors — `surfNeedsN`, `surfStateN`, `#railRooms
       .pill` — and `#pinCount`, the most prominent surface on the page, was not
       among them for a whole round while painting `3 items · hardest first`
       from attention(r).length. It is KEPT, unchanged, because a regression's
       only value is that it still fires on the build it was written against, and
       changing its body would silently retire it. What replaces it is
       R14-D6-a-count-of-records-is-minted, which walks the DOM for the shape,
       and design/prototype-counts.txt, which is every numeral on screen and what
       read it, generated. A remembered list is now a regression, not a rule. */
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
  },
  {
    /* ROUND 15, D1. `plain(t.body).slice(0, 60)` in messageRow, unchanged since
       round 2. 11 of the 14 replyable rows in #users-migration are longer than
       60 characters and 9 of them were cut mid-word — presented as a person's
       words, with no ellipsis, no quotation marks, no title, no hover or focus
       expansion and no link to the source row.
       THIS FIRES ON r14 AS COMMITTED AT EVERY WIDTH: 11 assertions per width.
       WHY IT IS NOT A THIRD CHECKER OF THE SAME KIND. The page's provenance rule
       and its legibility rule both PASS on this string, honestly — a 60-char
       prefix really is contained in the message, and `scrollWidth ===
       clientWidth` on a string cut before painting. Neither is wrong; the defect
       is in the seam. So this states the COMPLIANT FORM positively rather than
       enumerating ways to truncate: a quotation of a person paints all of it, or
       paints a prefix that stops on a word boundary AND declares itself
       collapsed with an affordance the page's own `data-clamp` rule then holds
       to a keyboard. Anything else is a person being quoted saying something
       they did not finish saying. */
    id: "R15-D1-a-quotation-is-clamped-not-cut",
    what: "no rendered quotation of a person is shortened before it is painted",
    async run(page) {
      /* the reply previews do not exist until somebody replies: no fixture row
         carries `replyTo`, which is why thirteen rounds of state walks never
         painted one. Reply to every replyable row in the room. */
      return await page.evaluate(async () => {
        const r = S.rooms[S.roomId];
        const targets = r.messages.filter(m => !m.system && !m.routine).map(m => m.id);
        if (!targets.length) return "no replyable rows in this room";
        for (const id of targets) {
          startReply(id);
          document.getElementById("cinput").value = "ack " + id;
          send();
          await new Promise(res => setTimeout(res, 15));
        }
        return null;
      });
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('[data-quoted^="msg:"]').forEach(el => {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return;
          const [id, roomId] = el.getAttribute("data-quoted").replace(/^msg:/, "").split("@");
          const home = roomId ? S.rooms[roomId] : S.rooms[S.roomId];
          const m = home && home.messages.filter(x => x.id === id)[0];
          if (!m) return;                                   // the quotation rule owns that case
          const full = plain(m.body).replace(/\s+/g, " ").trim();
          let shown = (el.textContent || "").replace(/\s+/g, " ").trim();
          const hadEllipsis = /…$/.test(shown);
          shown = shown.replace(/…$/, "").trim();
          if (shown.length > 1 && /^[“"]/.test(shown) && /[”"]$/.test(shown)) shown = shown.slice(1, -1).trim();
          if (shown === full) return;                       // whole: compliant
          const declared = el.hasAttribute("data-clamp") || !!el.closest("[data-clamp]");
          const nextChar = full.charAt(shown.length);
          const midWord = full.indexOf(shown) === 0 && /[\w'’-]/.test(nextChar) &&
                          /[\w'’-]/.test(shown.charAt(shown.length - 1));
          if (midWord)
            out.push("a quotation stops mid-word and is presented as the person's words: …" +
                     JSON.stringify(shown.slice(-34)) + " — the record continues " + JSON.stringify(nextChar + full.slice(shown.length + 1, shown.length + 12)));
          else if (!declared && !hadEllipsis)
            out.push("a quotation is shortened before it is painted, with nothing on it saying so: " +
                     shown.length + " of " + full.length + " characters, …" + JSON.stringify(shown.slice(-34)));
        });
        return Array.from(new Set(out));
      });
    }
  },
  {
    /* ROUND 15, D2. `#cstate` sat under the composer on every screen in both
       rooms and read `interpretation runs on send · proposals land in Current
       state as ~ until accepted`. `send()` appends the message and does nothing
       else; nothing in the file ever appends to `r.objects`.
       THIS FIRES ON r14 AS COMMITTED AT EVERY WIDTH, and it is a BEHAVIOURAL
       check first: it types a message with the exact shape of the fixture rows
       that ARE objects, sends it, and asks the record whether the sentence under
       the box came true. The text clause only names which sentence made the
       promise. On r14 the object count does not move and the claim is on screen;
       on r15 the claim is gone, so neither half can fire. */
    id: "R15-D2-the-composer-states-what-the-page-does",
    what: "the composer's state line does not claim a behaviour sending does not produce",
    async run(page) {
      return await page.evaluate(async () => {
        const r = S.rooms[S.roomId];
        window.__r15d2 = { before: (r.objects || []).length,
                           claim: (document.getElementById("cstate").textContent || "").trim() };
        document.getElementById("cinput").value =
          "Proposal: hold opaque-token issuance open until the 14 Aug freeze, not the cutover";
        send();
        await new Promise(res => setTimeout(res, 30));
        return null;
      });
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        const st = window.__r15d2 || {};
        const r = S.rooms[S.roomId];
        const after = (r.objects || []).length;
        const grew = after > st.before;
        /* the two things the sentence promised, in the present indicative */
        const claimsInterpretation = /interpretation\s+runs\s+on\s+send/i.test(st.claim || "");
        const claimsLanding = /(proposals?|anything derived)\s+lands?\s+in\s+current\s+state/i.test(st.claim || "");
        if (!grew && (claimsInterpretation || claimsLanding))
          out.push("the composer states a behaviour the artifact does not have: " + JSON.stringify(st.claim) +
                   " — a proposal-shaped message was sent and the record went from " + st.before +
                   " objects to " + after);
        /* and the bound composer may not teach the unbound one's behaviour */
        document.querySelectorAll("#cstate").forEach(el => {
          if (/interpretation\s+is\s+skipped/i.test(el.textContent || ""))
            out.push("the bound composer says interpretation is SKIPPED, which tells the reader it otherwise runs: " +
                     JSON.stringify((el.textContent || "").trim()));
        });
        return out;
      });
    }
  },
  {
    /* ROUND 15, D3 and N5. `#rinput`'s placeholder carried the only statement
       anywhere that a typed reopen reason is recorded as your words verbatim —
       422px of text in a 193px box at 1440 and a 129px box at 1279 and below, so
       what a reader saw was `why are you reopening it? (`, ending on an unclosed
       parenthesis. The one fully readable sentence in the prompt was the hint,
       and the hint said the opposite: "nothing is ever written in yours".
       PLACEHOLDERS DO NOT CONTRIBUTE TO `scrollWidth`, which is why the page's
       own legibility rule cannot see this and a harness has to measure it: the
       text is painted by the control, not by the document. `#vinput` is the same
       class in the verify prompt (`…write-throughp` at 1279).
       THIS FIRES ON r14 AS COMMITTED: two clipped placeholders per width, plus
       the missing disclosure. */
    id: "R15-D3-a-prompt-is-readable-and-agrees-with-itself",
    what: "every placeholder fits its box at every supported width, and the reopen prompt discloses the attribution on screen",
    async run(page) {
      if (!await clickText(page, "Keep dual-write through 14 Aug")) return "P1's answer not offered";
      if (!await clickText(page, "the receipt for P1")) return "the transition row offers no receipt";
      if (!await clickText(page, "Reopen")) return "the receipt offers no Reopen";
      await page.evaluate(() => { const b = document.querySelector("[data-verify]"); if (b) b.click(); });
      await page.waitForTimeout(60);
      return null;
    },
    async assert(page) {
      return await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("input[placeholder], textarea[placeholder]").forEach(el => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || !el.placeholder) return;
          const cs = getComputedStyle(el);
          const c = document.createElement("canvas").getContext("2d");
          c.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + "/" + cs.lineHeight + " " + cs.fontFamily;
          const need = c.measureText(el.placeholder).width;
          const have = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          if (need <= have) return;
          let vis = el.placeholder;
          while (vis.length && c.measureText(vis).width > have) vis = vis.slice(0, -1);
          out.push("a prompt's own question is clipped at " + window.innerWidth + "px: #" + el.id + " needs " +
                   Math.round(need) + "px and has " + Math.round(have) + "px — a reader sees " + JSON.stringify(vis));
        });
        /* and the consequence of answering it is on screen at rest, in text that
           survives typing — not in the placeholder, which vanishes exactly when
           it becomes load-bearing */
        const box = document.querySelector('[data-prompt="reopen"]');
        if (box) {
          const hint = box.querySelector(".hint");
          const t = ((hint && hint.textContent) || "").replace(/\s+/g, " ");
          if (!/your own sentence|word for word|verbatim|attributed to you/i.test(t))
            out.push("the reopen prompt never says on screen that a typed reason is kept as your own words: " +
                     JSON.stringify(t.slice(0, 120)));
          if (/nothing is ever written in yours/i.test(t))
            out.push("the reopen prompt's only readable sentence contradicts what the write does — " +
                     "a typed reason IS rendered attributed, permanently: " + JSON.stringify(t.slice(0, 120)));
        }
        return Array.from(new Set(out));
      });
    }
  }
];

/* EVERY REPRO RUNS AT EVERY DECLARED WIDTH (round 14, D2). One of this round's
   own defects is invisible at 1440 and live at every width below 1280; a repro
   suite pinned to one viewport would have shipped it again. A repro that fires
   at only some widths says which. */
/* AND EVERY REPRO RUNS IN BOTH THEMES (round 17). Round 16's occlusion sweep
   ran light and dark and its two repros did not, which is one instrument's
   denominator being wider than another's inside the same run. The theme is one
   extra context per width and it is what the round's own contract asks for. */
const THEMES = String(argOf("--themes", "light,dark")).split(",").map(t => t.trim()).filter(Boolean);
async function passRepros(browser, log) {
  const rows = [];
  for (const rp of REPROS) {
    const widths = rp.widths || WIDTHS;
    const merged = { id: rp.id, what: rp.what, skip: null, errors: [], classes: [], asserts: [], firedAt: [], ranAt: widths.slice() };
    for (const width of widths) for (const theme of THEMES) {
      const at = "@" + width + "/" + theme;
      const { ctx, page, errors } = await newPage(browser, width);
      if (theme === "dark") { await page.click("#themeBtn"); await page.waitForTimeout(120); }
      const skip = await rp.run(page, width);
      await page.waitForTimeout(60);
      const inv = invariantsOnly(errors);
      const asserts = rp.assert ? await rp.assert(page, width) : [];
      await ctx.close();
      if (skip && !merged.skip) merged.skip = skip + " " + at;
      inv.forEach(t => merged.errors.push(at + "  " + t));
      asserts.forEach(t => merged.asserts.push(at + "  " + t));
      if (inv.length + asserts.length && merged.firedAt.indexOf(at) < 0) merged.firedAt.push(at);
    }
    merged.classes = Array.from(new Set(merged.errors.map(t => classOf(t.replace(/^@[\d]+\/\w+\s+/, "")))));
    rows.push(merged);
    const bad = merged.errors.length + merged.asserts.length;
    log(`  ${bad ? "FIRES" : "clean"}  ${rp.id} — ${merged.errors.length} console error(s), ${merged.classes.length} class(es), ` +
        `${merged.asserts.length} assertion(s) over ${widths.length} width(s) × ${THEMES.length} theme(s)` +
        (bad ? ` [fires at ${merged.firedAt.join(", ")} of ${widths.length * THEMES.length} width/theme pairs]` : "") +
        (merged.skip ? ` [path incomplete: ${merged.skip}]` : ""));
    merged.errors.slice(0, 6).forEach(t => log(`      ${t.slice(0, 210)}`));
    /* AN ASSERTION THAT REPORTS A COUNT PER WIDTH NEEDS EVERY WIDTH PRINTED
       (round 16). At 6 this printed the 1440 numbers and swallowed the other
       four, on a round whose whole point is that the severity nearly doubles
       from 1440 to 1120. A truncated report of a viewport-dependent measurement
       is a report about one viewport again. */
    merged.asserts.slice(0, 80).forEach(t => log(`      ! ${t}`));
  }
  return rows;
}

/* ===========================================================================
 * PASS 4 — NOTHING VISIBLE IS PAINTED OVER (round 16)
 *
 * The repros above pin the two defects this round fixed. This is the rule they
 * are instances of, driven over the surface rather than over a path: at every
 * declared width AND IN BOTH THEMES, sample the load state, then park a real
 * pointer on every on-screen control and every message row and sample again.
 * A hover affordance only exists while something is hovered, which is why this
 * pass and not a render-time checker is where the rule lives.
 *
 * BOTH THEMES, because r16's D2 was reported in both and a rule that runs in one
 * is a rule about one. The extra cost is one context per width.
 *
 * The denominator this pass enumerates FROM, and what it cannot see, is written
 * out where `OCCL` is defined. The short version: the occluder set is the
 * positioned-or-raised visible elements; the covered set is every painted
 * character; the states are the ones driven here, which is the load state plus
 * one hover per control — not every state the walk in pass 0 reaches.
 * ======================================================================== */
async function passOcclusion(browser, log) {
  const seen = new Map();
  let samples = 0, hovers = 0;
  for (const width of WIDTHS) {
    for (const theme of ["light", "dark"]) {
      const { ctx, page } = await newPage(browser, width);
      await page.waitForTimeout(250);
      if (theme === "dark") { await page.click("#themeBtn"); await page.waitForTimeout(250); }
      const take = async where => {
        samples++;
        const res = await page.evaluate(() => window.__occl());
        res.findings.forEach(f => {
          const k = `${f.owner}|${f.by}|${f.covered.slice(0, 14)}|${f.w}`;
          if (!seen.has(k)) seen.set(k, { ...f, at: where, theme });
        });
      };
      await take("load");
      const n = await page.evaluate(() => document.querySelectorAll("[data-ctl]").length);
      for (let i = 0; i < n; i++) {
        const at = await page.evaluate(i => {
          const el = document.querySelectorAll("[data-ctl]")[i];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, i);
        if (!at) continue;
        await page.mouse.move(at.x, at.y);
        await page.waitForTimeout(40);
        hovers++;
        await take("hovering control #" + i);
      }
      const msgs = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#feed .mrow")).map(el => el.dataset.msg).filter(Boolean));
      for (const m of msgs) {
        if (!await hoverRow(page, m)) continue;
        hovers++;
        await take("hovering row " + m);
      }
      await ctx.close();
    }
  }
  log(`  ${samples} samples over ${hovers} pointer positions, at ${WIDTHS.join(", ")} in light and dark`);
  const list = Array.from(seen.values());
  if (!list.length) log(`  nothing visible is painted over by anything else you can see`);
  list.forEach(f => log(`  PAINTED OVER @${f.w} ${f.theme}: ${f.n} character(s) / ${f.px}px of ${f.owner} (${f.where}) — ` +
    `${JSON.stringify(f.covered.slice(0, 40))} out of ${JSON.stringify(f.text)} — under ${f.by} [${f.at}]`));
  return { findings: list, samples, hovers };
}

/* --- main ------------------------------------------------------------------ */
const lines = [];
const log = s => { lines.push(s); console.log(s); };

const docFails = [];

const browser = await chromium.launch();
log(`driving ${FILE}`);

const SKIP_WALK = ONLY === "repros" || ONLY === "occlusion";
if (!SKIP_WALK) log("\n[0] write-sequence enumeration over reachable states");
else log(`\n[0] SKIPPED (--only ${ONLY}): no state walk, so no denominator is reported for this run`);
const sq = SKIP_WALK
  ? { seen: new Map(), levels: [], violations: [], drivenSteps: new Set(), offeredSteps: new Set(),
      unreachable: new Map(), ctlSeen: new Map(), uncovered: new Set(), numbers: new Set(), depth: 0, budget: 0 }
  : await passSequences(browser, log);
if (!SKIP_WALK) log(`  invariant violations during sequence enumeration: ${sq.violations.length}`);
if (!SKIP_WALK) {
  const cls = new Map();
  sq.violations.forEach(v => { const c = classOf(v.text); if (!cls.has(c)) cls.set(c, v); });
  cls.forEach((v, c) => { log(`     ${c}`); log(`        path: ${v.path.join("  →  ") || "(on load)"}`); });
}
if (!SKIP_WALK) {
  const notDriven = Array.from(sq.offeredSteps).filter(s => !sq.drivenSteps.has(s)).sort();
  log(`  (object, action, driver) steps offered: ${sq.offeredSteps.size} · driven: ${sq.drivenSteps.size}`);
  /* a starved load is an environment fact and it is reported, not swallowed */
  if (SEQ_RELOADS) log(`  state loads that timed out and were retried: ${SEQ_RELOADS} (bounded at one retry each)`);
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
if (!SKIP_WALK) {
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

/* --- THE NUMBER-READING REACH, GENERATED (round 14, D1) --------------------
   Round 13's page said, in a comment, that a number whose phrasing matched none
   of eight patterns "is not checked; that is a real gap and it is stated rather
   than discovered". It was neither stated accurately nor discovered: the rail's
   owed badge minted thirteen reads and said the characters `3`, and every
   instrument on the page was silent on it. So the reach of the number rules is
   this file — every numeral on screen, digits normalised to `#`, with what read
   it — produced by the same function the checker calls, unioned over the same
   fixed set of states as the uncovered artifact, and compared on every run.
   The `page` rows are the counters that speak for no record. That set used to
   be a six-item list in CONVENTIONS.md, and it was wrong about two of its six
   for a full round after the code moved. */
const COUNTS_OUT = argOf("--counts", "");
const numberLines = Array.from(sq.numbers).sort();
if (!SKIP_WALK) {
  const wanted = path.join(HERE, "prototype-counts.txt");
  const unread = numberLines.filter(l => /^mint\s+(UNREAD|UNDECLARED|DECLARED-NOTHING|UNMEASURED|MISMEASURED)/.test(l));
  const header =
    "# EVERY NUMBER ON SCREEN, AND WHAT READ IT — generated, do not hand-edit.\n" +
    "#\n" +
    "# Produced by window.__numberReach() in design/prototype-frame.html, unioned over\n" +
    "# every state design/prototype-drive.mjs reaches, and regenerated by\n" +
    "#   node design/prototype-drive.mjs --counts design/prototype-counts.txt\n" +
    "#\n" +
    "# mint rows: a numeral inside a minted sentence, and the form that reads it —\n" +
    "#   pattern:<id>   a COUNTED_CLAIMS phrasing, re-derived from the sentence's records\n" +
    "#   declared:<id>  the sentence names its own predicate (COUNT_PREDICATES), re-derived\n" +
    "#   record         a number the sentence read out of a value it declares\n" +
    "#   quoted         a fragment the sentence reproduces verbatim out of the record\n" +
    "#   transcribed    the sentence declares no reads at all, so it computed nothing —\n" +
    "#                  a seeded fixture line, minted so the record owns its characters\n" +
    "#   form:<id>      a declared non-count shape: a clock time, a date, an amount\n" +
    "#                  of money, a percentage\n" +
    "#   measured       a duration, re-derived from the two record timestamps the\n" +
    "#                  sentence named — not a shape. A duration used to be filed as\n" +
    "#                  form:duration, which asked whether `3h` LOOKED like a duration\n" +
    "#                  and never what it was a duration FROM (round 17, D1).\n" +
    "#   UNREAD         no check on this page can read it. This is a defect and the\n" +
    "#                  page's console says so on the paint that renders it.\n" +
    "#   UNMEASURED     a duration the sentence measured nothing for, and\n" +
    "#   MISMEASURED    one whose two named timestamps no longer give it. Both are\n" +
    "#                  defects and the console says so on the paint that renders them.\n" +
    "# page rows: a numeral in no minted sentence — row counters, message counters,\n" +
    "#   page furniture, and record text the page reprints outside a mint. Not an error\n" +
    "#   list: a count of rows is not a claim about a record. This is the set\n" +
    "#   CONVENTIONS.md used to name from memory, and was wrong about, for a round.\n" +
    "#   The toast is excluded: it is minted, and painted with textContent because it\n" +
    "#   is raised after its render — checkToastInvariant() re-reads it.\n" +
    "#\n" +
    "# Digits are normalised to `#`: the claim is about FORMS, not about values.\n" +
    "# subject: the union over every state reachable in 0, 1 or 2 writes.\n" +
    "#\n" +
    `# rows: ${numberLines.length} · mint rows unread: ${unread.length}\n`;
  const body = header + numberLines.map(l => l + "\n").join("");
  if (COUNTS_OUT) { fs.writeFileSync(COUNTS_OUT, body); log(`\n  wrote ${COUNTS_OUT} (${numberLines.length} row(s))`); }
  if (!numberLines.length) {
    log(`\n  NUMBER-REACH ARTIFACT IS EMPTY: window.__numberReach() produced nothing — this build cannot say ` +
        `how any number in a minted sentence was read, which is the exact shape of round 13's silent contradiction`);
    docFails.push("the page reports no reading for any number");
  }
  if (unread.length) {
    log(`\n  ${unread.length} NUMBER(S) IN MINTED SENTENCES THAT NO CHECK CAN READ:`);
    unread.forEach(l => log(`     ${l}`));
    docFails.push(`${unread.length} number(s) in minted sentences are read by nothing`);
  }
  const committed = fs.existsSync(wanted) ? fs.readFileSync(wanted, "utf8") : null;
  if (committed == null) {
    log(`\n  NUMBER-REACH ARTIFACT MISSING: ${wanted} does not exist — the reach of the number rules is claimed ` +
        `in a comment and written down nowhere`);
    docFails.push("the number-reach artifact is missing");
  } else {
    const live = numberLines.join("\n");
    const have = committed.split("\n").filter(l => l && l[0] !== "#").join("\n");
    if (live !== have) {
      log(`\n  NUMBER-REACH ARTIFACT IS STALE: the committed file and the live walk disagree`);
      const liveSet = new Set(numberLines), haveSet = new Set(have.split("\n").filter(Boolean));
      numberLines.filter(l => !haveSet.has(l)).forEach(l => log(`     + live only: ${l}`));
      Array.from(haveSet).filter(l => !liveSet.has(l)).forEach(l => log(`     - file only: ${l}`));
      docFails.push("the number-reach artifact does not match the live walk");
    } else {
      log(`\n  number-reach artifact matches the live walk (${numberLines.length} row(s), ${unread.length} unread)`);
    }
  }
}

if (!SKIP_WALK) log("\n[1] deliberate enumeration");
const en = SKIP_WALK ? { seen: new Map(), violations: [], sessions: 0 } : await passEnumerate(browser, log);
const all = Array.from(en.seen.entries());
const driven = all.filter(([, v]) => v.driven);
const notDriven = all.filter(([, v]) => !v.driven);
if (!SKIP_WALK) {
  log(`  controls enumerated: ${all.length}`);
  log(`  controls driven:     ${driven.length}`);
  log(`  not driven:          ${notDriven.length}`);
  notDriven.forEach(([k, v]) => log(`     - ${k}   [${v.reason || "reachable but never selected"}]`));
  log(`  invariant violations during enumeration: ${en.violations.length}`);
  const cls = new Map();
  en.violations.forEach(v => { const c = classOf(v.text); if (!cls.has(c)) cls.set(c, v); });
  cls.forEach((v, c) => { log(`     ${c}`); log(`        path: ${v.path.slice(-4).join("  →  ")}`); });
}

if (!SKIP_WALK) log("\n[2] randomised on top");
const rn = SKIP_WALK ? { violations: [], clicks: 0 } : await passRandom(browser, log);
if (!SKIP_WALK) {
  log(`  invariant violations during random drive: ${rn.violations.length}`);
  const cls = new Map();
  rn.violations.forEach(v => { const c = classOf(v.text); if (!cls.has(c)) cls.set(c, v); });
  cls.forEach((v, c) => { log(`     ${c}`); log(`        path: ${v.path.slice(-4).join("  →  ")}`); });
}

const SKIP_REPROS = ONLY === "occlusion";
log(SKIP_REPROS ? "\n[3] SKIPPED (--only occlusion)" : "\n[3] scripted repros");
const rp = SKIP_REPROS ? [] : await passRepros(browser, log);

const SKIP_OCCL = ONLY === "repros";
log(SKIP_OCCL ? "\n[4] SKIPPED (--only repros): the occlusion sweep is not part of the repro suite"
              : "\n[4] nothing visible is painted over (round 16)");
const oc = SKIP_OCCL ? { findings: [], samples: 0, hovers: 0 } : await passOcclusion(browser, log);

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
if (SKIP_WALK) log(`  --only ${ONLY}: no controls enumerated, no states walked, no artifact compared. This run reports ` +
                   `${SKIP_REPROS ? "the occlusion sweep" : SKIP_OCCL ? "the repro suite" : "passes 3 and 4"} at ` +
                   `${WIDTHS.join(", ")} in ${THEMES.join(" and ")} and NOTHING ELSE — it is not a denominator.`);
if (!SKIP_WALK) {
log(`  controls enumerated (union over every state reached): ${inventory.size}`);
log(`  controls driven:                                      ${drivenKeys}`);
log(`  states reached at depth ${sq.depth}:${" ".repeat(Math.max(1, 29 - String(sq.depth).length))}${statesReached}`);
log(`  write steps offered / driven: ${sq.offeredSteps.size} / ${sq.drivenSteps.size}`);
/* THE VIEWPORT IS PART OF THE DENOMINATOR AND THE REPORT SAYS SO (round 14, D2) */
log(`  viewports: enumeration at ${SEQ_WIDTH}x${HEIGHT} · enumeration/random/repro passes at ${WIDTHS.join(", ")} (height ${HEIGHT})`);
sq.levels.forEach(l => log(`     depth ${l.depth}: ${l.states} new state(s) from ${l.transitions} transition(s)` +
  (l.truncated ? ` · ${l.truncated} state(s) LEFT UNEXPANDED (budget ${sq.budget})` : "") +
  (l.frontier ? ` · ranking: ${l.inertCtl}/${l.frontier} tied at zero control novelty, ${l.inertBoth} still tied after step novelty` : "")));
{
  /* AND THE RANKING SAYS WHERE IT STOPS MEANING ANYTHING (round 14, D3).
     THE FIRST VERSION OF THIS SENTENCE WAS FALSE, and the round's own first
     depth-3 run is what said so: it asked whether EVERY state on the level ties,
     and at depth 3 the answer was 117 of 184 — so it printed "the ranking
     discriminates at every truncated level" while the budget cut fell in the
     middle of a 117-state block the ranking cannot tell apart. What matters is
     not whether the keys separate SOME states; it is whether they separate the
     states either side of the cut. If the states the keys CAN rank all fit
     inside the budget, then everything after them was chosen by signature, and
     that is the arbitrary sample this round was told to stop calling a policy.
     The second key (offered-step novelty) was added here and MEASURED NOT TO
     HELP at depth 3: 117 tied on controls, 117 still tied after steps. It is
     kept because it costs nothing and separates cheaply at shallower levels, and
     the honest report is this line, not the key. */
  const cut = sq.levels.filter(l => l.truncated && l.frontier && (l.frontier - l.inertBoth) <= l.expanded);
  const partial = sq.levels.filter(l => l.truncated && l.frontier && l.inertBoth && (l.frontier - l.inertBoth) > l.expanded);
  if (cut.length)
    cut.forEach(l => log(`  THE FRONTIER RANKING DID NOT CHOOSE AT DEPTH ${l.depth} — ${l.inertBoth} of ${l.frontier} ` +
      `states tie on both novelty keys and only ${l.frontier - l.inertBoth} could be ranked at all, so the budget ` +
      `boundary (${l.expanded} expanded, ${l.truncated} dropped) fell inside the tied block and SIGNATURE ORDER picked ` +
      `which of them to expand. That is an arbitrary sample of this level, not a covered one.`));
  if (partial.length)
    partial.forEach(l => log(`  the frontier ranking chose the expanded set at depth ${l.depth} (${l.inertBoth} of ` +
      `${l.frontier} tied, but the cut falls above the tied block)`));
  if (!cut.length && !partial.length)
    log(`  no level was truncated, so the frontier ranking never had to choose`);
}
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
}
if (docFails.length) log(`  DOCUMENTATION CHECKS FAILED (${docFails.length}): ${docFails.join(" · ")}`);
log(`  violations — sequence ${sq.violations.length} · enumeration ${en.violations.length} · ` +
    `random ${rn.violations.length} · repro console ${rp.reduce((n, r) => n + r.errors.length, 0)} · ` +
    `repro assertions ${assertFails} · occlusions ${oc.findings.length} · distinct classes ${totalClasses.size}`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    file: FILE,
    controls: { enumerated: inventory.size, driven: drivenKeys,
                unexercised: Array.from(inventory.entries()).filter(([, v]) => !v.driven).map(([k, v]) => ({ key: k, visible: v.visible })) },
    sequences: { depth: sq.depth, budget: sq.budget, statesReached, levels: sq.levels,
                 stepsOffered: Array.from(sq.offeredSteps).sort(),
                 stepsNotDriven: Array.from(sq.offeredSteps).filter(s => !sq.drivenSteps.has(s)).sort() },
    sequenceViolations: sq.violations, enumeration: en.violations, random: rn.violations, repros: rp,
    occlusion: { samples: oc.samples, hovers: oc.hovers, findings: oc.findings },
    distinctClasses: Array.from(totalClasses)
  }, null, 2));
}

process.exit(totalClasses.size || assertFails || docFails.length || oc.findings.length ? 1 : 0);
