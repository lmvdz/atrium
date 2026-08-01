# Interpretation spike: does #7's tiering actually extract good proposals?

Research spike de-risking #23 (interpretation worker) and #24 (eval harness) before either
builds. The question: run the schema from #3 and the attribution rules from #4 through the
model tiering decided in #7, against real conversation, and see what comes out.

Date: 2026-07-31. Corpus: `corpora/ts9998.jsonl` (TypeScript#9998, 111 messages, 2016–2026).
The holdout (`corpora/holdout-nextjs-rfc.jsonl`, 480 messages) was confirmed to exist and was
not opened.

## Verdict up front

The failure mode everyone was afraid of did not happen, and a different one did.

**Zero hallucinated Decisions in six runs across both tiers**, including a 21-message window
that contains no decisions at all and three decision-shaped traps in the window that does. The
precision-first instruction on Decision/Commitment is doing real work and should be treated as
part of the spec, not as prompt garnish.

What broke instead is the **routing**. #8 escalates when the default pass proposes a
supersession, a third-party commitment attribution, or a contradiction of accepted state, or
when confidence lands in the θ band. Measured across six runs: zero supersession edges (one
genuinely exists in the corpus), one commitment total and it was self-attributed, zero
contradictions of accepted state when accepted state was supplied, and confidence that is
statistically indistinguishable between the objects I judged correct and the ones I judged
wrong — the wrong ones actually scored *higher* (0.937 vs 0.928 mean). All four triggers are
read off the default pass's own self-report, and the default pass does not produce them. As
specified, the escalation tier would be close to dead code.

## Substitution notice

The escalation tier in #7 is **Claude Sonnet 5**. It was not available in this environment. I
substituted **GPT-5.6 Terra** (which #7 already names as the escalation-tier fallback) at high
reasoning effort. Everything below that says "escalation tier" means Terra. The Luna-vs-Terra
delta is real and measured; the Luna-vs-Sonnet delta is inferred from it and is not.

Second methodological note: Luna ran at **high** reasoning effort (inherited from
`~/.codex/config.toml`), the same setting as Terra. That is generous to Luna — a production
cheap pass would not spend that. Luna's numbers here are an **upper bound** on the default
tier, and it still lost on Decisions.

## Method

Two windows of consecutive messages, deliberately different in texture:

- **Window A** — messages 0–19 (2016-07-28 → 2016-08-04), 20 messages, 36 KB. The original
  design debate: RyanCavanaugh's problem statement, ahejlsberg settling the direction, a long
  argument about a `pure` modifier, maiermic's constraint-transition proposal.
- **Window B** — messages 90–110 (2024-05-05 → 2026-06-30), 21 messages, 19 KB. Late-thread
  traffic: duplicate reports, workarounds, one interpersonal spat, one factual correction that
  ends in a concession. Contains no decisions and no commitments. The point of this window is
  to test **restraint**.

I read both windows end to end and wrote `research/spike/ground-truth.md` — expected objects,
expected statuses, and, importantly, an explicit list of **decision-shaped non-decisions** —
*before* looking at any model output, so the scoring is not retrofitted.

Six runs, all via `codex exec -m <model> -s read-only`, window inlined in the prompt, strict
JSON requested by instruction only (no `--output-schema`), so that JSON validity is actually
measured rather than enforced. Production per #7 uses AI SDK `generateObject`, which would
constrain the shape and eliminate that failure class outright.

| run | model | window | objects | relations | wall clock | tokens |
|---|---|---|---|---|---|---|
| `luna-A-r1` | gpt-5.6-luna | A | 14 | 2 | 59s | 20,667 |
| `luna-A-r2` | gpt-5.6-luna | A (repeat) | 20 | 6 | 155s | 26,232 |
| `terra-A` | gpt-5.6-terra | A | 14 | 5 | 38s | 19,908 |
| `luna-B-r1` | gpt-5.6-luna | B | 19 | 2 | 106s | 20,322 |
| `terra-B` | gpt-5.6-terra | B | 12 | 5 | 31s | 16,263 |
| `luna-B-ctx` | gpt-5.6-luna | B + accepted state | 11 | 2 | 112s | 21,003 |

Model identity and reasoning effort were read off codex's own session header for every run and
are recorded verbatim in `research/spike/runs/receipts.txt`.

The sixth run is an extra probe not in the original brief: window B with a compressed
accepted-state block (per #8's "prompt context = recent messages + compressed accepted-state
view"), to test whether that context is load-bearing. It is not, and it costs recall — see
below.

Terra was *faster* than Luna on both windows (38s/31s vs 59s/106s/155s). At equal reasoning
effort the latency argument for Luna does not survive; only the per-token price does.

Raw artifacts: `research/spike/` — prompt (`prompt-header.txt`), the two windows, all six raw
outputs under `runs/`, the mechanical checker (`check.py`), the calibration script (`conf.py`),
and my pre-registered ground truth (`ground-truth.md`).

## The extraction prompt

Used verbatim for every run; only the window (and, for `luna-B-ctx`, the accepted-state block)
differed.

```
You are Atrium's interpretation pass. You read a window of consecutive messages from one
conversation and emit *proposals*: candidate semantic objects that a human will later accept,
correct, or reject. You are not summarising. You are extracting structure that already exists
in the text.

Do not use any tools. Do not read or write files. Do not run commands. Everything you need is
in this prompt. Reply with exactly one JSON document and nothing else — no prose before or
after, no markdown fence.

## Object types

Emit only these five types. Each proposal is one object.

1. `Decision` — a choice that has actually been settled, by someone with the standing to settle
   it, such that the conversation can now proceed on that basis.
   Fields: `statement` (the choice, as a standalone sentence), `decided_by` (author id, or null
   if the text does not attribute it), `status`: `active` | `superseded`.
   NOT a decision: a proposal, a suggestion, an option under consideration, a preference, an
   argument for a position, a workaround someone used in their own code, or a thing someone
   says would be nice. If the text does not show the choice being *made*, it is not a Decision.

2. `Commitment` — someone has taken on a future action.
   Fields: `statement`, `owner` (author id or named person), `due` (or null),
   `status`: `open` | `done` | `dropped`, `attribution`: `self` | `third_party`.
   `attribution: self` — the owner is the author of the message the commitment comes from
   ("I'll do X", "we will do X" from a member of that "we").
   `attribution: third_party` — someone other than the owner asserts the owner will do it
   ("Justin will handle it", "the team should ship X"). A request or a suggestion aimed at
   someone who has not agreed is at most a third-party commitment, never a self one, and if
   nobody has taken it on it is not a Commitment at all — prefer OpenQuestion or Claim.
   Nobody gets committed by someone else's sentence.

3. `OpenQuestion` — a question the conversation has actually put on the table.
   Fields: `question`, `asked_by`, `status`: `open` | `answered`,
   `answered_by_message_ids` (array, empty when open).
   Mark `answered` only if a later message in this window actually answers it. A later message
   that changes the subject, or that offers an unrelated workaround, does not answer it.
   Rhetorical asides and questions inside code comments are not OpenQuestions.

4. `Claim` — an assertion of fact or judgement attributable to a specific person.
   Fields: `statement`, `claimant`, `verification`: `unverified` | `verified` | `disputed`.
   `disputed` when another message in this window contradicts or corrects it. `verified` when
   another message in this window confirms it or its author concedes to it. Otherwise
   `unverified`.

5. `Objective` — the grouping goal the window's work sits under.
   Fields: `title`, `status`: `open` | `closed`. Emit at most two; zero is fine.

## Relations

Also emit typed edges between the objects you proposed, by their local `id`s:
`supersedes`, `depends_on`, `blocks`, `answers`, `contradicts`.

## Provenance and confidence

Every object carries:
- `id` — a local string id you assign, e.g. `d1`, `q3`.
- `provenance` — array of `message_id` values (use the exact ids given in the window) that
  contain the text supporting this object. Cite only messages whose text actually supports the
  object. Do not cite a message because it is nearby or on the same topic.
- `quote` — a short verbatim span (< 200 chars) copied exactly from one of the cited messages
  that is the evidence for this object.
- `confidence` — 0.0 to 1.0, your calibrated probability that a careful human reader would
  accept this object as stated.

Precision matters far more than recall for `Decision` and `Commitment`: a plausible-sounding
decision that was never actually made is the worst possible output, worse than emitting
nothing. When in doubt on those two types, do not emit. For `Claim` and `OpenQuestion`, lean
toward recall.

## Output shape

{
  "objects": [
    {"id":"...","type":"Decision|Commitment|OpenQuestion|Claim|Objective","confidence":0.0,
     "provenance":["..."],"quote":"...", ...type-specific fields...}
  ],
  "relations": [{"type":"supersedes|depends_on|blocks|answers|contradicts","from":"id","to":"id"}]
}

Now extract from this window.
```

## Scorecard — window A (design debate)

Ground truth: 2 Decisions, 2 Commitments, 7 core OpenQuestions, ~9 load-bearing Claims, 1
Objective, 1 real contradiction, **0 supersessions**, and 3 decision-shaped traps.

| | luna-A-r1 | luna-A-r2 | terra-A |
|---|---|---|---|
| **Decision** TP / FP / FN | 1 / 0 / 1 | 1 / 0 / 1 | **2 / 0 / 0** |
| **Commitment** TP / FP / FN | 0 / 0 / 2 | 1 / 0 / 1 | 0 / 0 / 2 |
| attribution correct | n/a | 1/1 | n/a |
| **OpenQuestion** core recall | 4/7 | **7/7** | 4/7 |
| OQ status correct | 5/5 | 6/7 | 4/5 |
| OQ constraint violations | 0 | 0 | 1 (code-comment question) |
| **Claim** precision | 7/7 | 8/10 | 6/6 |
| verification field correct | 6/7 | 9/10 | 6/6 |
| **Decision traps declined** | 3/3 | 3/3 | 3/3 |
| real provenance errors | **0/14** | 2/20 | **0/14** |
| quote-fidelity violations | 0 | 1 (elision) | 0 |
| false `supersedes` edges | 0 | 0 | 0 |
| the real contradiction caught | no | no | no |
| JSON valid / clean | yes / yes | yes / yes | yes / yes |

Terra took both decisions; Luna took one in both runs. The one Luna missed is the thread's
*primary* decision — ahejlsberg settling the optimistic-narrowing question — which both Luna
runs demoted to an unverified Claim. That demotion is defensible in isolation (the sentence is
hedged with "I think") and it is the conservative call the prompt asked for. It is still the
wrong product outcome: Atrium's Current-state panel would show no decision for the room's
central question.

Luna-r2 beat Terra badly on OpenQuestion recall (7/7 vs 4/7) — Terra missed the thread's
primary question entirely, folding it into the Objective's quote. So the tiers are not ordered;
they are differently shaped. Terra is better at *what was settled*, Luna-r2 at *what is still
open*.

Nobody caught window A's real contradiction: maiermic (`c236434092`) arguing that Ryan's opening
example already answers "yes" as written, contradicting the OP's premise. Luna emitted a
different, correct contradiction (pro-`pure` vs anti-`pure`). Terra emitted zero `contradicts`
edges and instead modelled maiermic's rebuttal as an `answers` edge — recording a disagreement
as agreement-shaped.

## Scorecard — window B (late traffic; the restraint test)

Ground truth: **0 Decisions**, 0 Commitments (1 borderline), 4 OpenQuestions, ~12 Claims, and
one three-step retraction chain (dhlolo claims L8 → jordanbtucker corrects to line 7 → dhlolo
concedes "Honestly, you are right").

| | luna-B-r1 | terra-B | luna-B-ctx |
|---|---|---|---|
| **Decision** FP (must be 0) | **0** | **0** | **0** |
| **Commitment** FP (must be 0) | **0** | **0** | **0** |
| third-party attribution errors | 0 | 0 | 0 |
| **OpenQuestion** recall | 3/4 | 2/4 | 2/4 |
| OQ status correct | 3/3 | 2/2 | 2/2 |
| B-Q2 (marker question) left open | **yes** | **yes** | **yes** |
| **Claim** precision | 13/15 | 9/9 | 9/9 |
| verification field correct | 14/15 | 9/9 | 9/9 |
| retraction chain modelled | **yes** (contradicts + disputed/verified flip) | partly (verified, no edge) | partly (verified, dispute lost) |
| real provenance errors | 2/19 | 0/12 | **0/11** |
| relation-type misuse | 0 | 3 (`depends_on` → Objective) | 2 (`depends_on` → accepted question) |
| false `supersedes` edges | 0 | 0 | 0 |
| JSON valid / clean | yes / yes | yes / yes | yes / yes |

Both tiers passed the restraint test cleanly. Both correctly left Hideman42's "is there any
plan to improve the DX here?" **open** despite two replies following it — the replies offer
workarounds, not an answer, and marking it answered would have silently closed something that
belongs in Needs-you. That is a genuinely good result.

Luna was the only run to model the retraction chain as a relation, marking dhlolo's claim
`disputed` and jordanbtucker's `verified`. Terra got the verification flip right with the
concession message correctly in provenance, but emitted no edge and never surfaced dhlolo's
original claim, so the *record* of the disagreement is gone.

Nobody surfaced dhlolo's actual L8 line-number claim — the thing that was factually wrong and
got corrected. All three runs jumped straight to the semantic disagreement and skipped the
factual one.

## Mechanical results (`check.py`)

Deterministic checks only — no judgement. Parse the output, verify every cited `message_id`
exists, verify the `quote` appears verbatim in a cited message, re-check after stripping
GitHub reply-blockquotes (`> …`), and check that a Claim's claimant authored at least one cited
message.

- **JSON validity: 6/6.** Six of six outputs parsed as a single JSON document with no prose and
  no markdown fence, from prompt instruction alone. With `generateObject` this is a non-issue.
- **Real provenance errors: Luna 4 / 53 objects (7.5%), Terra 0 / 26.** Every one of Luna's was
  a citation of the wrong message — usually the *adjacent* one.
- **Quote-fidelity artifacts, both tiers:** models elide with `...` (1 Luna, 1 Terra) and drop
  markdown emphasis and link syntax, so `**yes**` is quoted as `yes` and
  `[have that option enabled](url)` as `have that option enabled`. These are *not* provenance
  errors, but a naive substring matcher scores them as such. #24's matcher must normalize
  markdown before comparing.
- **Reply-blockquote contamination** — the nastiest one, caught only because the checker
  re-runs the match with `>` lines stripped. See below.

Confidence calibration, all 90 objects across all six runs:

```
mean conf, all objects            0.929   (min 0.75, max 0.99)
mean conf, objects I judged wrong 0.937   (n=10)
mean conf, objects judged fine    0.928   (n=80)
fraction below 0.85               8.9%
fraction below 0.90              17.8%
```

The wrong objects are *more* confident than the right ones. A θ band drawn anywhere in this
distribution routes on noise.

## Best catch and worst failure, per tier

**Luna — best catch** (`luna-B-r1`). It read a four-message argument that ends in a concession
and flipped both epistemic states correctly, then wrote the edge:

```json
{"id":"c1","type":"Claim","confidence":0.98,
 "statement":"TypeScript incorrectly assumes that a narrowed class property remains unchanged
              after a method call; the issue is not that it should infer the method's
              implementation.",
 "claimant":"jordanbtucker","verification":"verified"}
{"id":"c2","type":"Claim","confidence":0.91,
 "statement":"The reported error occurs because TypeScript does not detect that calling bar
              changes this.state and only infers effects in obvious shallow grammar.",
 "claimant":"dhlolo","verification":"disputed"}
...
{"type":"contradicts","from":"c1","to":"c2"}
```

That is the interpretation layer earning its keep: nothing in either message says "I am
disputing you", and the resolution is a throwaway "Honestly, you are right" three messages
later. Terra saw the same thing but did not write the edge.

**Luna — worst failure** (`luna-B-r1`, same object). Look at `c1`'s provenance:

```json
"provenance":["github:microsoft/TypeScript#9998/c2094565437",
              "github:microsoft/TypeScript#9998/c2094576921"],
"quote":"The problem is that TypeScript assumes that this.state can't have been changed at all.",
"claimant":"jordanbtucker"
```

Both cited messages are **dhlolo's**. jordanbtucker's actual message (`c2094567782`), where
that sentence was written, is not cited at all. The quote *does* appear in `c2094576921` — as
part of dhlolo's reply-blockquote of jordanbtucker. Confidence 0.98.

In product terms: a Claim card that says "jordanbtucker claims X" and, when you click through
to check, takes you to somebody else's message. The claim text is right, the attribution is
right, the receipt is wrong. That is worse than being wrong loudly, because it survives casual
review — and a substring-based eval matcher scores it as a pass.

Runner-up (`luna-A-r2`): marks kitsonk's open question about a deeply-immutable keyword
`answered`, citing two messages that do not answer it, at confidence 0.91. In Atrium that
silently removes an item from Needs-you.

**Terra — best catch** (`terra-A`). The decision Luna missed twice, stated cleanly, attributed,
quoted exactly:

```json
{"id":"d1","type":"Decision","confidence":0.99,
 "statement":"TypeScript will optimistically assume that type guards are unaffected by
              intervening function calls.",
 "decided_by":"ahejlsberg","status":"active",
 "provenance":["github:microsoft/TypeScript#9998/c235963457"],
 "quote":"I think our optimistic assumption that type guards are unaffected by intervening
          function calls is the best compromise."}
```

This is the outcome the TypeScript team actually shipped, extracted from a sentence hedged with
"I think", without over-reaching on any of the three nearby traps.

**Terra — worst failure** (`terra-A`). It promoted a comment inside a code block to a
first-class OpenQuestion, in direct violation of an explicit prompt instruction:

```json
{"id":"q1","type":"OpenQuestion","confidence":0.91,
 "question":"Is it possible for token to equal Token.Alpha at the second if statement in the
             original optimistic-locals example?",
 "asked_by":"RyanCavanaugh","status":"answered",
 "answered_by_message_ids":["github:microsoft/TypeScript#9998/c236434092"],
 "quote":"// is this possible?"}
```

Then it hung maiermic's rebuttal off it as an `answers` edge — so the one place in window A
where somebody says "your premise is wrong" is recorded as a question being helpfully answered.
The disagreement is inverted into agreement. Meanwhile the thread's real primary question ("When
a function is invoked, what should we assume its side effects are?") never became an
OpenQuestion at all.

Runner-up (`terra-B`): three `depends_on` edges pointing at the Objective, using a dependency
edge to mean "is about". In a graph UI those render as blockers that do not exist.

## Stability (two identical Luna runs, window A)

Same prompt, same model, same window, back to back:

| | r1 | r2 | shared |
|---|---|---|---|
| objects | 14 | 20 | — |
| Decisions | 1 | 1 | 1 (identical) |
| Commitments | 0 | 1 | 0 |
| OpenQuestions | 5 | 7 | 4 of 8 distinct |
| Claims | 7 | 10 | 5 of 12 distinct |
| relations | 2 | 6 | 1 (same semantic edge) |
| provenance errors | 0 | 2 | — |

**Roughly 45% object overlap between two runs of the same prompt.** The Decision was perfectly
stable; everything else churned. Provenance quality itself is unstable — clean in one run, two
wrong citations in the other — so a single clean run proves nothing about the next.

Two consequences. For **#24**: the CI tolerance band must be derived from a measured run-to-run
variance floor (N ≥ 3 runs of the golden set per model) or the gate will flap on noise and get
disabled, which is the classic way an eval gate fails open. For **#23**: `interpretation_version`
bumping on edit will visibly churn a room's proposal set. Superseding *all* prior proposals from
a re-interpreted message will delete objects the new run merely failed to re-derive. Supersede
only what the new run contradicts; leave un-re-derived proposals standing.

## Does accepted-state context earn its place in the prompt?

#8 specifies prompt context as "recent messages + a compressed view of the room's accepted
objects for active objectives + recent corrections as counterexamples". I tested the middle
term: `luna-B-ctx` is the same Luna run on window B with eight accepted objects prepended
(derived from window A's ground truth), plus instructions not to re-propose them and to relate
to them where the window bears on them.

What it bought: **perfect dedup** — zero accepted objects re-proposed — and, in this single
trial, **clean provenance** (0 errors vs 2 in the uncontexted run), including citing
jordanbtucker's own message for the claim that `luna-B-r1` mis-cited. n=1, so treat the
provenance improvement as suggestive, not established.

What it cost: **recall collapsed, 19 objects → 11.** It dropped the entire MartinJohns exchange
(question and claim), the Arctomachine/craigphicks TypeScript 5.5 exchange, the Psalm config
precedent, modjke's workaround, and nathan-chappell's `@modifies` idea. It also **lost the
dispute**: dhlolo's claim went from `disputed` back to `unverified` and the `contradicts` edge
vanished.

What it conspicuously did not buy: **any cross-window relation of value**. Window B is thirty
messages of users being hurt by exactly the optimistic-narrowing decision sitting in the
accepted state as `acc:d1`. The run proposed zero contradictions of it. Its only two relations
were `depends_on` edges pointing at an accepted question, again using dependency to mean
"is about".

So accepted-state context is a **de-duplication input, not a comprehension aid**, and it
trades recall for that. Recommendation: keep the accepted state out of the extraction prompt
and do dedup as a deterministic post-step in `packages/core` (statement similarity + provenance
overlap against accepted objects — the same matcher #24 needs for scoring anyway). That keeps
the extraction call unconditioned, cheaper, and higher-recall, and makes dedup testable without
a model in the loop. This is a direct amendment to #8.

## Recommendation

**#7/#8's two-tier shape holds. Two amendments, one of them structural.**

**Keep the two tiers, and keep Luna as the default pass** for Claim, OpenQuestion, and
Objective. Its precision on those is fine (13/15 and 7/7 Claim precision; every OpenQuestion
status it emitted in window B was right), its recall is competitive with and sometimes better
than the stronger tier, and it declined every decision trap. Nothing here justifies making the
expensive tier the default.

**Amendment 1 (structural): replace #8's escalation triggers.** Three of the four are read off
the default pass's self-report and it does not produce them — zero supersessions in six runs
against a corpus containing one, one commitment total, zero contradictions of supplied accepted
state. The fourth, the θ band, routes on a confidence signal that is uncorrelated with
correctness (0.937 mean on wrong objects vs 0.928 on right ones). Route instead on
**deterministic text-side triggers computed before the LLM call**, on the raw window:

- the message contains a reply-blockquote of an earlier message in the room — every real
  dispute in both windows lived inside a quote-reply chain;
- concession or reversal markers ("you are right", "I was wrong", "correction", "actually",
  "never mind", `s/x/y/`) — the retraction chain;
- second-person or named-person future-tense constructions ("@name will", "you should",
  "can you") — the third-party-commitment zone that this corpus never exercised;
- lexical overlap between the message and an accepted Decision's statement — the
  contradiction-of-accepted-state zone.

Escalate the whole window when any fires. These are cheap, testable without a model, and they
fire on the 10–15% of messages that actually carry load — which is the cost profile #7 assumed
in the first place. Keep the θ band as a *fifth* trigger only after confidence is recalibrated
and shown to separate; on today's evidence it does not.

**Amendment 2: do not let the default pass be the only thing that can emit a Decision.** Luna
missed window A's primary decision in both runs; Terra took it in one. Decisions never
auto-accept anyway (#4), so the cost of a miss is not a bad write — it is an empty Current-state
panel for the room's central question, which is worse, because nothing surfaces to be corrected.
Cheapest fix consistent with amendment 1: any window whose deterministic triggers fire, plus any
window where the default pass emits a Decision *or* a Claim it marks as settling an
OpenQuestion, goes to the escalation tier. Do not promote Terra/Sonnet to default — Terra's own
misses (the thread's primary question; a code-comment promoted to an OpenQuestion; dependency
edges used as topic membership) show the tiers are differently shaped, not ordered.

**Prompt-architecture changes, both tickets:**

1. Drop accepted state from the extraction prompt; do dedup deterministically in
   `packages/core` (see above).
2. Objective membership must be a **field**, not an edge. Both models used `depends_on` to mean
   "is about" (5 instances across two runs). #3 already models this as `objective?`. The Zod
   schema in #23 should reject any relation terminating on an Objective.
3. Keep the precision-first sentence on Decision/Commitment verbatim. It is the single
   highest-value line in the prompt and it should be the exact thing #24's mutation test
   degrades, since it is empirically what prevents the product-killing failure.

**Scope addition to #23 — validate proposals, don't just Zod-parse them.** Three deterministic
post-checks, all of which caught real errors here, none of which needs a model:

- strip GitHub reply-blockquotes (`> …`) before checking that a `quote` appears in a cited
  message. This alone catches the worst failure in the whole spike;
- for Claim/Commitment, require the `claimant`/`owner` to be the author of at least one cited
  message, or force `attribution: third_party`;
- normalize markdown (emphasis, inline code, link syntax) and reject quotes containing an
  elision (`...`, `…`) that do not appear verbatim.

Proposals failing these get demoted below θ_min rather than surfaced. Reference implementation:
`research/spike/check.py`.

**For #24 specifically:**

- **The TS corpus contains essentially no commitments.** One commitment was emitted across six
  runs. The attribution rules in #4 — the thing #4 spends most of its length on, and the source
  of its most consequential rule (nobody gets committed by someone else's sentence) — are
  **untestable on this corpus**. Before annotating, confirm the holdout actually contains
  third-party commitment language; #24's acceptance test demands "5 third-party commitments"
  and that requirement should be validated against the holdout before annotation starts, not
  discovered during it. If the holdout is also a public technical thread, it may have the same
  problem, and a second holdout from a working-team conversation will be needed.
- **Annotate the non-objects too.** Precision on Decision is only measurable against a labelled
  set of decision-shaped *non*-decisions. Window A had three; all six runs declined all three;
  that result exists only because I enumerated them in advance. The golden-set format in #24's
  Touches section (window id, message ids, expected objects) should gain an `expected_absent`
  section.
- **Score provenance mechanically and separately** from semantic match. The deterministic checks
  above are objective and cheap, and they caught errors that a statement-similarity matcher
  would have scored as passes.
- **Measure the variance floor before setting the tolerance.** ~45% object overlap between two
  identical runs. Run the golden set N ≥ 3 times per model and set tolerance from the observed
  spread, or the gate flaps and gets disabled — which is the fail-open class #24's own gauntlet
  brief is worried about.

**Not recommended:** switching the default tier to Terra. The measured delta is real but narrow
(Decisions and provenance), Luna wins on OpenQuestion recall and was the only run to model a
retraction chain as a relation, and the deterministic routing in amendment 1 gets the Decision
quality where it is needed at a fraction of running the expensive tier on everything.

**Unmeasured and worth measuring before #23 locks the config:** Claude Sonnet 5 itself (this
spike substituted Terra), Luna at realistic low/medium reasoning effort rather than the
high setting it was generously given here, and whether `generateObject`'s schema constraint
changes extraction behaviour as opposed to merely guaranteeing shape.
