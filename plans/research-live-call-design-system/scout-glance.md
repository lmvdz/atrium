# Scout brief — Glance design canvases

Source dir: `/mnt/c/Users/Lars/Downloads/Design system for live call interface/`
Files scouted: `Glance Explorations.dc.html` (357KB, 2471 lines), `Glance Object Model.dc.html` (23KB, 177 lines, read in full), `Glance Room Prototype.dc.html` (233KB, 2401 lines), `Process Tree.dc.html` (10KB, 64 lines, read in full).
Sibling files in the same dir NOT in scope but visible: `Atrium Prototype/Variants/v2..v6.dc.html`, `CLAUDE.md`, `support.js` — these look like the broader "Atrium" design system that Glance is a sub-exploration of (filenames + a shared `support.js` runtime + shared CSS custom-property naming convention `--tx0`, `--grn2`, `--amb`, `--red2`, `--line2`, `--bg4` seen in `Process Tree.dc.html` but not defined in the Glance files themselves — they're inherited from that outer system).

All four are `.dc.html` "design-canvas" documents: real functioning HTML/CSS/JS mocks (some are live React-like class-component prototypes with `setState`, not static comps) rendered through a custom `<x-dc>` wrapper + `support.js` runtime, using `sc-if`/`sc-for`/`{{ }}` templating (a small internal templating DSL, "sc-" = probably "state component").

## 1. What "Glance" is

Glance is a **voice agent** that lives inside a live-call / chat product (the wider "Atrium"-style multi-agent ops surface: rooms, agent channels, plans, sessions). Per the Object Model (§7 Calls): *"Glance, the voice agent, is not a unit — it has no terminal and no sessions; it acts through the same channels you do."* It sits on live calls, listens, speaks (with live caption/streaming-text UI), summarizes agent state to humans on a call, and mediates the voice→destructive-action boundary (voice can narrate and ask, but only a human click can approve destructive actions).

- **Glance Object Model.dc.html** — a single prose+diagram spec, "the hierarchy, in writing," described as "the model the prototype now implements." It's the conceptual/textual documentation the other files are built against.
- **Glance Explorations.dc.html** — a design-review "canvas" (`<meta name="design_doc_mode" content="canvas">`) structured as 19 numbered "turns" (turn 19 down to turn 1, i.e. most-recent-first), each turn posing a design question with 2-4 lettered options (e.g. 19a/19b/19c), each option a full rendered UI mock plus a one-paragraph designer annotation. This is a design-exploration log, not a single final spec — it visibly documents the evolution from four very different visual languages (turn 1: WIRE / PLEX / DAYLIGHT / DECK) up through increasingly converged, refined "definitive room" and "unified rail" iterations (turns 11–19).
- **Glance Room Prototype.dc.html** — the (apparently) converged, single, fully interactive prototype: one dark mono-space room UI with a working rail, timeline/feed, live call pane with participant tiles, PIP, screen-share, terminal drill-down per agent, settings, DMs, file mentions, etc. This is downstream of the WIRE language that "won" the Explorations turns.
- **Process Tree.dc.html** — not a documentation page but a reusable **component template**: a single data-driven process-tree row (`sc-for` over `rows`) with glyph/status/gate/merge sub-states. It's the generic UI atom that renders the tree structure from the Object Model (session/plan/agent rows with status glyphs, gate y/n answer UI, hold-to-arm merge UI).

## 2. The object model (verbatim structure from Glance Object Model.dc.html)

Top-of-doc ASCII hierarchy:
```
server  (dagon, acme co, personal…)
├─ rooms      #fleet, #ops — humans + agents talk; typed events land here
├─ agents     ONE channel + loop — work grouped into plans
│   └─ plans      folders of work — progress, rollup spend, receipt index; no ctx
│       └─ sessions   processes — own ctx + spend, any harness; settle or fail, never spawn
└─ humans     lars, priya, carol — DMs, calls, decisions, ownership
```

Numbered sections (each with prose, some with additional ASCII/ diagram cards):

1. **Server** — "The hard boundary." Own rooms/agents/humans/calls/budgets per server; nothing crosses except the human. Cross-server attention rides the server strip as badges: unread count, `@` mention (amber), `■` waiting decision (red). "A live call survives switching servers." User identity sits below the server strip, "above servers, not inside one."
2. **Rooms** — group channels for humans+agents plus typed event cards (verifications, spawns, decisions, receipts). `#fleet` is the default room. "The room's pin holds what needs attention now: running agents, escalated gates, destructive decisions. Below the pin, the feed is conversation only."
3. **Agents and their channels** — an *agent* is "a persistent identity: a name, an owner (always a human), a host, a harness + model config, autonomy rules, a budget." Agents never "settle" — they go idle when no sessions run. The *agent channel* is the conversation substrate around that identity, outlives every session. "The agent is its own orchestrator: a message in the channel doesn't go to a terminal — the agent reads it and routes it to the right session ... with a visible routing receipt."
4. **Plans and sessions** — a *plan* is "a named piece of work" — a folder with progress, spend rollup, receipt index; "no context window and no terminal; it is a board, not a process." Trivial work = a one-session plan the UI doesn't draw. A *session* is "one terminal instance — one task, one harness process, run under a plan"; each session picks its own harness+model ("a cheap omp worker next to a claude session — what 'sub-agent' used to mean is just a session config"). Sessions pinned in the agent channel grouped by plan; each live one opens its own terminal. "Sessions settle or fail; each leaves a receipt and keeps its log. **Sessions never spawn children** — a session that needs help asks its plan to add a session, so all parallelism stays on one visible board." Rail summarizes sessions per agent, e.g. `▣ 2 · ◆ 1 waiting`.
   - Boxed callout "WHO OWNS WHAT NUMBER": usage/subscription % → agent (shown once, agent channel header); context % → session (per session row + its terminal, never aggregated); spend/h → session (plan shows rollup); depth → fixed at three (agent → plan → session); "the agent's mind is its channel loop" — every agent runs a persistent lightweight orchestrator, the **channel loop**, that reads its channel, routes, spawns/settles sessions, answers when no session applies; shown as `loop` next to usage in the channel header; burns from the agent's subscription. "Heavy orchestration (like charm's users migration) is still a task session; the loop only conducts."
