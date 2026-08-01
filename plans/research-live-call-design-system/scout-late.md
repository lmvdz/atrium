# Design research brief — Atrium v5 vs v6 (.dc.html canvases)

Source files:
- `/mnt/c/Users/Lars/Downloads/Design system for live call interface/Atrium v5.dc.html` (375,534 bytes)
- `/mnt/c/Users/Lars/Downloads/Design system for live call interface/Atrium v6.dc.html` (377,835 bytes)

Both files are **not** static mockup canvases with multiple labeled frames — each is a single, fully wired interactive prototype (a "design-canvas"/`.dc` document rendered by a custom template runtime: `<x-dc>`, `<sc-if>`, `<sc-for>`, `{{ }}` bindings, a `class Component extends DCLogic` state machine embedded in a `<script type="text/x-dc">` block, plus a shared `support.js` runtime). There is one screen/app, one state object, and the "canvas" is the live app itself — not a gallery of separate variant frames. No HTML comments or designer annotations exist outside of in-UI copy (the copy itself functions as the annotation — see §7). "Glance" does not appear anywhere in either file — these two are pure "Atrium" (the live-call/fleet-ops product), a separate lineage from the sibling `Glance *.dc.html` files in the same folder.

Both files are near-identical in structure: v6 is a refinement pass on v5, not a redesign (see §6). Treat v6 as the settled state of this lineage.

## 1. What each file/canvas contains

A single always-on "server" workspace called **Atrium** (tagline in the logo tooltip: *"Atrium — many agents, many paths, one shared context"*). It renders as one continuous app shell containing:
- A default room `#fleet` (command center) plus a dynamically creatable second room (`#ops`, created via `/room` slash command or "+ new room").
- Multiple agent "channels": `hexi`, `charm` (an orchestrator with a 3-agent crew), `mote`, `nova`, `sage`, `ivy`, plus sub-session channels `charm/backfill`, `charm/tests`, `hexi/auth`, `hexi/flaky`, `charm/schema`, `charm/dual-write`, `charm/chunk-plan`.
- Human DM channel `dm:priya`.
- A live voice call in `#fleet` with 2 humans (lars = "you", priya) and screen-share/streaming tiles.
- Modal/overlay states: incoming-call toast, share-picker (screens/applications tabs), PiP mini-player, right-click context menus (rail item, tab), settings panel, file viewer, receipt viewer, "wayfinding" pre-plan mode, slash-command palette, @-mention palette.
- A settings/admin surface (members, agent access toggles, room identity/rename, budgets).

No separate "variant" frames — interaction states (call live/off, gate pending/answered, merge pending/armed/done, wayfinding stage grill→fog→chart→clear→drafted) are all state-driven views of the same screen, reachable by clicking through the prototype.

## 2. Information architecture (frame regions)

Left to right, top to bottom, a CSS grid (`gridCols`) with four zones:

1. **Server strip** (`--strip`/`--stile` tokens, dark green even in light theme) — thinnest column. Atrium logo icon at top; a vertical list of "server" icons (`servers` list, each with initial-letter badge, active-indicator bar, @mention badge, red decision-dot, unread-count badge); a `+` add-server affordance; spacer; and at the bottom, the current human's avatar (lars, "L", blue) with a status dot and a click-to-open menu (status picker: online/away/etc., light/dark theme toggle, "settings" link).
2. **Rail** (resizable, `railW`, collapsible via `railOpen`) — three stacked sections:
   - **ROOMS**: `# fleet` (with a live-call phone icon if call is on) and any created room (`# ops`), each with unread badges, @mention flag, right-click context menu, "+ new room".
   - **AGENTS**: searchable/filterable list (magnifying-glass toggle → inline filter input). Each agent row shows a status glyph (● live/idle, ◎ orchestrator/orbit glyph, ✗ failed), name, an amber ◆ "needs you" flag, a red ■ "blocking decision" flag, @mention flag, unread badge, a "host away" warning icon (see §5), drag-handle (agents are draggable — into the call, presumably), and a right-click menu. A second "roomy" line under each agent shows live sub-state chips (terminal-glyph running-session count, clock-glyph "N waiting", crew-glyph count, hold-glyph "bounded · N held").
   - **HUMANS**: presence dot + name + unread/mention, draggable.
