# Scout brief: Atrium v3 / v3 Canvas / v4 (mid group)

Source files (all self-contained `.dc.html` "design canvas" documents built on a custom
`<x-dc>` web component + `support.js` runtime, using `{{ }}` template bindings, `sc-if`/`sc-for`
directives, and inline `onClick`/state-machine JS — these are **interactive, stateful app
prototypes**, not flat mockup images):

- `Atrium v3 Canvas.dc.html` — 313 lines, 36KB. `<meta name="design_doc_mode" content="canvas">`. Static (non-interactive) side-by-side comparison of 2 layout variants of one scenario.
- `Atrium v3.dc.html` — 3316 lines, 356KB. Fully interactive single-app prototype (JS state machine, ~300+ state keys).
- `Atrium v4.dc.html` — 3364 lines, 362KB. Same interactive prototype, iterated from v3.

---

## 1. What each file contains

### Atrium v3 Canvas.dc.html
Two frames (`#1a`, `#1b`), each 1340×820px, laid out side by side, both dramatizing the **same
moment**: room `#fleet`, agent `charm` mid-migration, blocked on a human decision, live call in
progress. Verbatim canvas annotation (top of doc):

> "v3 — the critique applied: attention first, state materialized, conversation primary, signals
> distinct from processes. Two takes on the same #fleet moment."

- **1a** label: "attention strip · state brief · conversation-primary feed · right pane = Context | Call | Evidence"
- **1b** label: "conversation IS the room · work pin is one glance line per agent · call transcript with live process links"