5. **Plans replace crew** — three nouns only: agent, plan, session. What "crew" used to mean (a session employing sub-agent sessions) is now just "the sessions of a plan," e.g. `users migration › backfill, tests`. No employment relationship, no sub-identities/sub-channels. Sessions nest under their plan everywhere (fold with it); escalations climb session → plan → agent channel → room pin. Gates/destructive decisions belong to the raising session and never hide when a plan folds.
6. **Humans** — exist at server level: DM channels, call participation, room membership, agent ownership, and *exclusively* destructive decisions. "Voice can never approve a merge, publish, spend, or delete; only a click here can, and the record names who and when."
7. **Calls** — "per-server, room-scoped layers — not channels." One call pane: live state, participants (per-speaker attribution + speaking glow), captions, screen shares. Declining doesn't end a call — it stays in an ACTIVE CALLS list, joinable any time. **Glance is not a unit** — no terminal, no sessions; acts through the same channels a human uses.
8. **Depth** — fixed at agent → plan → session, forever, no recursion; a session cannot spawn — overflow goes up (plan adds a session, or agent's loop opens a plan). Contracts tighten downward (budget/permission slices). Human surface follows the nouns: agents converse (one channel each), plans are boards, sessions are observed (terminal, receipt). "Steering a session = say it in the agent channel; the loop routes down, with a routing receipt. The terminal stays the break-glass exception." Escalations climb session→plan→agent→room pin; receipts roll up (a plan's receipt indexes its sessions').
9. **The process-tree lens** — explicit OS/process analogy, load-bearing:
   - loop = daemon (always-on, routes)
   - session = process (own address space = context window; exits with a status = receipt)
   - plan = process group (tightening contracts = rlimits)
   - room pin = htop filtered to "needs a human"
   - terminal = attaching a tty
   - escalation = signals propagating up the supervision tree
   - the human = init, the only one allowed to authorize destructive syscalls
   - Rule: "every session has exactly ONE parent and one exit status — pstree, not a graph. Two units collaborating = one owner + one collaborator, never dual parents, or the tree stops being auditable."
   - Six sub-diagrams (9.1–9.6), each a bordered card:
     - **9.1 THE TREE** — literal example tree: `server dagon → room #fleet ◉loop → agent hexi ◉loop → sessions (auth refactor, flaky-test hunt); agent charm ◉loop → plan users migration → sessions (backfill [omp], tests ◆ [claude, waiting on human])`.
     - **9.2 WHO OWNS WHAT NUMBER** — worked example: agent charm shows `usage 71%` + `loop ctx 14%`; session `users migration › backfill` shows `ctx 41% · spend $0.36/h`, plan row shows `$4.20/h` rollup. "An agent with 3 sessions has 3 ctx numbers and 1 usage number."
     - **9.3 ROUTING** — worked example: lars → #charm: "hold the cutover until priya signs off" → charm's loop decides: about a running session? → steer + routing receipt; new work? → open a plan/add a session; just a question? → answer in channel.
     - **9.4 ESCALATION** — worked example: session `tests` raises ◆ → climbs to plan row (shows ◆ even folded) → agent rail badge ◆ → #fleet room pin (`◆ charm › tests — fixtures contain production emails: scrub or keep?`). "A needs-you propagates to every ancestor's surface. Folding a branch hides its noise, never its signals."
     - **9.5 EXIT** — worked example: plan `users migration ✓ settled → receipt`, linking to session `backfill ✓ 4.1M rows · $1.80`, session `tests ✓ scrubbed · answered by lars 12:31`, `merge PR #482 ✓ armed + clicked by lars · cannot be undone`.
     - **9.6 WHAT A HUMAN CAN TOUCH, BY NOUN** — grid: agent (chat=✓channel, terminal=—, rail=✓row); plan (chat=thread in channel, terminal=—, rail=folds under agent); session (chat=say it in channel/loop routes, terminal=✓tty, rail=—).
10. **Access** — tree is "room-wide truth" (same pin/agents/sessions/badges for every member; fold/focus is personal, content never is). Not transitive — a room invite grants only that room's surface. Levels: *see+converse* (feed, talk, @-mention — "the safe default power because it is mediated: loop-routed, public, receipted"); *agent channels* (separate per-agent human list — room access shows an agent exists, doesn't open its history); *terminals* (unmediated — owner + explicit grants only); *destructive decisions* (named approvers/admins, always recorded). "The UI renders the same rows for everyone and strips the doors you don't hold — no terminal →, no hold-to-arm. ps shows every process to every user; attaching a debugger needs permission on that process."