3. **Workspace / main pane** — a tab strip at top (`tabs`, draggable/reorderable, closable, each tab typed by icon: gear=settings, file=file viewer, terminal=inline terminal, dot=live room) plus separate **stream tabs** for shared screens (camera-icon glyph, PiP toggle, close), a "tile all streams" (⊞) button when 2+ streams are open, and a "fold call pane" toggle (◨). Below the tab strip, content switches by `view`: the fleet tree, an individual agent room, a file viewer, a receipt viewer, the wayfinding pre-plan UI, settings, or tiled streams. A "WATCHING · N" bar appears when observing someone else's shared screen ("the room keeps running behind this").
4. **Call pane** (resizable `callW`, toggle-able) — voice/video call UI: live badge + call clock, mute/share icon buttons, participant list (collapsible), and (when not on a call) a transcript/DM view of `turns` (structured Q&A between you/atrium/priya).

Below the tab strip inside the workspace, when in a room, there is a **message-log timeline** (see §4) and a **composer** at the bottom (drag-and-drop file attach, slash-command palette, @-mention palette, reply/answer-binding banner, per-room usage/spend "stat chips").

## 3. Design tokens

### Typography
- Google Fonts loaded: `IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400`, `Inter:wght@400;500;600;700`, `Sora:wght@600;700`.
- Body default: `font-family:'Inter',sans-serif` (base UI chrome, labels, buttons).
- `.mrow` (every message/timeline row) forces `font-family:'IBM Plex Mono',monospace` — i.e., the entire event/activity log, agent chat, receipts, and most data-dense UI is monospace. IBM Plex Mono appears 33× as an explicit inline `font-family` in the markup (composer input, slash palette, context menus, share picker, settings panel, receipt panel, wayfinding cards, file viewer). Inter appears only 3× explicitly (outside the global body default) — used for a couple of prose/label spots.
- **Sora is loaded but not referenced anywhere in the CSS or markup of either file** — 0 usages found beyond the `<link>` import. It's a vestigial/unused import in this lineage (possibly used in another sibling prototype, e.g. marketing or Glance).
- Base font-size 12.5px on the app shell; timeline rows commonly 10–11.5px; section labels (ALL-CAPS micro-headers like "ROOMS", "AGENTS", "SESSIONS") are 10px with `letter-spacing:.14em`.

### Color tokens — light theme (`:root`, warm paper)
```
--live:#9BB3A0 --strip:#173A32 --stile:rgba(244,241,234,.10) --stileac:#F4F1EA --stbd:rgba(244,241,234,.25) --stx:#C9D6CB --stxac:#173A32
--bg0:#E6E2DA --bg1:#F4F1EA --bg2:#ECE8DF --bg3:#FAF8F3 --bg4:#EAE5DA --bg5:#E2DCCF --bg6:#DDD6C8 --bg7:#EFEAE0
--line:#D4CDBD --line2:#C8C1B4 --line3:#B0A896
--tx0:#171A18 --tx1:#3A362E --tx2:#57534A --tx3:#7D7666 --tx4:#A39B89
--grn:#4E9161 --grn2:#3E7B52 --grn3:#5B8A6B --grnbd:#9DC4A8 --grnbg:#E3EDE2 --grnav:#CBE0CE
--amb:#B07D2A --amb2:#8A6220 --ambbd:#D9B36A --ambbd2:#E3C88F --ambbg:#F5E9CD --ambbg2:#F0E2C2 --ambbg3:#EBDAB1 --ambbg4:#EFDFB9 --ambbg5:#F6EDDA
--red:#B3402E --red2:#A63A28 --red3:#8F3222 --redbd:#DBA090 --redbg:#F6DFD7 --redbg2:#F1D3CA --redbg3:#E4B8AC
--blu:#3D6BB3 --blu2:#2F5590 --blu3:#8A97AC --replybg:#DFE7F2 --filebg:#DFE9F4 --filebd:#B7CCE4
```
"Warm paper" is literal: bg0–bg7 are cream/tan neutrals (not pure white/gray), `--strip` (server rail) is a dark forest green (`#173A32`) even in light mode, creating a deliberate dark accent strip against the warm-paper body.

