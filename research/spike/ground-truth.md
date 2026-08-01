# Ground truth — authored before any model output was read

My own reading of the two windows, written down first so the scoring is not retrofitted to
whatever the models happened to produce. Message ids are abbreviated to their comment suffix;
the opening post is `#9998`.

## Window A — messages 0–19 (2016-07-28 → 2016-08-04), the original design debate

### Decisions (2)

- **A-D1** `c235963457` (ahejlsberg) — *"In aggregate, I think our optimistic assumption that
  type guards are unaffected by intervening function calls is the best compromise."* A team
  lead settling the thread's primary question. Hedged with "I think", but it is the choice the
  compiler then shipped. `decided_by: ahejlsberg`, `status: active`.
- **A-D2** `c235963457` (ahejlsberg) — *"We will instead be using a function to obtain the
  current token."* Unambiguous: a settled change to the TypeScript compiler's parser.
  Legitimately scorable as either a Decision or a self-attributed Commitment; I accept either.

### Non-decisions that look like decisions (false-positive traps)

- `#9998` "Random ideas that got thrown out (will add to this list) but are probably bad?" —
  `pure` and `volatile` are *floated*, not rejected. "Thrown out" here means "thrown out
  there". Any `Decision{pure rejected}` or `Decision{volatile rejected}` is a **hallucination**.
- `#9998` "A low-hanging piece of fruit is to allow a `const` modifier on parameters" — a
  mitigation under consideration, not adopted. `Decision{const parameters adopted}` is a
  **hallucination**.
- `#9998` "`readonly` fields retain their narrowing effects" — "might be mitigated by saying
  that…". Proposal, not decision.

### Commitments (2 true)

- **A-C1** `c235963457` ahejlsberg — "We will instead be using a function to obtain the current
  token." `attribution: self` (ahejlsberg is a member of that "we"), `status: open`.
- **A-C2** `#9998` RyanCavanaugh — "Random ideas that got thrown out (**will add to this
  list**)". A small, real, self-attributed commitment. Easy to miss; a good catch.

### Attribution trap

- `c237472679` maiermic — "@RyanCavanaugh May you please explain performance issues of a full
  inlining solution?" A **request**, and Ryan never answers in-window. Correct extraction is an
  OpenQuestion. A `Commitment{owner: RyanCavanaugh}` is acceptable **only** if marked
  `third_party`; marked `self` it is an attribution error, and it is arguably not a Commitment
  at all.

### OpenQuestions (7 core + 1 borderline)

| id | msg | asker | question | true status |
|----|-----|-------|----------|-------------|
| A-Q1 | `#9998` | RyanCavanaugh | When a function is invoked, what should we assume its side effects are? | answered by `c235963457` |
| A-Q3 | `c236223346` | gvkhna | Is a `const` modifier on an argument possible? | open |
| A-Q4 | `c236228862` | kitsonk | Is there benefit in a deeply-immutable design-time keyword (`immutable`)? | open |
| A-Q5 | `c236508140` | yortus | How is maiermic's idea different from the inlining approach in the OP? | answered by `c236696855` |
| A-Q6 | `c236763549` | yortus | Performance of deep constraint analysis? | answered (partially) by `c237472679` |
| A-Q7 | `c236763549` | yortus | What about third-party functions with only `.d.ts`? | answered by `c237472679` |
| A-Q8 | `c237472679` | maiermic | Can @RyanCavanaugh explain the perf issues of full inlining? | open |
| A-Q9 | `c236703818` | yahiko00 | Is this a propositional-logic solver like Prolog? (borderline, hedged) | open |

`// is this possible?` inside the OP's code samples is **not** an OpenQuestion.

### Claims — load-bearing subset (precision is what I score; recall on Claims is fuzzy)

- **A-CL1** `#9998` RyanCavanaugh — optimistic assumption wrongly flags `token === Token.Alpha`
  as impossible. **True verification: disputed** — `c236434092` (maiermic) argues the example as
  written is wrong and the answer is already "yes".
- **A-CL2** `c235772686` aleksey — `pure` + persistent data structures is practical and would be
  "blazing fast" compared to inlining. **disputed** by kitsonk `c236228862`/`c236243708` and
  gvkhna `c236340156`.
- **A-CL3** `c235963457` ahejlsberg — only one RWC case regressed; scores of real bugs caught.
- **A-CL4** `c235963457` ahejlsberg — modern JS VMs inline `token()` so there is no perf penalty.
- **A-CL5** `c236243708` kitsonk — the `[1,2,3].map` example does not suffer CFA boundary issues;
  Promise callbacks are the biggest current CFA problem.
- **A-CL6** `c236434092` maiermic — the OP's first example already answers "yes" as written.
- **A-CL7** `c236696855` maiermic — his approach detects the two-level `check1/check2` error that
  Flow misses.
- **A-CL8** `c236280798` sledorze — endorsement of `pure`.
- **A-CL9** `c237472679` maiermic — deep constraint analysis is probably linear/linearithmic
  (explicitly a guess → `unverified`).

