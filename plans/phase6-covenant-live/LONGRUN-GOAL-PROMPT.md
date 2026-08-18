# Phase 6 — long-running autonomous goal prompt

> Paste this to start (or restart) a long, unattended run. It is self-contained: a fresh session
> can pick it up cold. It drives ONE far-but-reachable destination autonomously, stopping only at
> the enumerated human-reserved lines. Read the campaign skill (`/campaign`) — this prompt runs
> inside its loop with the long-run amendments below.

---

## THE GOAL (far, realistic, autonomous-reachable)

Drive the Atrium covenant-live product to its **full destination, staged and green on `int/phase6`,
ready for Lars's one-command land** — without a human in the loop. Tracker: GitHub lmvdz/atrium,
map **#162** (drive its frontier; the destination is recorded there).

**Done = ALL of the following hold, verified by driving, green twice at concurrency:**
1. Conversation is a live multiplayer CRDT document (Yjs over Electric Durable Streams) — **two real
   browsers**, not two panes in one process, converge on both content and covenant state.
2. Agent-peers edit as first-class peers (presence, constrained tool surface, `~`-never-`✓`).
3. The **acceptance scenario (#200/#167) passes green twice under concurrency**: a human `✓`-certifies
   a span; an agent-peer edits it; the `✓` visibly de-certifies to `~` in front of the human within a
   render tick; an exact revert re-validates to `✓`; no false `✓` is ever observable (the cardinal
   invariant). Judged against `plans/phase6-covenant-live/DRIVABLE-ACCEPTANCE-RUBRIC.md` — all 16
   criteria at the real-browser level, including reconnect-resync (#16) and clean-merge-broken-meaning
   (#13).
4. Worktree co-replication over the same Electric stream (#185) — the integrity invariant spans
   conversation AND worktree/diff spans, not just chat.
5. The merged `int/phase6` tree is green: typecheck + full integration suite ON THE MERGED TREE
   (not per-branch), driven end-to-end, with a fresh-session cold read of the demo runbook passing.

**Explicitly NOT in this goal (do not do these autonomously):** land to main; any covenant-MEANING
change; the certify-`✓`/spend ACTS to the durable ledger. Reaching "ready for Lars's land" IS the
destination — stop there and surface it.

---

## AUTONOMY CONTRACT

**Execution override (recorded authority; reopenable):** resolve every grilling-type decision
autonomously on the map's recorded authority — the three papers, the settled inputs (#162 Notes),
prior decisions, the ratified digest model — **never on invented preference**. Each resolution states
the authority it rests on and stays reopenable. Do not stop to ask; take the next obvious step.

**Reserved for Lars — the ONLY things that halt the run.** When one is genuinely reached, do the
autonomous work right up to its edge, stage it, and surface a single crisp decision via
PushNotification; keep other lanes moving meanwhile — never idle the whole run on one gate:
- Land-to-main (the destination hands him a ready branch, not a merge).
- Any change to what the covenant MEANS (digest model is ratified; E5 #205's three meaning-flags:
  message_posted act-vs-content, compaction-GC of anchor provenance, seed-of-old-conversations).
- The certify-`✓` / spend ACTS to the durable ledger, and #208 (app-as-non-owner Postgres role) —
  the machine only ever DRAFTS `~`.

**Communicate decisions and results, never waits.** Do not narrate polling. Report when a round
unblocks a destination ticket, when an increment is driven green, when a Lars-line is reached, or
when a stop-condition below fires.

---

## VALIDATION GATE (the reason this run exists — do not skip)

Verification ≠ validation. Green gauntlets are not a driven product. **Every increment ends by
driving the actual product against the rubric, in a browser** — not by a green typecheck. Keep a
`product last driven end-to-end: <date>` line on #162 and read it every dispatch; its staleness is
the top drift signal. When a loop starts finding bugs in its own fixes, or chasing races no user can
reach, STOP gauntleting and go drive the product — that self-referential churn is what this whole
phase was pivoted to kill. Reserve the heavy 3-lineage gauntlet for TRUST boundaries and the FINAL
merged composition; wiring/render lanes get a lighter touch + a blind A/B against the rubric.

---

## LEADING-INDICATOR STOP CONDITIONS (can fail EARLY — this is what makes a long run safe)

Phrase every check as "has progress toward the destination happened recently?", never "is the
destination built?" (the latter only ever says *not yet*, then fires too late). Evaluate all of these
at the top of each round; if any trips, HALT and surface it rather than continuing to spend:
- **Destination drift:** count consecutive dispatches that unblock NO destination ticket (#200, #185,
  #204, #206, or the acceptance). "None directly" is a legal per-round answer; the *count trending up*
  is the drift signal. If it reaches 3, stop and re-plan the critical path — do not dispatch a 4th.
- **Un-driven product:** if `product last driven end-to-end` is more than 2 destination-advancing
  rounds stale, the next action MUST be to drive it, not to build more.
- **Cost vs. value:** tally subagent token cost per lane from every completion notification into a
  running per-lane total on #162. If any single lane's cost exceeds a full re-build of that lane with
  no green increment to show, halt that lane and surface it.
- **Merge divergence:** if any build branch has been unmerged onto `int/phase6` for more than a day,
  rebase and run the integration suite on the merged tree before any new lane — divergent lanes
  compose into dead paths with zero conflicts.
- **Gauntlet exhaustion:** if a lane reaches round 4 with its top adjudicated finding not
  user-reachable, stop the loop on that lane, route residuals to owning tickets, and move the frontier.

---

## THE LOOP (campaign phases, long-run amendments)

Run `/campaign`'s DRIVE→BUILD→GAUNTLET loop with these standing rules:
- **Name the destination ticket each round unblocks** before dispatching it. Keep an explicit critical
  path on #162 and re-read it every dispatch — the loop is a quality mechanism, the map is the scheduler.
- **Merge continuously** onto `int/phase6`; run the INTEGRATION suite on the merged tree daily. A green
  per-branch typecheck proves nothing about two producers disagreeing across a merge.
- **Tally cost as it accrues** (per-lane token totals on #162). A run that can't say what a lane cost
  can't notice a lane costing more than it's worth.
- **Resource discipline (only the orchestrator can enforce it):** check `/proc/loadavg` before every
  dispatch; cap concurrent heavy lanes at cores/2 (~2 on this 4-core box); if load > cores, wait,
  don't queue. Reap worktrees/containers/dev-servers at every completion notification. Foreign lanes
  via `~/.claude/scripts/{codex,grok}-lane.sh`, backgrounded to a file, never a relay wrapper, never
  `&` inside a run_in_background Bash. ALWAYS verify a critic reviewed the right sha before trusting it.
- **Enrich every build ticket at birth** (Question/Context/Touches/Acceptance/Gate/Scope/Gauntlet) and
  tell every builder to verify the ticket's claims against the tree and report contradictions.
- **Test handoffs cold with a foreign model** before trusting them; **record lessons where the next
  session reads** (RETRO.md + the map + auto-memory), then grep the rule's name to confirm something
  enforces it.
- **RETRO is standing:** every closed ticket appends an entry; the weekly staleness sweep runs; prune
  or re-justify one process rule at each phase boundary.

---

## STATE AT WRITING (2026-08-18)

- Covenant ENGINE merged + gauntlet-proven on `int/phase6` @ **ecdda25** (typecheck + ~570 integration
  green on real Postgres): E1 Electric fabric, E2 authenticated append door, E3 server replica, E7
  DETECT drift sweep, E8 certify UI (dormant), ER green baseline. The two transports exist but were
  never instantiated — no live peer-edit path shipped yet.
- **In flight: #212** thin drivable covenant slice (in-process InMemoryHub, two panes, client-side
  `resolveCovenant`, glyph flips `✓→~`) — the first drive of the product. Rubric fixed at
  `plans/phase6-covenant-live/DRIVABLE-ACCEPTANCE-RUBRIC.md`.
- **Critical path to the destination:** #212 (drive it, prove the covenant honesty gestures) →
  **Electric two-real-browser** convergence (rubric 11/12/16) → **E4 #204** full client Y.Doc surface
  + **E6 #206** verdict shape (production glyph fed by the real server DETECT verdict, not a client
  demo resolver) → **agent-as-peer #184** → **worktree co-replication #185** → **acceptance #200/#167
  green twice at concurrency** → stage on int/phase6, surface to Lars for land.
- Ratified (Lars, 2026-08-17): the DIGEST MODEL — `✓` = "current content == what I signed";
  re-validates on exact revert; machine drafts `~` only. Governs the whole integrity path.

---

## RESTART NOTE

If you are a fresh session reading this cold: the map is #162, the bar is the rubric file, the base is
`int/phase6` (verify by sha — the prototype tree lives only there, not on main). Re-derive the live
state from the tracker and the merged tree, not from this file's STATE block (it is dated evidence,
not current truth). Then resume the loop at the frontier. Drive the product; don't just gauntlet it.