### Color tokens — dark theme (`html.atr-dark` override block)
```
--live:#3E5748 --strip:#0E1A15 --stile:#16241D --stileac:#1E3A2A --stbd:#2E5A40 --stx:#7FA98A --stxac:#5CB27A
--bg0:#0a0b0c --bg1:#0c0d0f --bg2:#0b0c0e --bg3:#0d0f10 --bg4:#101214 --bg5:#15181b --bg6:#1a1d21 --bg7:#0e1012
--line:#1f2226 --line2:#2a2e33 --line3:#3a3f45
--tx0:#e8eaec --tx1:#c9ced3 --tx2:#9aa1a8 --tx3:#6d747c --tx4:#575e66
--grn:#5CB27A --grn2:#4EA76B --grn3:#6FA383 --grnbd:#2E5A40 --grnbg:#14261B --grnav:#1E3A2A
--amb:#C99A3F --amb2:#E0C077 --ambbd:#6E5320 --ambbd2:#57431C --ambbg:#221C0E --ambbg2:#2A2210 --ambbg3:#332A14 --ambbg4:#332A14 --ambbg5:#201A0E
--red:#D4604A --red2:#C25340 --red3:#E06A52 --redbd:#6E3427 --redbg:#261311 --redbg2:#2E1714 --redbg3:#57271E
--blu:#8AB4F8 --blu2:#AECBFA --blu3:#6B89B3 --replybg:#1C2836 --filebg:#16222f --filebd:#24435f
```
Dark theme is a near-black/graphite scale (not navy), with amber/green/red/blue semantic accents brightened for contrast. Theme is toggled at runtime (`toggleTheme`, `isDark`/`isLight`, `html.atr-dark` class swap, persisted via `initTheme()`), default light.

### Other tokens/conventions
- Three-tier green (`grn/grn2/grn3`), amber (`amb/amb2` + 5 bg tints `ambbg`–`ambbg5`), red (`red/red2/red3` + 3 bg tints), blue (`blu/blu2/blu3`) semantic ramps — used consistently for status/epistemic states (green=verified/settled, amber=needs-you/pending, red=blocking/failed, blue=human/identity).
- 7-step neutral bg ramp (`bg0`–`bg7`) and 5-step text ramp (`tx0`–`tx4`) for elevation/hierarchy, plus 3-step line/border ramp.
- Spacing is ad hoc inline px values (not a formal scale variable set) — common paddings: `6px 14px`/`6px 16px` for rail rows, `4px 24px` for timeline rows, `10px 24px`/`12px 16px` for panels, `20px 28px` for the receipt/plan detail canvas.
- Animation keyframes: `gl-blink` (50% duty cycle blink), `gl-pulse` (opacity pulse for live indicators), `gl-rise` (row entrance fade+slide), all respect `prefers-reduced-motion`.
- Hover-reveal pattern class conventions: `.mrow .macts` (message row hover actions), `.rrow .rdots` (rail row hover options-dots), `.stchip .stbar` (stat-chip hover-expand bar), `.pinwrap .pinhandle` (pinned-row hover handle).

## 4. Recurring components and patterns