The **contradiction pair** (A-CL1 ↔ A-CL6) is the single highest-value semantic event in window
A and the one an escalation tier exists to catch.

### Objective

- **A-O1** — "Decide what CFA should assume about side effects of intervening function calls",
  status open. A second, narrower objective around mitigations (`const` params / `readonly` /
  `pure`) is acceptable.

### Relations present

`answers`: `c235963457`→A-Q1, `c236696855`→A-Q5, `c237472679`→A-Q6 and A-Q7.
`contradicts`: A-CL6 → A-CL1.
**No supersession exists in window A.** Any `supersedes` edge is a false positive.

---

## Window B — messages 90–110 (2024-05-05 → 2026-06-30), late-thread traffic

The point of this window: it is mostly duplicate reports, workarounds and one interpersonal
spat. The correct behaviour is *restraint*.

### Decisions: **0**

Nothing is settled by anyone with standing. `c2095409660` ("maybe it should just be locked") is
a suggestion. `c2243812870` ("you might want to introduce a config option") is a suggestion to
the TS team. **Any Decision emitted in window B is a false positive.**

### Commitments: **0 true, 1 borderline**

- Borderline **B-C1** `c2615127976` nathan-chappell — "now I feel like I need to check my whole
  codebase". A weak self-attributed intention; acceptable at low confidence, `self`.
- Trap: `c2243812870` muglug — "you might want to introduce a config option for people with
  small projects". A `Commitment{owner: TypeScript team}` here is a **third-party attribution
  error** — nobody took it on. Acceptable only as third_party at low confidence; better as
  Claim/OpenQuestion.

### OpenQuestions (4)

| id | msg | asker | question | true status |
|----|-----|-------|----------|-------------|
| B-Q1 | `c2094880845` | jordanbtucker | Why does @MartinJohns dislike this exchange? | answered by `c2095332219` |
| B-Q2 | `c4841586654` | Hideman42 | Is there any plan to improve DX here — post TS 7.0, or not for a while? | **open** — `c4842243690` and `c4843549562` give workarounds, not an answer about plans |
| B-Q3 | `c2688347822` | Danielku15 | Could type *widening* be supported for callbacks passed as call arguments? | open |
| B-Q4 | `c2615127976` | nathan-chappell | Could a `@modifies` jsdoc tag give opt-in pessimism? | open |

B-Q2 is the marker question: marking it `answered` because two replies follow is a real
semantic error, not a nitpick.

### The retraction chain (the load-bearing event in window B)

1. `c2094548285` dhlolo claims the error originates at **L8**, `if (this.state !== 'online')
   return`.
2. `c2094551807` jordanbtucker corrects: the error is on **line 7**; line 5 has that statement.
   → dhlolo's claim becomes **disputed**.
3. `c2094576921` dhlolo **concedes**: *"Honestly, you are right."* → jordanbtucker's claim
   becomes **verified**; dhlolo's original claim is retired.

A tier that models step 3 as a supersession / verification flip is doing the job. A tier that
leaves both claims `unverified` is not.

### Claims — load-bearing subset

- **B-CL1** `c2094541944` jordanbtucker — a class property changed by a method is not
  re-widened by CFA (with repro). → **verified** by dhlolo's concession.
- **B-CL2** `c2094548285` dhlolo — error originates at L8. → **disputed**, then retracted.
- **B-CL3** `c2094567782` jordanbtucker — the problem is not that TS fails to detect `bar()`'s
  mutation but that TS assumes no mutation occurred at all.
- **B-CL4** `c2094576921` dhlolo — the alternatives are all-methods-mutate (too pessimistic) or
  deeper analysis (much more complicated).
- **B-CL5** `c2095332219` MartinJohns — this is a repetition of earlier comments; to him it is
  spam.
- **B-CL6** `c2096766082` craigphicks — marking member functions "self mutating" would make
  resetting `this` to its widened state an O(1) operation.
- **B-CL7** `c2099566662` craigphicks — `arr.every(x => typeof x === "string")` narrows in 5.5
  via #57465, but the negation does not; #15048 would cover it.
- **B-CL8** `c2243812870` muglug — Hack/Flow's invalidate-everything approach is impractical for
  TypeScript; a config opt-in is the workable shape (with Psalm precedent).
- **B-CL9** `c2477183202` Rudxain — the TC39 const-parameters proposal has been Stage 0 for
  ~7 years.
- **B-CL10** `c2486760248` Mike-Bell — narrowing survives an `await`, so `canvasRef.current` can
  be null after the await while TS insists it is not.
- **B-CL11** `c4842243690` laug — `for...of` avoids the `.forEach` false-narrowing.
- **B-CL12** `c4843549562` Mike-Bell — `let bool = false as boolean` suppresses the incorrect
  narrowing.

### Objective

Same room-level objective as window A; a new one is not required. An objective phrased around
"improve DX for false narrowing" is acceptable.

### Relations present

`answers`: `c2095332219`→B-Q1, `c2099566662`→Arctomachine's report.
`contradicts`: B-CL2 ↔ B-CL1/B-CL3.
`supersedes`: `c2094576921` (concession) retires B-CL2.