1a has a separate "CURRENT WORK" state-lens block above the conversation, with agent status rows
below it, plus a "SINCE 12:02" digest block. 1b collapses that into a single "WORKING NOW" strip
(one line per agent, pinned decision surfaces directly in the conversation flow as a chat-embedded
card) — i.e., 1a keeps state and conversation as separate panels; 1b merges the pinned-decision
card into the message stream itself. Both share identical rail/server-strip/right-pane chrome —
only the center pane's information architecture differs. This file is a **precursor exploration**
for the interactive v3 build: same scenario (charm/hexi/mote/ivy, priya on the call, "users
migration," fixture-policy decision, PR #482 merge gate) reappears verbatim as the seeded demo
data in `Atrium v3.dc.html`.

### Atrium v3.dc.html / Atrium v4.dc.html
Not discrete frames — a single full-window (100vw/100vh, min 1340×760) interactive app with a
live JS model. View router (`goView()`) targets found in both: `fleet` (room), `charm`,
`charm/backfill`, `charm/tests` (agent + its named work-sessions), `hexi`, `mote`, `nova` (other
agents), `me` (profile/identity), `ops` (new-room flow), `settings`. Both files share **identical**
`:root` design tokens, identical section labels, and near-identical markup — v4 is a refinement
pass on v3, not a redesign. A `diff` of the two (tag-stripped) found only ~14 discrete change
clusters (detailed in §6) touching interaction model and room/session hierarchy, not visual design.

---

## 2. Information architecture (frame regions)

Consistent 4-column grid across all three files: `46px | 216px | 1fr | 316px`
(server strip / left rail / center workspace / right context pane).

- **Server strip** (46px, leftmost, dark "strip" background even in light theme): vertical stack
  of server/workspace tile icons (single-letter avatars, e.g. "A" active-highlighted, "R", "K"),
  plus a user avatar chip pinned to the bottom. Reads as a Slack/Discord-style workspace switcher.
- **Left rail** (216px): "atrium" wordmark header → **ROOMS** section (channel-like list, e.g.
  `#fleet` with an amber `◆2` needs-you badge, `#design`) → **AGENTS** section (search icon, each
  row = identity + terse state phrase + optional owed badge, e.g. `charm  working · 3 sessions
  ◆2`, `ivy  failed · session kept  ✕1`) → **HUMANS** section (presence dot + name + status, e.g.
  `priya  ● on call`, `sam` idle/offline dot).
- **Center workspace**: horizontal tab strip (open rooms/agents/DMs as tabs, `+` new-room button
  in v4) → room header (name, agent/human counts, live-call indicator) → one or more sticky
  "lens" strips (attention strip, current-work strip, since-digest — v3 Canvas 1a; collapsed into
  one "working now" strip in 1b) → scrolling conversation feed → composer.
- **Right context pane**: persistent call header (LIVE badge + stacked participant avatars +
  mic/leave icons) → pane tabs (`context | call | evidence`) → tab content (selected-item detail,
  decision card, evidence checklist, "from the call" excerpt).

The interactive v3/v4 builds add: a draggable/resizable **picture-in-picture (PiP)** floating call
window (`pipShow`, `pipDrag`, `pipResize`, `pipTitle`, "open as tab" / hide / stop-watching
controls); a right-click **rail context menu** (`railCtxOpen`) for rooms/agents; a **tab context
menu**; a multi-tile **stream grid** for screen-shares during calls (`streamGridRef`,
`streamCols`/`streamRows`, adjustable split, "ACTIVE CALLS · 1" header); a **terminal pane**
(`termLines`, `termScrollRef`) opened per agent session; a **file tree / file viewer**
(`fileTree`, `fileLines`); breadcrumbs (`crumbSegs`/`crumbParts`); a slash-command palette
(`slashList`, `/room`, mention autocomplete `mentionList`); a **status deep-dive modal**
(`statDeepRows`, `statCfgRows`) with per-mode segmented bars; and a settings surface (repositories,
model/repo config dropdowns, human roster, notification prefs, agent access control).

---

## 3. Design tokens

**Typography**: `IBM Plex Mono` (ital/wght 400/500/600, italic 400) for nearly all UI chrome,
labels, timestamps, code/terminal — `Inter` (400/500/600/700) for the wordmark and a few sans
labels. `Sora` (600/700) is imported via Google Fonts `<link>` in both v3 and v4 but **never
referenced in any `font-family` declaration** — a vestigial/unused import in both files.

**Type scale** (v3, by frequency): dominated by 10–11.5px (10px ×167, 11px ×100, 10.5px ×41,
11.5px ×24) — a very dense, small, mono-heavy UI. Larger sizes (12–16px, 20px, 24px) are rare,
reserved for headline/counter moments (e.g. modal titles, big numbers). Section-header labels use
10px with `letter-spacing:.14em` and uppercase text (`ROOMS`, `AGENTS`, `HUMANS`, `CURRENT WORK`,
`SINCE`, `WHY THIS EXISTS`, `DONE WHEN`, `GROUNDED IN`, `TOUCHES`, `APPROACH`, `STEPS`,
`RECEIPTS`, `NEEDS A HUMAN`, `VERIFICATION`, `ROLLBACK`, `ROLLUP`, `LINKED`, `SESSIONS`,
`ARTIFACTS`, `DESTINATION`, `IDENTITY`, `PROFILE`, `NOTIFICATIONS`, `AGENT ACCESS`,
`REPOSITORIES`, `COMMANDS`, `CHANNEL`, `AUDIO`, `NEW CALL`).

**Color — light theme is default `:root`** (v3 Canvas is dark-only; v3/v4 default to *light* with
a `.atr-dark` class override, i.e. the interactive builds ship both themes, toggled by a class on
`<html>`):
- Backgrounds: warm off-white/paper stack `--bg0:#E6E2DA` → `--bg7:#EFEAE0` (7 steps).
- Text: near-black `--tx0:#171A18` down to faint `--tx4:#A39B89` (4 steps).
- Lines/borders: `--line:#D4CDBD`, `--line2:#C8C1B4`, `--line3:#B0A896`.
- Semantic accents (3-step fg/bg/border families each): green `--grn:#4E9161` (success/verified/
  active), amber `--amb:#B07D2A` (needs-you/decision/waiting), red `--red:#B3402E`
  (failed/irreversible/danger), blue `--blu:#3D6BB3` (human/link/mention).
- Special "strip" palette for the server rail: `--strip:#173A32` (dark green, always dark even in
  light theme) with `--stile`/`--stileac`/`--stbd`/`--stx` tile states.
- Call-specific `--live:#9BB3A0`, reply/file chip backgrounds `--replybg`, `--filebg`/`--filebd`.

**Dark theme** (`html.atr-dark`): near-black stack `--bg0:#0a0b0c` → `--bg7:#0e1012`, text
`--tx0:#e8eaec` → `--tx4:#3f4348`, same semantic hue families re-tuned for dark (`--grn:#5CB27A`,
`--amb:#C99A3F`, `--red:#D4604A`, `--blu:#8AB4F8`). This dark palette is **identical** to the
hardcoded palette used in `Atrium v3 Canvas.dc.html`, confirming Canvas was the dark-mode-only
precursor later generalized into a light/dark token system for the real build.

**Spacing / motion**: dense paddings, mostly `2–14px`. Keyframes: `gl-blink` (caret blink),
`gl-pulse` (opacity pulse for live/recording indicators, 1.6s), `gl-rise` (fade+translateY(2px)
entrance, .15–.3s, used for new events/cards appearing). `prefers-reduced-motion` respected
globally (`animation:none!important`). Custom scrollbar styling (8px, thin, track transparent).

---

## 4. Recurring components and patterns

- **Epistemic/status glyph system** (single-character markers on every event/row, consistent
  across all three files): `·` neutral/routine event · `✓` verified/done (`gCheck`, green) · `~`
  unverified claim — an agent's own self-report, rendered in quotes with a dotted underline, e.g.
  `~ "token rotation logic is done, starting the refresh path"` (`gClaim`) · `◆` needs-a-human /
  decision pending (`gDiamond`, amber) · `■` irreversible action gate, requires explicit arming
  (`gSquare`, red, pattern: "hold to arm" button) · `✗` failed (`gFail`, red) · `●` live/actively
  running (`gLive`, green) · `◎` orchestrator/supervisor role (`gOrch`) · `○` idle/bench agent
  (`gIdle`) · `↪`/`↩` steered/redirected (`gSteer`). This glyph vocabulary is the backbone of every
  list row, timeline entry, and rail badge.
- **Attention strip / "needs you" affordance**: an amber banner row pinned at the top of the
  center pane listing outstanding decisions as clickable chips (e.g. `fixture policy · tests`,
  `■ merge authorization · PR #482`), trailed by `everything else is green` — collapses the whole
  room's status to "how many things need me" as the single scan-first anchor.
- **Decision card**: bordered/tinted box (amber for pending decision, red for irreversible action)
  with a question, evidence bullets, and inline action buttons with keyboard shortcuts shown
  (`scrub — y` / `keep — n`). Appears both as a right-pane "Context" tab content and inline in the
  conversation feed (chat-embedded pin) depending on which IA variant.
- **Pinned/rollup rows**: `pinwrap`/`pinhandle` CSS classes — hover-revealed pin handles on
  message rows, collapsible content.
- **Conversation feed**: primary content in the center pane; system/agent messages carry a
  routed-to breadcrumb (`↳ routed to charm › users migration › tests`), collapsed-routine-event
  dividers (`31 routine events collapsed`), and inline evidence chips (`✓ 214/214 verified · ci ·
  full suite`).
- **Call UI**: persistent header with `LIVE 12:47` pulsing badge, stacked circular avatars
  (overlapping, ring-highlighted for the active speaker), mic/leave-call icon buttons, a live
  caption line (`▌ atrium is speaking — captions settle in place…`), and an explicit voice-scope
  guardrail printed at the pane's footer: *"voice can steer and answer — it can never merge,
  publish, spend, or delete. those defer to a decision card here."* — a stated design rule that
  irreversible/high-stakes actions always require the visual decision-card affordance, never voice
  alone.
- **Plan document component** (recurring, identical copy in both v3 and v4): sections `WHY THIS
  EXISTS`, `DONE WHEN`, `GROUNDED IN`, `TOUCHES`, `STEPS`, `APPROACH`. Example seeded content (a
  "users migration" plan): *"v1 can't match emails case-insensitively — 41k people have duplicate
  accounts because of it."* / done-when: *"every read hits users_v2, duplicates merged, and a week
  passes with v1 untouched."* / grounded-in: *"3 verified receipts — schema diff (0 destructive),
  write parity 512/512, checksummed dry run."*
- **Receipts / evidence system**: checklist rows with ✓/✗ glyphs (`rcVer`), grouped key/value
  detail sections (`rcSide`), a dedicated header (v3) that got simplified to an inline label (v4,
  see §6). Evidence chips reused across decision cards, plan "grounded in," and per-message
  verification badges.
- **Harness/resource bars** in the composer: small skewed-rectangle segmented bars
  (`harnessBars`, per-mode `hb.segs`) with a percentage readout, next to a labeled coding-CLI name
  (`HARNESS` map — e.g. `claude code v3.2 · session of hexi`) — models each agent session as
  running inside a named external coding harness/CLI, with visible resource/context consumption.
- **Access control**: per-agent permission chips — `none / read / read+write` — settable inline
  in a settings-style access list (`accessList`), agents shown as `hexi`, `charm` (labeled
  "orchestrator · crew 3"), `mote`.
- **Canvas/exploration frame chrome** (Canvas file only): each frame gets a small numbered label
  chip (`1a`, `1b`) plus a monospace one-line description of what the variant is testing, laid out
  in a flex-wrap gallery — the standard "design canvas" comparison-frame pattern.

---

## 5. Object model (nouns and hierarchy)

- **Server/workspace** (outermost) → contains **rooms**.
- **Room** (e.g. `#fleet`, `#design`) — has agents, humans, an optional live call, a conversation
  feed, pinned decisions/attention items. Rooms can be created by a human (`doCreateRoom`, `/room`
  slash command in v4) — creator becomes admin.
- **Agent** — named individuals (`charm`, `hexi`, `mote`, `nova`, `ivy`, plus an idle bench:
  `sage`, `wren`, `moss`, `pika`, `juno`, `dot`, `birch`). Each has: a glyph/role state (live,
  orchestrator, idle, failed, bounded), an access level against the room's resources, and can run
  one or more **sessions** underneath it.
- **Session / work-item** — named sub-scopes under an agent, e.g. `charm/backfill`,
  `charm/tests`, `hexi/auth`, `hexi/flaky`. Each session runs inside a **harness** (a coding CLI,
  e.g. "claude code") and has its own terminal, its own event log, its own verified/claimed
  status. v4 makes sessions independently addressable/focusable (see §6) — a structural
  granularity increase from "agent" to "agent/session."
- **Plan** — a structured document (why/done-when/grounded-in/touches/steps/approach) attached to
  an agent's work, draftable by an orchestrator agent (`sage`) once a **pre-plan** resolves.
- **Pre-plan / "wayfinding"** — a distinct planning-before-planning feature (v3 & v4, described
  fully in §6) modeled as a map: **destination** (the named goal) → **fog** (unstated/unclear
  questions) → **frontier** (questions that have become answerable/stateable) → **decided**
  (resolved questions) → once frontier is empty, **drafted** (sage writes the actual Plan, with
  the decision map retained as its "receipt trail").
- **Decision** — a discrete human-answerable question, amber-coded, with explicit action buttons
  and keyboard shortcuts; can be answered from chat, from a pin, or from the right pane.
- **Irreversible action** — red-coded, requires explicit arming (never voice-triggered), e.g.
  "merge PR #482 → main."
- **Receipt / evidence** — verification artifacts (test runs, schema diffs, checksums) attached to
  claims, decisions, and plans, always rendered with ✓/✗ glyphs.
- **Human** — participants with presence (`on call`, `away`, offline dot), can DM agents or
  humans, has a `me` profile/identity view and notification preferences.
- **Call** — a live voice/video session scoped to a room, with participants (subset of the room's
  agents/humans), screen-share streams (multi-tile grid), and a caption/transcript feed separate
  from the room's text conversation.

---

## 6. Evolution within this group (v3 Canvas → v3 → v4)

**Canvas → v3 (interactive build)**: Canvas is a static two-frame comparison exploring information
architecture ("attention first, state materialized, conversation primary") for one fixed scenario.
v3 takes 1a's IA (separate attention strip + current-work lens + conversation) as the shipped
default and turns it into a fully interactive, stateful app — same demo data (charm/hexi/mote/ivy,
priya, "users migration," fixture-policy decision, PR #482) is retained verbatim as v3's seed
state. The dark-theme token values in Canvas carry over unchanged into v3's `.atr-dark` class; v3
additionally adds a full light theme as the new default. 1b's "conversation IS the room" /
chat-embedded-decision-card approach and its call-transcript-with-process-links right pane do not
appear to have been carried forward as the primary layout — v3's right pane instead generalizes
to a 3-tab `context | call | evidence` pane matching 1a, though the "voice can steer/answer but
never merge/publish/spend/delete" guardrail copy from 1b's call footer persists into the shipped
product's design rules (implicit in v3/v4's separation of decision-cards from voice).

**v3 → v4** (diff of ~14 clusters, interaction/hierarchy changes only — no design-token or visual
changes):

1. **Rail can no longer be collapsed** — v3 had a working fold/unfold toggle (`toggleRail`,
   `railOpen` state); v4 hardcodes `railOpen: false` and turns `toggleRail` into a no-op. The
   fold-rail affordance was tried and dropped.
2. **Room creation promoted to a first-class flow**: v4 adds a `+` "new room" button next to the
   tab strip and a `/room <name>` slash command (`doCreateRoom`), both wired to the same handler
   that was previously only reachable via the `ops` view's internal action. Toast copy
   acknowledges the prototype's limits: *"one extra room in this prototype — #new-room-1
   reopened."*
3. **Sessions become independently addressable nodes**: v3 treated `hexi`'s two concurrent
   work-threads (`auth` rotation, `flaky`-test hunt) as a single collapsed agent focus
   (`focusAgentRow('hexi')`, one shared `termMode.hexi`). v4 splits them into separate keyed
   entities `hexi/auth` and `hexi/flaky`, each with its own seeded event log, its own harness
   binding, its own terminal mode key, and its own focus/click targets
   (`focusNode('hexi/auth')`). This is a genuine object-model change: agent → session becomes a
   first-class two-level address, not just a UI grouping.
4. **New double-click-to-open interaction**: v4 adds `dbl`/`dblView(key)` handlers to nearly every
   agent/session row (hexi, hexi/auth, hexi/flaky, charm, charm/backfill, mote, ivy, nova, sage) —
   single-click now means "focus/preview inline," double-click means "navigate to the dedicated
   full view" (`goView`). v3 only had single-click focus, no dedicated-view shortcut from the
   tree.
5. **Fleet row tree restructured into an explicit collapsible hierarchy** — v4 adds a code comment
   stating the intent directly: `// the tree IS the nav — the room sits one level above its
   agents`. A synthetic root row (`# fleet`) is inserted above the agent list with a chip showing
   live agent count and a chevron to collapse/expand all agent rows beneath it; agent rows
   themselves gain the same root/chevron pattern one level down (chip: "sessions N"). Sibling rows
   dim (`opacity:.45`) when a room or sub-mode (plan/wayfind) is focused, to keep visual focus on
   the active branch. v3's tree was a flat, always-fully-expanded list.
6. **`ivy` (the failed agent) is now rendered directly in the fleet tree row list** in v4 with its
   own row (`gc: red, status: '1 failed'`); in v3 ivy only appeared in the left rail, not as a
   fleet-tree row.
7. **Pre-plan/wayfinding becomes foldable under its owning agent**: v4 adds a "pre-plans 1" chip
   on `sage`'s row with its own open/closed toggle (`sageOpen`); in v3 the wayfinding panel had no
   such collapse — it was presumably always visible when active.
8. **Focus-state hygiene improved**: v4's focus/navigation handlers now consistently clear
   `receiptFocus` and exit any open `plan`/`wayfind` terminal sub-mode whenever a different
   room/agent is focused (`roomFocus: null`, or resetting `termMode.charm`/`termMode.sage`); v3's
   equivalent handlers did not reset these, which could leave stale overlay state visible after
   navigating away.
9. **Receipt-view header simplified**: v3 gave receipt views a full top bar (receipt-tag chip +
   name + meta + an explicit "✕ close" button, in a bordered row). v4 removes the separate header
   entirely and inlines just the receipt-tag chip + meta text as a lightweight label at the top of
   the content block (no name, no explicit close control) — a chrome-reduction pass.
10. **Backfill status field split**: v3 concatenated status and elapsed time into one string
    (`'✓ done ' + Xm + ' ago'`); v4 splits this into two separate fields, `status: '✓ done'` and a
    new `doneAgo: 'Xm'` — likely to support independent layout/column control for the two pieces
    of information.
11. **Terminal scroll anchor reordered** in the DOM (the `ref="{{ termScrollRef }}"` scrollable
    container moved relative to a sticky top-spacer div) — a minor layout/scroll-anchoring fix,
    not a visible IA change.

No content in v3 was found that v4 conspicuously dropped outright (no removed sections/labels) —
v4 reads as a strict refinement pass: rail-fold removed, room-creation and session-level
addressing added, tree navigation made hierarchical/collapsible, double-click-to-open added, and
several state-hygiene/chrome-simplification fixes. The underlying visual design system (colors,
type, spacing, component shapes) is unchanged between v3 and v4.

---

## 7. Verbatim design-note / annotation text found

- Canvas top-of-doc annotation: *"v3 — the critique applied: attention first, state materialized,
  conversation primary, signals distinct from processes. Two takes on the same #fleet moment."*
- Frame 1a label: *"attention strip · state brief · conversation-primary feed · right pane =
  Context | Call | Evidence"*
- Frame 1b label: *"conversation IS the room · work pin is one glance line per agent · call
  transcript with live process links"*
- Attention strip micro-copy: *"everything else is green"* (used as the reassurance trailer after
  listing what needs you).
- Call-pane footer guardrail (1b): *"voice can steer and answer — it can never merge, publish,
  spend, or delete. those defer to a decision card here."*
- Wayfinding/pre-plan explanatory copy (v3 & v4, identical): *"a fog card graduates to the
  frontier the moment its question can be stated precisely"*; *"not a plan yet — a map of
  decisions. every card resolves a question; resolving a frontier card clears the fog behind
  it."*; *"the frontier emptied, so sage drafted the plan. the map above stays as its receipt
  trail."*; *"the way is clear — N decisions, zero open questions"* → CTA *"sage drafts the plan
  →"*; stage kicker copy: `PRE-PLAN · WAYFINDING · CHARTED WITH SAGE` → on completion `PRE-PLAN →
  PLAN · DRAFTED BY SAGE`.
- Composer placeholder: *"message #fleet — @ mentions route to plans and sessions"*.
- v4-only room-creation toast: *"one extra room in this prototype — #new-room-1 reopened"* (an
  explicit prototype-scope admission left in the mock copy) and system message *"room created by
  lars — invite people or give agents access from settings."*
- v4-only code comment (rare — almost no comments exist elsewhere in either file): *"// the tree
  IS the nav — the room sits one level above its agents"*.
- Plan example content ("users migration"): why — *"v1 can't match emails case-insensitively —
  41k people have duplicate accounts because of it."*; done-when — *"every read hits users_v2,
  duplicates merged, and a week passes with v1 untouched."*; grounded-in — *"3 verified receipts —
  schema diff (0 destructive), write parity 512/512, checksummed dry run."*; approach —
  *"Dual-write first so v2 never falls behind, then backfill history in checkpointed chunks,
  verify both tables agree, and only then flip reads. Nothing is dropped until a week after
  cutover."*

---

*End of brief. Sources: `Atrium v3.dc.html`, `Atrium v3 Canvas.dc.html`, `Atrium v4.dc.html` in
`/mnt/c/Users/Lars/Downloads/Design system for live call interface/`.*