**Epistemic/status glyph system** (used throughout the message timeline, rail, and receipts) — a small deliberate glyph vocabulary, each with a distinct SVG icon and color:
- `·` (dot, tx3/gray) — routine/informational event.
- `~` (tilde/wavy) — a claim (self-reported by an agent, not verified) — rendered with a dotted underline in receipts (`cl()` helper) to visually flag "unverified assertion."
- `✓` (check, green) — verified fact (checked by CI/system, not self-reported).
- `?` (amber) — explicitly unverified, flagged as such (`un()` helper in receipts).
- `◆` (amber diamond) — needs-you / escalation / decision pending.
- `■` (red square) — a blocking, destructive-action-pending decision (e.g., "queued the merge decision").
- `✗` (red X) — failed.
- A "steer" arrow-glyph (`gSteer`) — a human mid-course-correction to an agent.
- A "claim" quote-glyph (`gClaim`) — direct quoted agent speech.
This glyph set is the core "epistemic status" language: every timeline row / receipt line is tagged with exactly one of these to communicate provenance and confidence at a glance.

**Timeline / event feed (`.mrow` rows)**: grid `44px 14px 76px 1fr` (time | glyph | actor | text), hover-reveal reply/forward/react icons, inline `route` sub-line ("↳ routed to users migration › backfill, tests … · inferred" — v6 adds an explicit "inferred" provenance suffix and a tooltip on click/hover explaining provenance), collapsed-routine summarization ("31 routine · 11:50–11:57 · backfill, tests, hexi · click to peek" in v6, was a bare "31 routine events collapsed" in v5), a "SINCE YOU LEFT" divider row with rollup counts (v6: dynamic `sinceNeedN` computed live from pending gates/merges/asks; v5: hardcoded "2 NEED YOU"), "N CHANGES", "N ROUTINE HIDDEN" quick filters, and typing-indicator row (animated 3-dot).

**Claims/mentions text runs**: message text is tokenized into `parts` (color/background/border per token) so that e.g. an `@mention` or a code/file reference gets a distinct pill-like inline style with a dotted underline and tooltip explaining what it links to.

**Pinned rows / running-unit rows**: `.pinwrap` pattern — a pinned decision (gate/merge) stays docked above the fold with a hover-reveal collapse handle; can be collapsed/expanded (`pinCollapsed`).

**Agent tree / fleet rows**: a hierarchical `row()` builder used for both the rail and the in-room "tree" — supports padding-based indent (`pad: '48px'` for nested plan sub-sessions), glyph variants (`gWait`, `gOrch`, `gFail`, `gBounded`, `gDone`), block background/border for emphasized "needs you" rows, `statusTip` (v6-added hover tooltip explaining *why* a row needs a human — e.g. "needs lars specifically — you gave the original instruction; hexi won't widen scope without you"), inline "reopen" chip for previously-answered gates (v6-added), action buttons ("answer →", "open terminal →", "open receipt →"), and a root summary row (v6: "calm · 6 running · 38 idle · 3 humans" fleet-posture line with its own tooltip; v5 lacked the live posture prefix/tooltip).

**Cards / receipts**: a structured receipt object per settled unit-of-work (`schema`, `dual-write`, `chunk plan`, `merge`, `tests-green`, `ivy/ci`, generic fallback) with: `meta` (settled timestamp · channel · harness), `title`, `summary` (one-line "why this matters"), `lines` (glyph-tagged claim/verified/unverified bullet list), `ver` (explicit CI/verification checklist, ✓/✗), `arts` (linked artifacts — files, PRs — clickable), `side` (a SESSION metadata block: agent/session/harness/window/spend/exit, plus for merges an APPROVED BY block: who/how/where), `linked` (cross-links to the parent plan and sibling receipts). This is the "show your work" trust/audit surface.

**Plan-detail card** (users migration plan): four labeled sections — "WHY THIS EXISTS" (business rationale prose), "DONE WHEN" (completion criteria prose), "GROUNDED IN" (verified-receipt count summary), "NEEDS A HUMAN" (a literal to-do list of pending gate/merge decisions each with a one-line reason and a "y/n in the pin" or "hold-to-arm in the pin" cue) — plus a live-updating progress readout (row/backfill percentage) and a SESSIONS sub-list (backfill, tests) each with context-window %, elapsed time, and "terminal →" deep-link.