**Invariants** (closing box):
- every fact is `✓ checked`, `~ a claim`, or unverified — "a claim never dresses as a fact"
- owed attention (`✗` failures, `◆` gates, `■` decisions) pins and sorts above everything, never hides in a fold
- everything leaves a receipt: sessions, decisions, steers, invites — who/what/when
- destructive actions are click-only, hold-to-arm, recorded

## 3. Process Tree component (Process Tree.dc.html)

Not a diagram spec — a literal reusable **row template** for rendering the tree from §9 as a live list. Built with the `sc-for`/`sc-if`/`{{ }}` DSL over a `rows` prop (array of row objects — empty by default, `hint-placeholder-count="4"`), so this is the generic component other screens (Room Prototype, plan boards) instantiate.

Row grid: `28px timer | 250px name+glyph | 106px chips | 1fr detail | 210px status | 84px action`.
- **Left timer column**: `r.workingFor` (green, "working for Xm") or `r.doneAgo` (gray, "done Xm ago").
- **Glyph column** (`r.gc` colored icon set, one shown via `sc-if`): `gLive` (filled circle — live/running), `gOrch` (ringed circle w/ center dot — orchestrator), `gDone` (checkmark), `gWait` (diamond/rhombus — waiting), `gSquare` (filled square — settled/bounded?), `gBounded` (open ring), `gFail` (X), `gPlan` (folder/rect icon — plan).
- **Name column**: row name + optional badge slot with amber `◆` (owed gate) and red `■` (owed merge) glyphs, opacity-toggled.
- **Chips column**: clickable filter/status chips with optional chevron open/closed state.
- **Detail column**: truncated text with a custom hover tooltip (`.pt-detail:hover .pt-full`) that pops the full untruncated text in an absolutely-positioned box — a recurring "long text truncates, hover reveals full" pattern.
- **Status column**: right-aligned status text + optional expand/collapse chevron.
- **Action column**: right-aligned clickable action label, or empty.
- **Expandable gate sub-row** (`r.gateOpen`): note, "why me?" rationale line, owner/claim UI (unclaimed → `claim` button), and inline y/n answer buttons styled as `[y] scrub` / `[n] keep` with a keyboard-shortcut hint slot.
- **Expandable merge sub-row** (`r.mergeOpen`): note + a **hold-to-arm** button (`onMouseDown`/`onMouseUp`/`onMouseLeave`) with an internal progress-bar fill (`r.armScale` transform) and a separate `reject` button — the literal "destructive actions are click-only, hold-to-arm" invariant from the Object Model, implemented.

