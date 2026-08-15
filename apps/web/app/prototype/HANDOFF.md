# Prototype → App Handoff (Phase 5)

The `/prototype` route is the **design-complete target** for the Atrium operator
surface: process tree → thread → split artifact pane, under the covenant. It is a
DESIGN prototype built on a **mock substrate**. The phase-5 port's job is not a
copy-paste — it is to **re-seat this UI shell onto real ledger / session / diff
data**, keeping the interaction design and the covenant invariants intact.

## Entry & files

| file | role |
|---|---|
| `page.tsx` | renders `<MoldingSurface/>` on a full-bleed ground |
| `MoldingSurface.tsx` | the entire surface (~2400 lines) — every component below lives here |
| `prototype.module.css` | all styles; colours come only from `design/tokens.css` (WIRE) |
| `mock.ts` | **the mock substrate — this is what the port replaces** |
| `chrome-gate.tsx` + `layout.tsx` | hides the global top bar on `/prototype` (the surface owns its own chrome via the left-pane user bar); `ChromeGate` is a no-op on every other route |

## Component map (all in `MoldingSurface.tsx`)

- **Icons** — real brand marks (`IconAnthropic` / `IconOpenAI` / `IconXai`, official paths) + thin-stroke WIRE glyphs. `ProviderMark` picks by model name.
- **NavTree** — the process tree (agent → plan → session). State reads from indentation + connector colour (green selected / amber drift), not rails.
- **ChatBlock** — the thread + the only input. Contains `ChatTopBar` (title · participants · share), the message list (`ChatMessage` / `Turn` / `TurnStepRow`), `DraftComment` (live portal), `TypingRow`, `Composer`, `ChatMinimap`, `ThreadStatus`.
- **ChatMinimap** — VSCode-style scrubber in the right gutter; measured live from the scroll container via `data-mm-*` attrs.
- **ArtifactPane** — icon-only switcher hosting **`DiffView`** (prism syntax highlight over a real unified diff, line-anchored comments) and **`DocView`** (react-markdown; inline adjustable-selection comments that make space + mirror to chat live).
- **UserBar / SharePopover** — account chrome (left-pane foot) and the share flow.

## The seam map — mock → real (the actual port)

| Prototype (mock) | Real source |
|---|---|
| `AGENTS` in `mock.ts` (agents/plans/sessions tree) | ledger: agents, plans, sessions |
| `INVOICE_DIFF` (static unified-diff string) | real `git diff` for the session branch |
| `useMockPRStream` (scripted wall-clock replay) | real diff / turn stream (settle events + live) |
| `CONVERSATIONS` / `CONVO_*` (literals) | the thread's real messages |
| `ARTIFACTS` (hardcoded diff/plan/doc) | the session's real artifacts |
| `comments` state (local) | ledger comments, anchored (`path:line` or prose quote) |
| `draftComment` (local) | live multiplayer comment draft (presence) |
| `participantsFor` (derived from convo) | room presence |
| `TEAMS` | org roll-up (may already be dead — verify before porting) |

## Actions currently visual-only — need wiring

- ArtifactPane footer **certify** / the `✓` mark → the human certification gate (`certified_by`). **This is the covenant's whole point — wire it honestly.**
- `ThreadStatus` **run ▶** → dispatch/run.
- `SharePopover` invite / copy-link → real share.
- Minimap **⌘-click bookmark** → persist.
- Comment submit (diff line + doc prose) → write to ledger.
- `Composer` send / `@mention` delegate / `@hexi stop` steer → real dispatch.

## Covenant invariants — KEEP (these are real, not mock)

- `~` = machine draft, `✓` = human-certified; **the machine never certifies.**
- No numeric confidence ornament; epistemic state is `~` or `✓` with provenance.
- Selected tree row bleeds into the chat surface (`--bg1`), no divider.
- Shared sizing tokens: `--head-h` (all three column headers), `--foot-h` (status / artifact-footer / user bar). Keep them equal — that uniformity is deliberate.

## Dependencies

- **Already committed & used:** `react-markdown`, `remark-gfm`, `prism-react-renderer`.
- **Stray to drop:** `thinking-orbs` was added then abandoned (the tree orbs are now a CSS pulse dot, `.tRunDot`). It is not imported anywhere — remove it from `package.json` when the port lands.

## Dropped in this handoff

- Deleted dead canvas-era files: `Graph.tsx`, `SystemMap.tsx`, `graph.ts` (unreachable from `page.tsx`; leftovers from the abandoned windowing/canvas direction).

## Mock-isms to be aware of

- The off-scope `src/auth/session.ts` drift inside `INVOICE_DIFF` is **scripted** to demo the "catch the wrong 70% before it's written" moment — it is design intent, not a real finding.
- Stream timings are illustrative (`~$0.34/s`, phase durations).
- localStorage: `atrium-side-w` persists the tree pane width.