**Call/live UI**: mute/share toggle icons, hold-to-arm 2-second press-and-hold button for destructive merges (`armLabel: 'hold to arm — 2s'`/'keep holding…', animated fill-scale), incoming-call toast (avatar, name, room, "expand"), share-picker modal (screens/applications tabs, thumbnail grid, "also share this source's audio" checkbox), PiP draggable/resizable mini-player, live-share border overlay + top banner when you're sharing your screen ("YOU ARE SHARING"-style red inset glow), and a call-live green pulse indicator with elapsed clock reused in the tab strip.

**Agent rows / crew hierarchy**: an orchestrator agent (`charm`, glyph `◎`) shown with a distinct "orbit" icon (outer ring + inner filled dot) vs. plain live agents (`●`) — visually encoding "this one manages others." Crew count and rollup spend (`$4.20/h all-in`) surface on the orchestrator's row. Sub-agents/sessions nest under it with indentation.

**Needs-you / attention affordances**: amber ◆ flags on rail rows and tree rows; a fleet-wide "NEED YOU" counter that is clickable to filter the tree to just what needs a human (v6-added `attnFilter` state — clicking filters instead of merely scrolling/toasting as in v5); inline "answer →" actions that bind the composer to a specific pending question (`answerBind` state — banner: "◆ answering [question] · in: auth refactor · your next message resolves it — nothing is inferred"); a reopen affordance on already-answered gates (v6-added) that keeps the prior answer on record while reopening the decision.

**Composer**: drag-and-drop file attach, slash-command palette (`/plan <title>`, `/room <name>`, `/invite <person>`, `/call`) each with inline description text, @-mention autocomplete (people/agents/files — the `CANDIDATES` static list mixes agent/person/file kinds with distinct icons), reply-context bar, answer-binding banner, and trailing "stat chips" (`composerStats`) — per-room usage/spend readouts styled as a hover-expanding bar chart ("THIS BAR IS YOURS" config header lets you pick what each chip tracks: loop/usage/spend, per row).

**Breadcrumbs / receipts / usage-spend display**: no traditional page breadcrumb trail; navigation is tab- and rail-based. Usage/spend is pervasive and granular: per-agent `$/h` rate shown in rail sub-rows, room-level and fleet-level rollups ("fleet $4.12/h, within budget"), per-session spend in receipts ("$0.84"), and per-agent soft budget caps configurable in settings (`cfgBudget`: hexi $2/h soft cap, charm $5/h all-in incl. crew, mote $1/h).

## 5. Object model as rendered