Uses CSS custom properties not defined in this file (`--bg4`, `--line2`, `--grn2`, `--tx4`, `--tx3`, `--tx2`, `--tx1`, `--tx0`, `--amb`, `--amb2`, `--ambbd`, `--ambbg3`, `--red`, `--red2`, `--red3`, `--redbg3`) — inherited from the outer "Atrium" token system, not redefined locally. This is the one file in the set that is token-based rather than hardcoded-hex, implying it's meant to be dropped into the larger design system.

## 4. Room Prototype IA (Glance Room Prototype.dc.html)

A single full-viewport (`100vw × 100vh`, min 1340×760) dark-mode app shell, `background:#0a0b0c`, JetBrains Mono throughout, `font-size:12px`, `display:grid;grid-template-rows:1fr`.

Top-level overlay layers (rendered via `sc-if` before the main grid): a draggable/resizable **PIP** (picture-in-picture) window for watching an agent terminal/screen stream while elsewhere in the app (drag handle, resize handle, hide/open-as-tab/close controls); a **rail right-click context menu**; a **tab right-click context menu**; a full-viewport red border+banner overlay when the user is screen-sharing (`youSharing`); a **share picker** modal.

Main 3-pane grid (seen concretely in the "1a WIRE" mock and structurally mirrored in the live prototype): `236–250px rail | 1fr timeline/main | ~356–372px call/context pane`.

