# Scout brief — "early" group: Atrium Prototype / Atrium Variants / Atrium v2

Source files (design-canvas `.dc.html`, custom templating with `sc-if`/`sc-for` bindings, a `<script type="text/x-dc">` render-function body, and inline-styled markup):
- `Atrium Prototype.dc.html` — 288KB, 2742 lines. Single interactive app prototype (no `design_doc_mode=canvas` meta — this is a live, stateful UI, not a static gallery).
- `Atrium Variants.dc.html` — 52KB, 366 lines. A `design_doc_mode="canvas"` gallery of 5 static full-screen explorations, side by side.
- `Atrium v2.dc.html` — 313KB, 2985 lines. Same shape as Prototype (single interactive app), evolved forward.

Page `<title>` embedded as a tooltip/title attribute in both Prototype and v2: **"Atrium — many agents, many paths, one shared context"**.

---

## 1. What each file contains

### Atrium Variants.dc.html
Header text on the canvas itself: **"Atrium — five directions"** / subhead: *"same screen everywhere: #fleet · live call · pinned tree with an owed gate + merge · 1340×820 each"*. Five labeled, fully-built static frames (1340×820px each), all depicting the identical scenario (same room, same agents, same pending gate/merge) rendered in five different visual directions:

- **1a "paper ledger"** — label: *"airy light, quiet brand, card pin"*. Light cream palette (`#EFEBE2`/`#F4F1EA`), pine-green icon rail (`#173A32`), Inter body / IBM Plex Mono for the message feed, rounded cards, pill buttons, right-hand call pane with round avatar-initial bubbles.
- **1b "terminal dense"** — label: *"dark, mono everything, captions as ticker"*. Full dark terminal aesthetic (`#141715` bg), IBM Plex Mono everywhere, tab-strip like a code editor, ticker caption bar for live speech, bracket-style keyboard hints (`[y] scrub`, `[n] keep`).
- **1c "canopy loud"** — label: *"brand-forward, pine header, branching tree"*. Big pine (`#173A32`) top header bar with logo + live badge, left rail literally titled "THE CANOPY" rendered as a branching tree (SVG lines + circles) of room → agents → sub-units, "Two things need you" hero card row, Sora display font for headings.
- **1d "voice-first console"** — label: *"dark pine, captions center stage"*. Dark green (`#0F2019`), bottom third of screen is a big live-caption bar with a glowing speaking-avatar and giant text (word-by-word caption growth), agent chip row up top, screen-share pane on the right ("PRIYA'S SCREEN").
- **1e "wildcard"** — label: *"the fleet as a living process map"*. A literal node-and-edge diagram (SVG graph) of the room as a process tree — circles for room/agents/sub-tasks connected by lines, a floating gate card, a folded ticker sidebar, a legend box (glyph key, see §4). Explicitly framed as "list view ⇄ map view" toggle affordance.

All five variants render the **same fixed scenario**: #fleet room, agents hexi/charm/mote, a live call with lars+priya+atrium, an amber "needs you" gate on `charm/tests` (production emails in fixtures — scrub or keep), and a red "cannot be undone" merge decision (PR #482 → main, hold-to-arm).

### Atrium Prototype.dc.html
A fully wired, stateful single-page prototype (React-like class component, `state = {...}`, `render()`), not a set of static frames. One canonical shell (rail + rooms/agents list + workspace + call pane) with dozens of `sc-if`-gated overlay states: context menus, settings modal, mention autocomplete, share picker, drag-invite, agent search, gate/merge decision cards, plan view, sessions list, terminal view, stat pills (loop/usage/spend) with a configurable-visibility popover, "view as" (impersonation preview) banner, toasts, tabs.

### Atrium v2.dc.html
Structurally identical shell/state machine to Prototype but a materially deeper feature layer (see §6). Same 1340px+ shell, same green/cream/pine token set, one new CSS var and new interaction affordances.

---