- **Server** = the whole "Atrium" workspace (top server-strip icon), analogous to a Discord/Slack "guild." Only one is populated in this prototype; the `+` add-server affordance and a `servers` list imply multi-server is part of the model but not deeply explored here.
- **Rooms** (`#fleet`, `#ops`) = shared multi-human + multi-agent channels; a room is the top of the object hierarchy for a given effort/team. `#fleet` is explicitly "command center" and hosts the live call.
- **Agents** = first-class citizens with their own dedicated channel/room-like surface, live status, host/owner metadata (`AGENT_HOSTS`: `hexi`/`charm` run on "atrium cloud · always on"; `mote` runs on "carol's machine · reachable only while carol is online"; `sage` runs on "priya's machine" — i.e., agents can be cloud-hosted or run on a specific human's machine, with an "host away" warning glyph when that human is offline), and a `harness` (execution tool: "claude code" or "codex cli" — visible per-session in receipts).
- **Orchestrator agents** (`charm`) manage a **crew** of sub-agents/sessions and roll up spend/status from them — an explicit agent→crew hierarchy distinct from a flat agent list.
- **Plans** = a named unit of work owned by an orchestrator (e.g., "users migration," owned by `charm`), containing rationale ("why this exists"), completion criteria ("done when"), a decision log of open/settled gates, and child **sessions**.
- **Sessions** = bounded runs of an agent against a task (`charm/backfill`, `charm/tests`, `hexi/auth`, etc.) — each has a session key, glyph/status, task description, elapsed/window, context-usage %, and `$/h`. Sessions can be "one-shot" (settle to a receipt and close, e.g. `schema`, `dual-write`) or long-running/live.
- **Receipts** = the settled, auditable artifact of a session — verification checklist, claims vs. verified facts, linked artifacts (files/PRs), linked sibling/parent receipts, and (for a merge) an explicit "approved by" human-authorization record. Receipts are the system's trust ledger.
- **Calls** = live voice (and optional screen-share/stream) sessions scoped to a room; humans and (implicitly) `atrium` itself participate as a turn-taking party in the transcript (`turns: [{who:'you'|'atrium'|'priya', ...}]`) — i.e., the product's own "atrium" assistant persona is a conversational participant, not just a UI.
- **Humans** = `lars` (you, admin), `priya` (member), `carol` (ops, off-call) — with roles (`admin · you`, `member · on the call`), presence status, and account-level prefs (`ringCalls`, `needsYou`, `quietHours`).
- **Gates / merges (decisions)** = explicitly modeled as first-class pending objects distinct from ordinary messages: a `gate` (a yes/no policy question, e.g. "scrub or keep production emails in test fixtures") and a `merge` (a destructive PR-merge action) each have their own pending/answered/armed state machine, pin to the top of the room, and require specifically a human (not just "any agent") — with v6 adding an explicit `gateWhy` string surfacing *why no agent has the authority to decide* ("your steer … and legal's fixture rule conflict — no agent has authority to choose between them. any maintainer may answer.").
- **Wayfinding / pre-plan** = a distinct object below "plan": an earlier-stage, exploratory decision-charting mode run with a dedicated "planning agent" (`sage`) before a plan is drafted. It models a "frontier" of open questions, each tagged HITL (needs a human, amber ◆, with option buttons) or AFK (agent researches autonomously, green ●, no human action) or blocked (grayed, waiting on a prerequisite), and a "fog" of not-yet-stateable questions that get promoted to the frontier once precise enough. Stages: `grill` (destination not yet named) → `fog` (destination fixed, charting) → `chart` (frontier being resolved) → `clear` (frontier empty) → `drafted` (plan v1 generated from the resolved decisions, map kept as receipt trail). This is a rich, mostly-unique concept: planning-as-a-decision-tree with explicit human-vs-agent authority tagging per node.
- **Escalation / channel routing**: an agent's reply can auto-`route` a decision up to a parent plan/room ("routed to users migration › backfill, tests"), and v6 makes this routing decision itself inspectable/correctable ("inferred by charm's loop · click to inspect or correct") rather than an opaque fact — a meaningful epistemic-transparency upgrade.

## 6. Evolution: v5 → v6

The component-logic diff (`script.js`) between v5 and v6 is only ~44 lines across a ~2,391-line file — i.e., **v6 is a small, deliberate refinement pass on an already-complete v5**, not a new design. All the same screens, object model, wayfinding feature, receipts, tokens, and IA are already fully present and working in v5. Confirmed changes, all additive/clarifying (nothing removed):

1. **Provenance transparency on auto-routing**: v6 adds `routeProv` ("inferred by charm's loop · click to inspect or correct") as a tooltip on the "↳ routed to…" line, plus an explicit "· inferred" suffix label in the markup so routed decisions read as inferred-not-fact at a glance. v5 had the route link with no provenance disclosure.
2. **"Why does this need a human" tooltips**: v6 adds `statusTip` text to needs-you rows explaining the specific reason authority can't be delegated to an agent — e.g. hexi's "proceed?" gate: v5 said "needs you"; v6 says "needs lars ·" with tooltip "needs lars specifically — you gave the original instruction; hexi won't widen scope without you." Similarly ivy's failed CI row gets a tooltip: "retries exhausted — the broken fixture is ambiguous; an agent can't decide whether to scrub or rebuild it." A new `gateWhy` field does the same for the fixture-policy gate.
3. **Reopen affordance on answered gates**: v6 adds a "reopen" hover-chip on an already-answered decision row; clicking it resets to pending while preserving the prior answer in the event log ("reopened the fixture policy decision — previous answer (…) stays on the record"). Not present in v5 — v5's answered gates were terminal/read-only.
4. **Fleet-wide attention filter, not just a scroll-to**: v5's "N NEED YOU" pill in the "since you left" divider only scrolled to and toasted about the pinned items (hardcoded "2 NEED YOU"). v6 makes the count dynamic (`sinceNeedN`, computed live from `gatePending`/`mergePending`/`hexiAsk`/wayfinding-open state +1) and clicking it now actually **filters the tree** to only what needs you (`attnFilter: true`), with the fleet root row itself gaining a live posture summary — v6: "calm · 6 running · 38 idle · 3 humans" (or, when filtered, drops "calm ·"); v5's root row had no such posture readout at all.
5. **Answer-binding context label**: v6's "◆ answering …" composer banner adds "in: auth refactor" (which room/session the pending answer will land in) — v5's banner omitted this scoping context.
6. **Collapsed-routine summary is more informative**: v5: "31 routine events collapsed" (bare count). v6: "31 routine · 11:50 – 11:57 · backfill, tests, hexi · click to peek" (time range + involved actors + explicit affordance hint).
7. **Transcript cross-links back to the pinned decision**: v6's `turns` (call transcript/DM) entries gain an optional `ref`/`refLabel`/`go` so a transcript line like atrium's answer about the merge decision now has a clickable "■ the same decision, pinned above — open it" link that jumps back to the pinned row. v5's transcript was static prose with no such backlink.

No token, layout, IA, font, or component-inventory changes were found between v5 and v6 (markup diff confirms only the same handful of lines changed, mirroring the script diff). Everything else — the full color system (light+dark), the four-zone shell, the rail/tabs/call-pane structure, the epistemic-glyph vocabulary, the receipt schema, the wayfinding stage machine, session/spend model — is already settled as of v5 and simply carried forward unchanged into v6.

**What reads as settled in v6** (stable across both versions, core to the lineage): the four-zone shell; server/room/agent/human rail taxonomy; the epistemic glyph set (·, ~, ✓, ?, ◆, ■, ✗); the receipt schema (claims vs. verified, session metadata, linked artifacts); the plan card's WHY/DONE-WHEN/GROUNDED-IN/NEEDS-A-HUMAN structure; the wayfinding grill→fog→chart→clear→drafted state machine with HITL/AFK/blocked tagging; per-agent host/harness/spend metadata; hold-to-arm for destructive actions; light warm-paper / dark near-black theming.

**What still reads as exploratory even in v6**: the "attention filter" is a single global toggle rather than a richer saved-view/filter system; the reopen-decision affordance exists only for the `tests` gate example, not generalized across all gate types in the code; Sora is imported but entirely unused, suggesting either an abandoned typographic idea or a leftover from a shared font-loading snippet; there is only one populated "server," so the multi-server model (`+` add-server, `servers` list) is asserted but not exercised; the "ops" second room is a placeholder ("one extra room in this prototype" — an explicit prototype-limitation string surfaces in `doCreateRoom`, i.e., the designer left a self-aware stub rather than building out true multi-room depth).

## 7. Embedded design-note / annotation-style copy (verbatim, from in-UI mock text — the designers' own "why" statements surface as product copy)

- Logo tooltip: *"Atrium — many agents, many paths, one shared context."*
- Merge receipt summary: *"A destructive action. It required a human hold-to-arm in this UI — voice could never have done this."*
- Tests-green receipt summary: *"charm said it; the system checked it. This receipt is the difference between the two."*
- Failed-CI receipt summary: *"The run ended non-zero. The log is kept in full; the failure diagnosis below is the agent's account, not a verified fact."*
- Schema receipt summary: *"A one-shot session under plan users migration. Nothing was dropped; everything here is reversible until cutover."*
- Answer-binding banner: *"your next message resolves it — nothing is inferred."*
- Gate rationale (v6-added): *"needs a human because your steer ('keep FK out of the shim') and legal's fixture rule conflict — no agent has authority to choose between them. any maintainer may answer."*
- Hexi proceed-gate tooltip (v6-added): *"needs lars specifically — you gave the original instruction; hexi won't widen scope without you."*
- Ivy failure tooltip (v6-added): *"retries exhausted — the broken fixture is ambiguous; an agent can't decide whether to scrub or rebuild it."*
- Fleet root posture tooltip: *"fleet posture — calm means nothing new needs you beyond what is pinned."*
- Wayfinding stage intros: grill — *"sage opens with a grill — no ticket exists until the destination is named."* fog — *"destination fixed. sage is charting the fog — a question becomes a ticket the moment it can be stated precisely."* chart — *"not a plan yet — a map of decisions. every card resolves a question; resolving a frontier card clears the fog behind it."* clear — *"every question is answered. a map is done when nothing is left to decide — that is now."* drafted — *"the frontier emptied, so sage drafted the plan. the map above stays as its receipt trail."*
- Plan card "WHY THIS EXISTS": *"v1 can't match emails case-insensitively — 41k people have duplicate accounts because of it."*
- Plan card "DONE WHEN": *"every read hits users_v2, duplicates merged, and a week passes with v1 untouched."*
- Wayfinding destination default option: *"any region can die — users don't notice"* / alt option: *"checkout survives a region loss — the rest can limp."*
- Wayfinding RTO card comment: *"support says nobody notices under 2m outside checkout."*
- Wayfinding destination sub-label: *"proven by drill, not by hope."*
- Sage's settled-clean status line: *"transcript is read-only — replying wakes it with full context."*
- Ivy's settled-failed status line: *"transcript is read-only — replying respawns it with its context."*
- Receipt-writing event copy: *"receipt written — task, decisions, $3.95 spend, 1 unverified claim kept"* and *"receipt written — failures keep their history too."*
- Prototype self-aware stub (in `doCreateRoom`): *"one extra room in this prototype — #new-room-1 reopened."*
- Mote's bounded-state description: *"bounded — I need 3 resources approved before I can proceed"* / rail sub-label: *"bounded · 3 held … costing nothing until you approve them."*
- Host-away tooltip: *"host offline — see the agent's profile for its owner."*
- Charm's own framing of its plan, quoted-claim glyph: *"splitting into schema, backfill, tests — I'll hold cutover myself · its plan."*

## Appendix — key extracted artifacts (for reference, not exhaustive)

- Static `CANDIDATES` list (mention/attach picker) mixes kinds: agent (`charm` "orchestrating · crew 3 · needs you", `hexi` "auth refactor · working", `mote` "bounded · 3 held · held"), person (`priya` "on the call · ● live", `carol` "ops · off call"), file (`rollback.sql` "~/dev/atrium · 4.2 kb · ⏎ inline + upload", `roles.yaml` "uploaded by priya · 11:12 · links existing").
- `SESSIONS` map (per-agent live/settled session rows) and `AGENT_HOSTS` map (host machine + owner + away-flag) are separate top-level data structures feeding the rail and settings.
- Spend/usage rollups (`renderVals`, ~line 1488): `fleet: $4.12/h fleet-wide`, `charm: $4.20/h all-in`, `hexi: $2.05/h · 2 sessions`, `mote: $0/h · 3 held`, `nova: $0.08/h`, `ivy: $0/h · stopped` — each paired with a loop-count and usage-% for the stat-chip bar visualization.
- Slash commands: `/plan <title…>`, `/room <name>`, `/invite <person>`, `/call`.
- File viewer mock content includes a real-looking SQL migration (`migrations/0043_users_v2.sql`, additive `CREATE TABLE users_v2`) and its `rollback.sql`.