- **Rail** (left): sectioned list — `CHANNELS` (rooms, e.g. `#fleet`, with unread/gate glyphs like `◆` on a channel with a pending gate), `▸ N settled` fold-away row, then `UNITS`/`AGENTS` (agent roster: hexi, charm, sage, mote, ivy, nova, quill/glance — mapped to colored status dots `●` busy/green, `◐` amber waiting, `○` gray idle, plus short status text like "rotating tokens", "waiting on you", "bounded"). Later Explorations turns (7a/7b) iterate the rail into a merged "agent channel = agent status row" pattern, and turn 8 iterates where "surfaces" (decisions/unseen/cost — see below) live in the rail (rows vs. one quiet status line vs. moved to a top strip).
- **Main timeline/feed**: a chronological event log — timestamp, glyph, text — mixing agent status events ("mote spawned — audit infra spend (you, by voice)"), verified facts (`✓` green), claims (`~` gray/italic, attributed as speech), token-burn snapshots, and two card types that interrupt the flow: a **NEEDS YOU** amber gate card (question + Yes/No-style buttons + "OPEN THE UNIT →") and a **DESTRUCTIVE** red card explicitly labeled "VOICE CANNOT APPROVE THIS" with a filled action button (e.g. "MERGE TO MAIN") + "REJECT". A composer sits at the bottom (`message #fleet…`) with an "● on call" indicator.
- **Call / context pane** (right, `paneMode`: `call` | `files` | `profile`): when `paneMode==='call'` and call is live — a header with pulsing LIVE dot + call clock + room name; a collapsible participants strip/rows (draggable avatar chips, right-click context menu, per-participant `note` e.g. "muted for all · by lars", screen-share indicator `⧉`, "watching"/"view screen" toggle); a scrolling **call transcript** (`turns` list, `└` glyph rows) with a live "speaking now" row showing a blinking cursor block (`gl-blink` keyframe) as Glance's speech streams in word-by-word (`speakingText`); a mute/share/end-call control bar at the bottom (SVG icon buttons). Non-call states: `callIdleHome` (no call running), `callSetupShow` (call setup screen), `activeCallShow` (a call you declined is still listed as ACTIVE, joinable — matches Object Model §7).
- Per-agent **terminal drill-down**: clicking into an agent's session opens a synthesized terminal log (`termLines`) — glyph-prefixed lines (`●` tool call, `✱` turn/status, plain indented result lines) — e.g. hexi's `Read(...)`, `Write(...)`, `Bash(pnpm test auth -- --run)` → "41 passed · 0 failed"; charm's `exec: psql ...`, `delegate → charm/tests: ...`, `blocked: merge pr-482 requires human approval` (red) → "decision card raised in #fleet — waiting on lars"; mote's `omp plan infra-audit --dry-run` → "plan: 3 resources need approval → holding (bounded mode)" → idle "$0/h". A `termDraft` composer lets you "prompt an agent directly in its terminal," logged/attributed and queued for the next turn boundary — the literal "terminal is the break-glass exception" from the Object Model.
- **Views** (`view` state) span: `fleet`, `charm`, `ivy`, `sage`, `nova`, `ops`, `settings`, `tiles` (call grid), `me`, `dm:*`, `file:*` — i.e. rooms, individual agent channels, a settings screen, a tiled call-grid layout, your own profile, DMs, and file views.
- **Screen-share / stream watching**: `stream:*` tab type: watching either an agent's terminal stream or a human's screen stream, with a `streamWatchers` list (who else is watching) and speaking-ring glow reused from participant tiles.
- **Participant tile visuals**: colored initials-avatar (`bg`/`fg` per person, e.g. lars `#2a3a4d`/`#9fc1e8`, priya `#3d2a4d`/`#cfa8e8`, glance `oklch(0.28 0.06 150)`/`oklch(0.82 0.14 150)` — i.e. Glance is visually coded green/mint like the rest of the "live/success" color, distinct from human blue/purple tones); a **speaking glow** = `box-shadow: 0 0 0 1.5px oklch(0.75 0.17 150 / .9), 0 0 12px 2px oklch(0.75 0.17 150 / .45)` applied to whoever's `talking`; drag-to-reorder avatars (`draggable`, disabled for glance); right-click context menu per participant.
- Settings-adjacent screens found via uppercase section labels: `IDENTITY`, `STATUS`, `NOTIFICATIONS`, `AUDIO`, `ROOMS`, `HUMANS`, `AGENTS`, `AGENT ACCESS`, `CHANNEL`, `UNIT`, `NEW CALL`, `SHARE TO THE CALL`, `THIS BAR IS YOURS`, `GITHUB · LARS-DEV`, `LIVE`, `NAME`.

## 5. Design tokens / visual language