## 2. Information architecture (mocked app frame regions)

Consistent across Prototype and v2 (and echoed, with cosmetic variation, across all 5 Variants):

- **Icon rail** (far left, ~56px, pine `#173A32` bg) — app logo (a stylized headset/mic glyph: arc + vertical line), workspace switcher tiles (letter avatars, e.g. "D" for dagon, "A" for atrium), user avatar pinned to the bottom.
- **Rooms/agents sidebar** (left, resizable `railW`, default 232px) — sectioned list: **ROOMS** (#fleet, #ops), **AGENTS** (hexi, charm, mote, nova, ivy, sage, wren, moss, pika, juno, dot, birch — searchable via an inline agent-search toggle), **HUMANS** (priya, carol). Each row carries a status glyph, unread badge, and drag handle (rows are draggable to invite into a channel / share into the call).
- **Workspace/tab strip** — open rooms/agents/DMs/files/streams/terminals as browser-like tabs (`tabs: ['fleet']` growing as you drill in); breadcrumb trail for nested focus (room → agent → sub-unit → terminal/plan/decision).
- **Main content pane** — per view: room chat feed (#fleet/#ops), agent channel feed, a "pinned tree" of live rows (agents/units with inline needs-you gates and destructive-decision cards that stay pinned above the fold), a "plan" view (goal + approach + steps + linked receipts) when drilling into an orchestrator like charm, a sessions list, or a terminal view.
- **Composer** — bottom message bar, `@`-mention autocomplete (agents/people/files, color-coded chips), file attach, emoji/react, reply-to threading.
- **Call pane** (right, resizable `callW`, default 350px) — participant avatar strip (colored initials), live transcript/captions with word-by-word "speaking" animation, mic/camera/leave controls, screen-share viewer, picture-in-picture pop-out (`pip` state with x/y/w/h), "tile all streams" grid mode for multiple simultaneous shares.
- **Settings modal** — room name, member list (add/remove), per-agent access control (none / read / read+write) via a 3-way toggle row.

---

## 3. Design tokens

Both Prototype and v2 share **one CSS custom-property system**, defined once in `:root` (light) and overridden in `html.atr-dark` (dark), toggled via `atrium-theme` localStorage + a `theme` prop (`light`/`dark` enum).

**Palette structure** (semantic naming, not raw color names):
- `--strip`, `--stile`, `--stileac`, `--stbd`, `--stx`, `--stxac` — the icon-rail ("strip"/"stile") colors.
- `--bg0`…`--bg7` — 8-step background scale (page → card → hover → elevated).
- `--line`, `--line2`, `--line3` — 3-step border scale.
- `--tx0`…`--tx4` — 5-step text scale (0 = primary/black, 4 = faintest).
- `--grn`, `--grn2`, `--grn3`, `--grnbd`, `--grnbg`, `--grnav` — green (healthy/live/verified) family.
- `--amb`, `--amb2`, `--ambbd`, `--ambbd2`, `--ambbg`…`--ambbg5` — amber (needs-you/gate) family.
- `--red`, `--red2`, `--red3`, `--redbd`, `--redbg`, `--redbg2`, `--redbg3` — red (destructive/failed) family.
- `--blu`, `--blu2`, `--blu3` — blue (links, human-identity accents).
- `--replybg`, `--filebg`, `--filebd` — reply-quote and file-chip backgrounds.

Light values: warm cream/paper (`--bg0:#E6E2DA`, `--bg1:#F4F1EA`), pine-green rail (`--strip:#173A32`), forest green accents (`--grn:#4E9161`), warm amber (`--amb:#B07D2A`), brick red (`--red:#B3402E`), muted blue (`--blu:#3D6BB3`).
Dark values: near-black backgrounds (`--bg0:#0a0b0c`), brighter saturated accents for contrast (`--grn:#5CB27A`, `--amb:#C99A3F`, `--red:#D4604A`, `--blu:#8AB4F8`).

**Fonts**: Google Fonts — **Inter** (400/500/600/700, body UI), **IBM Plex Mono** (400/500/600 + italic 400, terminal/log/timestamp text), **Sora** (600/700, display headings/wordmark only). Base body font-size 12.5px; the whole shell is designed at a dense, information-heavy scale (component text ranges ~10–16px, most UI chrome at 11–13px, headings at 15–20px Sora).

**Spacing**: no formal scale variables — spacing is ad hoc px values in inline styles (commonly 6/8/10/12/14/16/18/22px steps), border-radius commonly 8–14px for cards, 999px for pills/composer/avatars.

**v2-only token addition**: `--live: #9BB3A0` (light) / `#3E5748` (dark) — a desaturated, muted green distinct from `--grn`. See §6.

---

## 4. Recurring components and patterns

**Status glyph system** (consistent across all three files), used for both agent/unit state and message/event provenance:
- `●` solid dot = live/running (agent actively working, or a live event)
- `◎` ringed dot = orchestrating (an agent that is itself running a crew/sub-units, e.g. charm)
- `○` open circle = idle/resting/not running
- `✗` = failed
- `◆` (amber diamond) = **needs you** — a gate/escalation waiting on a human decision
- `■` (red square) = **destructive** — an irreversible action waiting on human approval (merge, etc.)
- `✓` (green check) = verified by the system (not by the agent's own claim)
- `~` = the agent's **own account** of what happened — explicitly tagged "not verified" (tooltip: *"the agent's own account — not verified"*); in v2 these get a dotted underline (`claimDec: 'underline'`) to visually distinguish unverified self-report from system-verified fact.
- `·` = neutral/informational log line
- `↪`/`↩` = "steer" — a message that got routed by the loop to a specific running session (tooltip: *"steer — routed by the loop"*)

A **glyph legend** is explicitly rendered in Variant 1e: "● running / ◌ orchestrating" and "◆ needs you / ■ destructive" (note: the legend uses `◌` for orchestrating in that one exploration frame, vs. the settled `◎` used everywhere in Prototype/v2 — a discarded glyph choice).

**Needs-you / gate cards**: amber-bordered inline cards embedded directly in the row/tree where the blocking unit lives (not a separate inbox) — e.g. `charm/tests` gate: *"Fixtures contain production emails — scrub or keep?"* with `scrub`/`keep` buttons and an "escalated · 4m" timestamp. Philosophy line baked into copy: *"needs you first · everything else folds"* (Variant 1a).

**Destructive/irreversible decision cards**: red-bordered, always **click-only** (never voice-approvable) — explicit copy across every variant: *"voice can't approve — records who + when"* / *"voice can never approve the merge — that click stays here"*. Interaction is **hold-to-arm**: a press-and-hold button that fills a 2-second progress bar (`armPct`, animated `arming` state) before the destructive action fires — deliberately friction-adding to prevent accidental clicks.

**Pinned tree / room tree**: the room's live agents and their sub-units render as a nested, indented list ("the pinned tree") directly in the main chat pane header area, so gates/decisions stay visible above the fold regardless of chat scroll position. Rows support **focus** (click collapses siblings to 35% opacity and shows that row's own chat below — "focus this one"), drag targets, and right-click context menus.

**Sessions / crew units**: an orchestrator agent (charm) has a `plan` (itself, e.g. "orch") plus named sub-sessions/crew units (`charm/backfill`, `charm/tests`, and in v2's receipt data also `charm/schema`, `charm/dual-write`, `charm/chunk plan`) each with its own live/settled state, harness, ctx%, turn count, $/h burn rate.

**Stat pills** (loop / usage / spend): small inline meter chips next to a room/agent header showing % context/loop fill and % usage-window fill as segmented bar sprites (14 or 20 discrete segments), plus a `$/h` spend readout. Visibility is user-configurable per-key via a popover: **"always" / "when it matters" (auto-near-threshold) / "off"**, with drag-reorderable priority. Clicking a pill opens a "deep dive" breakdown (e.g. LOOP context composition: system prompt / room history / roster; USAGE: harness name, 5-hour window %, weekly limit %).

**Terminal view**: opening a running session shows a raw agent terminal/log pane (`term:<agent>~<session>`), with an "interrupt the turn" action (labelled as safe-point interrupt, not a hard kill) and an "agent profile — model · budget · autonomy" side action.

**Call/transcript UI**: colored-initial avatar circles per participant (consistent scheme: L=lars blue, P=priya purple, A=atrium/agent green), live captions that grow word-by-word (`speak()` runs a 130ms/word interval), a running transcript log of Q&A turns, mic/camera/end-call icon row, screen-share picker (`sharePicker`/`shareSource`), and a floating picture-in-picture mini-call widget with draggable position (`pip.x/y`) and resizable dimensions.

**Composer**: `@`-mention autocomplete resolves against a fixed `CANDIDATES` list mixing **agents**, **people**, and **files** with distinct color codings (agent=amber, person=blue, file=blue/dashed "links existing" vs "inline + upload"). Drag-and-drop a person's avatar onto a channel row invites them (`dropInvite`), producing an audit-log event: *"invited to this channel — joins on accept · recorded"*.

**Settings**: per-room member management (add via `/invite name`, remove), and **per-agent access control** as a 3-state toggle: `none / read / read+write`, shown per agent with its current role sub-label (e.g. charm: "orchestrator · crew 3").

**"View as" preview mode**: an admin can preview the room as a lower-permission member; banner copy: *"previewing as {name} — same tree, their doors: no terminals, decisions read-only, room chat allowed"*.

---

## 5. Object model (as rendered)

- **Room** (`#fleet`, `#ops`) — a shared channel with its own chat feed, member list, pinned tree of agents, and settings. Rooms are created on demand (`createRoom`), get a system event on creation: *"room created by lars — invite people or give agents access via manage ⚙"*.
- **Agent** — a named actor (hexi, charm, mote, nova, ivy, sage, wren, moss, pika, juno, dot, birch) with: a status glyph, one or more **sessions** (running units of work), a **harness** (`claude code`, `codex cli`, `omp`, `fable 5` — each with its own plan tier: team/max/pro/metered), a **host** (`atrium cloud · always on`, or a specific human's machine, e.g. `mote` only runs while carol is online — `away: true` when offline), an **owner** human, per-room **access level** (none/read/read+write), and a channel/DM-style chat log (`agentLogs[agentKey]`).
- **Orchestrator agent** (charm) — a special agent whose "session" is itself a **plan** (goal text, approach paragraph, ordered steps) that fans out into **crew sub-units** rendered as nested channels (`charm/backfill`, `charm/tests`, and in v2's data model also `charm/schema`, `charm/dual-write`, `charm/chunk plan`), each independently live/settled, each with its own harness/spend separate from the parent's.
- **Session** — one unit of running (or settled/failed) work under an agent: key, glyph, live/settled/failed flag, task description, elapsed time, and a right-aligned metrics string (ctx% · turn N · $/h, or chunk progress, or "settled HH:MM").
- **Human** — lars (you, admin), priya (engineer), carol (ops) — each with online/away status, a role sublabel, and (in v2) a richer status/prefs model (`meStatus`, `mePrefs: {ringCalls, needsYou, quietHours}`).
- **Gate** — a human-decision checkpoint raised by an agent when it can't proceed without judgment (amber, reversible, inline in the tree, e.g. "scrub or keep" fixtures).
- **Decision** — an irreversible/destructive action awaiting explicit human authorization (red, hold-to-arm, click-only, e.g. merge to main).
- **Event** — an atomic timeline entry (`{t, g (glyph), a (author), text}`) rendered in a room or agent feed; carries provenance via its glyph (verified/claimed/failed/steered/etc.) and can carry `@mentions` as styled inline chips.
- **Turn** — a call-transcript entry (`{who, at, text}`) distinct from room `events` — the voice conversation is a parallel record to the text chat, not merged into it (though a room event can reference the call, e.g. "you and priya joined — transcript on the right").
- **Server/host** (Variants only, `SERVERS` rail section) — infra the fleet's agents run on/against: `dagon · acme @2 · lab 4`. Not present as a rail section in Prototype/v2 (folded into per-agent `host` metadata instead — see Evolution).
- **Receipt** (v2 only — see §6) — a structured, closable record of a settled session: what happened (system-verified lines vs. agent-claimed lines vs. explicitly-unverified lines), verification checks run, artifacts produced, linked plan/sibling-session references, and a side "SESSION"/"APPROVED BY" metadata block.

**Hierarchy expressed in the UI**: Room → Agent → Session/Sub-unit → Terminal (live) or Receipt (settled). An orchestrator agent additionally exposes Room → Agent(orchestrator) → Plan → Steps → linked Receipts, i.e. the plan is a first-class view sitting between the agent and its sub-sessions.

---

## 6. Evolution within this group: Prototype → Variants → v2

(Files carry no explicit version dates; ordering here is inferred from `<title>` continuity, code complexity, and the Variants file's role as a *design-space exploration document* — its own header says "five directions", i.e. divergent explorations of the *same* fixed scenario that appears already-settled in Prototype. Given file naming, Variants most plausibly sits as a lateral visual-direction study either alongside or informing the Prototype→v2 progression; the object model and glyph system are unchanged from Prototype through Variants through v2, only the shell chrome/visual-direction and (in v2) feature depth changed.)

**What stayed constant**: the entire color-token system, font stack, glyph vocabulary, the "needs-you gate ≠ destructive decision" distinction, hold-to-arm for destructive actions, the room→agent→session hierarchy, and the core scenario data (hexi/charm/mote, priya/carol, the users-migration plan, PR #482).

**What Variants tried and did NOT carry into Prototype/v2** (apparent dead ends / discarded directions):
- A literal branching-tree sidebar visualization ("THE CANOPY", SVG tree lines) as the primary nav metaphor (1c) — Prototype/v2 use a flat sectioned list (ROOMS/AGENTS/HUMANS) with inline nested indentation only when a room is focused, not a permanent tree graphic.
- A node-and-edge process-map view of the whole fleet (1e "wildcard") — no map/graph view exists in Prototype or v2; navigation stayed strictly list/tree based. (1e's own UI even proposed a "list view ⇄ map view" toggle that was never built out.)
- Full-terminal/ticker-only chrome (1b) and voice-first giant-caption chrome (1d) as *the* primary layout — Prototype/v2 instead merged call+chat as parallel panes (chat center, call docked right) rather than committing to either extreme.
- A dedicated **SERVERS** rail section (dagon/acme/lab, seen only in Variant 1b) — dropped from Prototype/v2's rail; host/infra info was folded into per-agent metadata (`HOSTS` map: `atrium cloud · always on` vs a named human's machine) instead of being a separate top-level list.
- The orchestrating-agent glyph briefly appeared as `◌` (open circle, dot) in the 1e legend vs. the `◎` (solid ring) used everywhere else — settled on `◎`.

**Prototype → v2 (concrete diff, from the embedded render code)**:
1. **Receipts, fully built out.** Prototype only stubs a receipt affordance (`planReceipt: () => addToast('receipt opens — who, what, when, checked vs claimed')` — literally just a placeholder toast). v2 replaces every one of those stubs with a real `receiptData()` model and a full receipt panel (sections: **WHAT HAPPENED** — lines individually tagged verified/claimed/unverified via glyph+underline; **VERIFICATION** — pass/fail check list; **ARTIFACTS** — clickable file/PR links; **LINKED** — related plan/sibling-receipt/session links; a side SESSION metadata block: agent, session name, harness, time window, spend, exit status; and for the merge decision specifically, an **APPROVED BY** block naming who/how/where). Receipt data is seeded for `schema`, `dual-write`, `chunk plan`, `merge`, and a failed example (`ivy/ci`) — richly written, e.g. schema receipt: *"users_v2 created — additive only ... Nothing was dropped; everything here is reversible until cutover."*
2. **"Since you left" digest.** v2 adds a `sinceLeft` marker on the first event of a feed (e.g. *"SINCE YOU LEFT · 5 EVENTS · 2 NEEDED YOU"*) with a color that fades from amber to muted once acknowledged (`sinceSeen`) — a returning-to-the-app catch-up affordance absent in Prototype.
3. **Relative timestamps.** v2 adds `relTime()` converting absolute `HH:MM` stamps to "Nm ago"/"now" within the last hour; Prototype only shows absolute stamps.
4. **Per-tab state isolation (`viewState`).** In Prototype, focus/terminal/plan state (`treeFocus`, `roomFocus`, `owedFocus`, `sessScope`) is global to `view`, so switching tabs could leak or reset drill-down state. v2 explicitly stashes/restores these four keys per-tab on every `goView()` call, so each open tab remembers its own expanded/focused sub-state independently.
5. **Breadcrumbs (`crumbSegs`).** v2 adds a computed breadcrumb trail (#room → focused-unit → plan/terminal → decision → receipt) with click-to-pop-to-level navigation and a smarter Escape-key handler that unwinds one layer at a time (receipt → gate → terminal → tree-focus → room-focus → fleet) instead of Prototype's flatter two-level Escape logic.
6. **Proactive "proceed?" gate on hexi.** v2 introduces `hexiAsk`, a timed (9s) needs-you row that appears under a *non-orchestrator* agent (hexi) asking *"rotation verified end to end — proceed to the refresh path?"* — extending gates beyond orchestrators/crew to any single agent hitting a judgment fork.
7. **Live-state color desaturation.** Every "live/running" glyph (`gc`) that was `var(--grn)` in Prototype is `var(--live)` (a new, more muted green token) in v2 — reserving the vivid `--grn` specifically for **verified/settled/done** states, so "still running" reads calmer/less alarming than "confirmed good." Stat-pill "near-threshold" coloring also changed: v2 only colors a usage pill amber/red when actually near threshold, otherwise renders it in muted `--tx4` (Prototype colored it by raw value more aggressively).
8. **Mention-chip color swap.** The `@lars`-mention highlight changed from amber (`--amb2`/`--ambbg4`) in Prototype to green (`--grn3`/`--grnbg`) in v2 — likely to stop visually conflating "you were mentioned" with "needs-you" amber semantics.
9. **Plan-view back-navigation polish.** v2's plan/session rows toggle label between "plan →" and "← back" depending on whether the plan is already open (`planOnL`), whereas Prototype's plan action was one-directional (always opened, no explicit close affordance from the same control).
10. Minor copy fix: "1 plan"/"sessions" chip labels in Prototype become "plan 1"/"sessions 2" in v2 (count-suffix convention instead of count-prefix), and "escalated · 4m ·" loses a redundant separator dot ("escalated 4m ·").

Net read on the trajectory: Prototype nails the shell/navigation/gate-vs-decision distinction and ships every screen as reachable-but-shallow (several actions are just toast stubs). v2 keeps the shell nearly pixel-identical but goes deep on **trust/provenance affordances** — receipts that separate system-verified fact from agent self-report from genuinely-unverified claims, catch-up digests for returning users, and state persistence so multi-tab exploration doesn't lose your place. The Variants file is the odd one out: a breadth-first visual-direction study (5 divergent shells wrapping the identical scenario) whose experiments (tree-graphic nav, map view, servers rail, giant-caption voice-first mode) did not survive into either interactive build.
