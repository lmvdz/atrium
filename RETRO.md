# Retrospective log

Standing record of what this project's process gets wrong and right, kept so future decisions are made against evidence instead of memory. Rules:

- **Every closed build ticket appends an entry**: rounds it took, what each gauntlet round caught, findings refuted (with evidence), and the one process lesson worth keeping. The closing session writes it — no entry, no close.
- **Phase boundaries get a full retrospective** (below the running entries): metrics across tickets, doctrine changes, and what gets promoted to the `/campaign` skill or auto-memory (repo lessons stay here; transferable lessons go up).
- Product-level learning is separate and built-in: correction-rate telemetry per accepted object type (decisions #5/#17) is the product retrospecting on its own interpretations. This file is about *process*.

---

## Campaign to date — day-one retrospective (2026-08-01)

**Shape of the campaign so far**: 1 research pre-map (design corpus, 6 prototype versions mined) → map #1 charted with 17 decision tickets → 15 decisions + 3 research tickets resolved in ~one day → 9 build tickets graduated → 3 gauntlets run, all FAIL on round 1, all producing fix rounds that made the work *more architectural*, not more patched.

**What the gauntlet rounds actually caught** (evidence for the method):
- Scaffold r1 (grok + codex, blind): reducer accepted pre-blessed proposals; acceptance ignored proposal lifecycle; both lineages independently converged on the missing durable event ledger — convergence across uncorrelated critics proved to be the strongest signal available.
- Scaffold r2 delta (grok): the r1 fix's *contract claim* outran its guarantee — watermark-on-refusal still allowed live≡replay divergence. Root-cause fix (r3): rejection is a command-layer result, never state. Lesson: **a fix round's own claims need the same adversarial treatment as the original**.
- Prototype r1 (opus rendered + codex source): the answer-binding path hardcoded the answer — recording the *opposite* of what the user typed while labeled "nothing is inferred". Caught in 3 clicks by a critic who actually drove the page. Lesson: **rendered artifacts need a critic that renders them**; source review alone missed half the story.
- Ingest r1 (codex): pagination could silently write a valid-looking partial corpus. Lesson: **the fail-open class (valid-shaped incomplete output) recurs in every layer** — it has now appeared in the reducer, the compose stack, and the fetcher.

**Findings refuted, and why that matters**: 1 of ~40 adjudicated findings was wrong (MinIO healthcheck — the image ships `mc`; the suggested fix would itself have broken the chain), refuted by probing the live container, not by argument. Treating critic findings as hypotheses is not overhead; it caught the one that would have introduced a regression.

**Process corrections made mid-campaign** (each now encoded in `/campaign`):
- Build tickets were born sparse (spec lived in orchestrator prompts) — corrected to Tier-2 enrichment at creation after Lars flagged it. A ticket an agent can't pick up cold is a defect.
- Critic output piped through `tail -c` truncated a verdict; grok's default `--max-turns` once exited 0 with no verdict emitted. Both now handled (file capture; resume with higher turns; missing verdict ≠ pass).
- Demo corpus discovered mid-build to be structurally flat (GitHub issues carry no threading) — the corpus decision was amended on its closed ticket rather than silently changed. Amendments to closed decisions leave the same receipt trail as decisions.

**Metrics to watch as the campaign proceeds**: rounds-per-ticket (currently trending 2–3; if it hits 4+ the builders' first-pass bar is wrong, not the critics'), refuted-finding rate (currently ~2.5%; if it climbs, critics are pattern-matching instead of verifying), and time-from-FAIL-to-fix-dispatch (currently minutes; the gauntlet only works if rounds are cheap).

---

## Closed-ticket entries

**#20 Build: replay ingest** (closed 2026-08-01, 2 rounds). r1 (codex) caught the silent-truncation class: pagination could write a valid-shaped partial corpus; r2 added four throw paths + whole-fetch dedup + per-parent-comment count reconciliation, and proved its new tests against staged round-1 code (which silently dropped 3 of 4 replies in the fixture). r2 delta (grok, rotated lens) passed with zero blocking. Findings refuted: 0; findings re-scoped: 1 (the "verbatim any path" claim was scoped to API bodies — the markdown converter is a parser and normalizes as part of tokenization). Mid-build discovery: GitHub issues carry no reply threading — demo corpus swapped to a threaded discussion via amendment on closed #2. Lesson kept: **absolute claims ("any path", "every secret") attract correct refutations — scope claims to exactly what is guaranteed, in the artifact itself.**

**Process note — interpretation spike** (research, 2026-08-01). Measured on 6 live runs: model confidence carries no signal (0.937 on wrong vs 0.928 on right), so θ-band escalation routing was dead code as designed; #8 amended to deterministic pre-call text triggers. Lesson kept: **route on signals you compute, not signals the model self-reports; and test the cheap tier before building infrastructure around its assumed failure modes.**

## Anti-staleness doctrine

Nothing in this project is allowed to be true only at time of writing. Rules:

- **Everything expirable names its expiry condition.** Fog entries say what they hang on; when that condition clears, graduation is mandatory — a fog entry that outlives its condition is a defect, found by sweep. Decisions carry "reopen if wrong"; amendments land on the closed ticket, never as silent drift. Research briefs carry provenance headers (date + source versions) so staleness is *assessable*.
- **The weekly sweep** (scheduled, automated) checks: open tickets with no activity in 7 days; unmerged branches older than 7 days; fog entries whose named blocker has closed; closed build tickets missing their RETRO entry; RETRO metrics drifting past their stated thresholds; memory/map claims contradicted by repo state. Findings post as a comment on map #1 and, when real, append here. Anything needing a human lands in the attention queue.
- **Staleness of the sweep itself**: if a weekly sweep comment is missing from the map for >10 days, the automation is broken — that absence is itself the highest-priority finding.

## Staying youthful

Anti-staleness alone breeds calcification — a project that only audits itself becomes all immune system. Counter-rules, enforced at the same cadence:

- **Prune process, not just content.** Each phase-boundary retro must name at least one rule, gate, or metric that would NOT be adopted if starting fresh today — then kill it or re-justify it in writing. Process that survives only by inertia is stale process.
- **Budget for divergence.** The design corpus's own history is the evidence: every settled pattern came from its single wild breadth phase; six later versions refined and never re-architected. So at phase boundaries, spend one cheap Variants-style pass on a deliberately different approach to something that already "works" — most will lose, and the one that wins pays for all of them.
- **Reopening is health, not failure.** The reopen affordance exists in the product and the process for the same reason: a system that never revisits accepted state isn't stable, it's rigid. Track reopens in the retro as a vitality metric — zero reopens over a long stretch is a warning sign, not a win.
- **New eyes on old code.** Rotate at least one gauntlet critic lens per phase (a fresh failure-class prompt, a different lineage pairing) so the critics don't converge on the same grooves as the builders.