- **Confirms a mono/near-black "WIRE" system won out.** Turn 1 of Explorations pitted four distinct visual languages against each other; by the final numbered turns (11–19) and in the standalone Room Prototype, the surviving language is explicitly "WIRE"-descended:
  - **1a WIRE** — "all-mono terminal soul," bg `#0b0c0d`/`#0a0b0c`, text `#c9ced3`, JetBrains Mono, glyph-prefix epistemics (`✓` fact / `~` claim / `?` unverified), voice = top status strip.
  - **1b PLEX** — "dense-but-breathable, blue-cast dark," bg `#101318`, text `#c3cad4`, **IBM Plex Sans**, voice = docked Discord-style presence-tile pane, epistemics = structural chips ("verified"/"their account").
  - **1c DAYLIGHT** — light mode, "spacious, warm paper," voice = floating pill → caption overlay, epistemics = typographic (upright ✓ facts vs. italic-quoted claims).
  - **1d DECK** — "warm graphite," **Space Grotesk**, voice = full-width bottom call deck (waveform, speaker chips, one giant live caption line), epistemics = tinted row underlays.
  - Turns 2a–2c are explicitly labeled "WIRE v2 / WIRE ticker / WIRE extended" — i.e. WIRE was chosen early (by turn 2) as the surviving direction and iterated for the rest of the doc (turns 3–19 don't rename languages again).
  - Glance Object Model.dc.html and Glance Room Prototype.dc.html are both pure WIRE descendants: `#0a0b0c`/`#0b0c0d` background, `JetBrains Mono` exclusively (no Plex/Grotesk/Instrument Sans loaded), muted gray text scale (`#c9ced3` → `#9aa1a8` → `#565b61` → `#3f4348`), and `oklch()` accent colors for state (green ~`oklch(0.75-0.78 0.15-0.17 150)` for live/verified/success, amber ~`oklch(0.8 0.13 80)` for waiting/gate, red ~`oklch(0.72 0.19 25)` for destructive/fail).
- **Fonts loaded**: Explorations pulls `JetBrains Mono`, `IBM Plex Sans`, `IBM Plex Mono`, `Space Grotesk`, `Space Mono`, `Instrument Sans` (one family per losing/winning language explored). Room Prototype and Object Model load **only JetBrains Mono** — confirming convergence.
- **Color formula**: state colors are consistently OKLCH-based (not raw hex) for the semantic accents — green/success/live, amber/waiting/gate, red/destructive/fail — while structural/neutral chrome (borders, backgrounds, body text) stays flat hex grays. Borders are consistently 1px hairlines (`#1f2226`, `#212428`, `#2a2e33`).
- **Process Tree.dc.html** is the outlier: it uses `var(--tx0..4)`, `var(--grn2)`, `var(--amb/--amb2/--ambbd/--ambbg3)`, `var(--red/--red2/--red3/--redbg3)`, `var(--line2/3)`, `var(--bg4)` — a formal CSS custom-property token layer, not defined in-file, implying it's authored against the shared outer "Atrium" design-system stylesheet rather than being a Glance-local one-off mock like the other three files.

## 6. Recurring components / interaction patterns

- **Epistemic glyph system**: `✓` verified fact (green), `~` claim/spoken-not-verified (gray, often italic), `?` unverified — stated as an explicit invariant in the Object Model ("a claim never dresses as a fact") and drawn in the 1a WIRE timeline.
- **Status/owed glyph set**: `●` running/busy (green), `◐` waiting-on-you (amber), `○` idle (gray), `◆` gate/needs-decision (amber diamond), `■` destructive decision pending (red square), `✗`/X-stroke `gFail` glyph for failure, ring/open-circle for "bounded," folder-rect glyph for plans, ring+dot for "orchestrator."
- **The pin / pinned board**: the room's top region holding "what needs attention now" — running agents, escalated gates, destructive decisions — with three explicit sort/fold rules (from turn 17a): units with something owed sort to the top and open; orchestrators running clean fold to a count; clean singles compress into one row. "The pin never scrolls — it folds." Failures (turn 18a) sort to the very top, above gates and above merges, described as "unpaid attention," with inline triage (retry / respawn with context / let settle as failed).
- **Needs-you affordance**: an inline amber-bordered card interrupting the timeline/feed, format `◆ NEEDS YOU: <question>` with action buttons and an escape hatch ("OPEN THE UNIT →"). Escalates up the tree (session → plan → agent rail badge → room pin) per Object Model §9.4 — folding hides noise, never signals.
- **Destructive-action card / hold-to-arm**: red-bordered card explicitly labeled "DESTRUCTIVE — VOICE CANNOT APPROVE THIS," a primary action button and a reject/keep button; the Process Tree component implements this literally as a mouse-down-and-hold progress-bar-fill button plus a separate reject action, with a companion 2-button gate variant styled as terminal-like `[y] scrub` / `[n] keep`.
- **Receipts**: every settled unit shows `✓ settled → receipt`, and a parent receipt links/indexes its children's receipts (worked example in Object Model 9.5: plan receipt → backfill session receipt + tests session receipt + merge PR receipt).
- **Rail summarization**: agents show aggregate session counts + glyphs (e.g. `▣ 2 · ◆ 1 waiting`) rather than individual task names, per the "rail summarizes sessions per agent" rule.
- **"Surfaces" pattern** (turns 9, 8): three cross-cutting aggregate views — **decisions** (everything waiting on a human, hardest-first, with receipts once answered), **unseen** ("what happened while you weren't looking," grouped per agent, needs-you first, no fake mark-all-read), **cost** (per-unit burn + trend + budget-vs-actual) — iterated across turn 8 as rail rows vs. one quiet status line vs. a top glyph-strip.
- **Depth/navigation pattern** (turn 10): "spine stack" (pushed panes slide over, staying visible as a clickable labeled spine — depth is spatial) vs. "flat trail" (breadcrumb-only, no spatial stacking) — an explicit A/B on how nested drill-downs (room → call → decision, or room → agent → sub-session) should visually stack.
- **Truncate-with-hover-reveal**: seen in Process Tree's detail column (`.pt-detail:hover .pt-full`) — long text truncates inline, full text appears in an absolutely positioned popover on hover.
- **Live/speaking indication**: pulsing dot (`gl-pulse` keyframe) for "on call/live," blinking text-cursor block (`gl-blink` keyframe) for actively-streaming speech, and a colored `box-shadow` ring/glow around the speaking participant's avatar — same visual grammar used for both the call-pane header dot and individual participant tiles.
- **Agent roster used throughout mocks**: hexi (auth refactor), charm (db/users migration — the recurring orchestrator example), sage (restyle/css), mote (infra audit, "bounded"/dry-run mode), ivy (appears failed in turn 18a), nova, quill, plus the voice agent glance itself.

## 7. Notable verbatim designer annotations (from Explorations, turn titles + option labels)

Turn 19 title: *"Servers — a layer above rooms/agents/humans. Three ways to hold it"* — 19a Discord-style tile strip ("costs 46px forever"), 19b Slack-style switcher ("other servers are invisible until you open it"), 19c unified rail ("Best for an operator who runs 2-3 servers at once; noisiest at 10").

Turn 18: *"A failed unit — failure is owed until you triage it"* — 18a: "ivy died mid-run. The failure sorts to the very top of the pin ... because a dead unit is unpaid attention."

Turn 17: *"The pin under load — 8 units, 2 orchestrators. Owed floats up, clean compresses down."*

Turn 16: *"The definitive room, v2 — live call + the pinned board. Everything owed lives in the pin, per unit."*

Turn 15: *"Your model: running units pinned above a live feed, sub-units drop down inside the pin — recursively in #charm"* — 15b: "the pattern recurses wherever there's an orchestrator."

Turn 13: *"The receipt — charm's closing document"* — 13a: "the story on the left ... the ledger on the right (every human decision with its receipt, the cost, and the claims nobody ever checked — kept, not buried)."

Turn 12: *"The two empty states — day one (never used) and the quiet room (earned silence)"* — 12a DAY ONE: "No fake data, no dashboard cosplay: the room admits it's new and offers exactly three first moves." 12b QUIET ROOM: "The silence is presented as a result, not an absence."

Turn 9: decisions/unseen/cost surfaces — 9b: "Seen is per-group, not one big mark-all-read lie." 9c: "Snapshots are the same token-burn events the timeline shows."

Turn 4: 4c THE CALLS LEDGER — "Orphans aren't an alert, they're a row that won't balance: still burning, attached to nothing." 4d plan surface — "machine chrome stays mono, human prose goes serif-less sans."

Turn 1 (the four founding languages): 1a WIRE ("Terminal-dense"), 1b PLEX ("Discord model"), 1c DAYLIGHT ("the light mode exists"), 1d DECK ("Teams' best trick" is referenced separately at 5c re: call-hover peek).

## Notes on scope / things not fully exhausted

- Explorations file has 19 turns × 2-4 options each (~50 full UI mocks); I extracted every turn title and every option's designer-annotation label verbatim, but did not render/describe every one of the ~50 individual mock layouts pixel-by-pixel — only the ones most informative for IA/visual-language purposes (1a WIRE in detail as the founding template).
- Room Prototype is a large, functioning JS app (2401 lines) with many more state branches (settings sub-panels, DM view, file view, tiles/call-grid view, ops view) not fully itemized line-by-line — the IA section above covers its major panes and interaction patterns but a full settings-schema dump was out of scope for this pass.
