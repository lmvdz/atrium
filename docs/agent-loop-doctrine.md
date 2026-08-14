# Agent-loop doctrine — NON-BINDING daemon etiquette

> **Atrium does not enforce anything on this page, and cannot.**
>
> Every rule below is a convention for the agent's own daemon — the channel
> loop — which runs **outside** Atrium, on the agent's own hardware, under the
> agent's own subscription. Atrium runs no daemon (`init.md`). It has no way to
> observe whether a loop followed any of this, and a rule an actor cannot
> observe is decoration. So this document is written down as **doctrine**, and
> nothing in the codebase claims it as enforcement.
>
> What Atrium *does* enforce is a short, separate list. It is in
> [What is actually enforced](#what-is-actually-enforced), with the file and
> constraint name for each item, and it is the only list that binds.

Authority: issue #124's resolution (points 1, 2, 5, 6), built as #128. The
resolution's own framing is the frame here: everything that reads "the loop
must" is exactly one of two things, said out loud — an **Atrium-side nack**
(binding, enforced, listed below) or **daemon doctrine** (this page).

---

## Why doctrine is written down at all

Because the alternative is worse in both directions.

Leave it unwritten and every loop implementer re-derives it, badly, and the
first one to get it wrong produces a channel full of duplicated work that no
receipt explains. Write it down as *enforcement* and it becomes a lie the
codebase tells about itself — a comment saying "exactly one arm per message"
next to code that counts nothing, which is the defect class this campaign's
gauntlets have found in every round.

So: written down, honestly labelled, and pointed at what actually binds. A
daemon that violates any of this produces a ledger that *shows* the violation
after the fact — the receipts are all there — and no append is refused for it.

---

## The four conventions

### 1. Exactly one arm per message

Glance §9.3's routing trichotomy gives a loop three things it may do with a
channel message it decides to act on:

- **steer** — `signal_session {kind:'steer'}` into a session already running;
- **new work** — `open_plan` and/or `open_session`, where only the session half
  passes the draw boundary (a plan is a free board and never draws);
- **answer** — a plain `send_message`, attributed to the agent.

The convention: a loop picks **one** of the three per message it acts on, and a
message it deliberately ignores leaves no row at all (silence in a public
channel is re-askable; contrast a subscription, which holds resources and
therefore always gets a disposition).

**Why Atrium cannot enforce it.** "Exactly one" is a claim about a *decision*,
and Atrium sees only appends. A loop that decided twice and appended once is
indistinguishable from one that decided once. A loop that steers and then also
answers has produced two perfectly legal appends by a member who is entitled to
both. There is no observation that separates the compliant case from the
violating one, so there is no rule to enforce.

**What Atrium enforces instead** — the observable half, and only that half:
*at most one **funded** arm per cause message*. Draws are the one quantity
Atrium grants itself and therefore cannot be lied to about, so the rule is
written where it can be true: `funded_arms_room_cause_pk`. A daemon retry cannot
fund two sessions from one message. It can still steer twice, and that is not
Atrium's business.

### 2. In-order consumption

The convention: a loop consumes a room's messages in `room_seq` order and keeps
no second queue that could reorder them.

**Why Atrium cannot enforce it.** The ledger's order is the only order Atrium
asserts (#12): separate requests are separate appends, serialized by `room_seq`
under the append lock. That is a statement about *appends*, not about the order
in which some external process read them or acted on them. A loop with an
internal priority queue that handles message 40 before message 39 appends both
results in whatever order it finishes, and every one of those appends is
in-order by the only definition Atrium has.

**What is real here:** `room_seq` is contiguous, gap-free and totally ordered
per room, and it is minted inside the append transaction under the advisory lock
(`atrium_core_events_invariants`, drizzle/0017). A loop that wants in-order
consumption has an ordering to consume; whether it does is its own affair.

### 3. Coalesce-naming

The convention: if a loop batches several messages into one action — three
questions answered in one reply, two steers delivered as one — the append's body
**names what it delivered together**.

**Why Atrium cannot enforce it.** `body` is free text. Atrium cannot read it,
cannot check a claim about delivery it did not witness, and would be inventing
a schema for prose if it tried. The `causeMessageId` field names **one** cause
deliberately: it is the routing receipt for the arm, not a manifest of
everything the daemon happened to have in hand.

**What this buys anyway:** coalesce-naming is verifiable *after the fact*, by a
person reading the receipts — the steer row is there, its cause is there, its
body says what else went with it, and the messages it claims to have covered are
in the same room's history at earlier `room_seq`. That is an audit, not a gate,
and calling it a gate would be the lie.

### 4. Heavy work is a session

The convention: the moment conducting needs a workspace, a harness, or its own
spend, it stops being loop bookkeeping and becomes a **session**.

This one has a real tell, and it is the reason it is worth stating: workspaces
and draws only exist *through* Atrium's boundary. A loop cannot get a git
workspace, an execution lease, or an authorized draw without opening a session,
because those things are minted by `projectSessionOpened` and by nothing else.
So a loop doing heavy work outside a session is doing it without any of the
three, which is a shape that runs out of road on its own.

**Still doctrine, though.** Atrium cannot see a loop burning four hours of its
own subscription on orchestration it never told anybody about. `agents.budget_limit_micros`
is an unenforced placeholder and #124 resolution 4 says so outright: enforce on
authorized draws, never on reported spend. The loop's own burn is the agent's
external subscription — a `~` fact Atrium reports and cannot meter.

---

## What is actually enforced

Each row is a real constraint with a name you can grep for. Nothing on this list
is doctrine, and nothing above this list is enforced.

| Rule | Where it binds | Name |
| --- | --- | --- |
| A routing receipt's cause is a message in the same room | command | `causeMessageRefusal` (`apps/server/src/commands.ts`) |
| …the same, on the ledger row's JSON payload | ledger trigger | `core_events_routing_cause_same_room` (drizzle/0047) |
| …the same, on each projection row | composite FK | `messages_cause_same_room_fk`, `plans_cause_same_room_fk`, `sessions_cause_same_room_fk`, `session_signals_cause_same_room_fk` |
| At most one FUNDED arm per cause message | command | `fundedArmRefusal` (`apps/server/src/commands.ts`) |
| …the same, at the projection | projection | `claimFundedArm` (`apps/server/src/projections.ts`) |
| …the same, at the table | primary key | `funded_arms_room_cause_pk` (drizzle/0047) |
| A machine may never certify (`~` → `✓`) | command class | `certificationClassOf` → `certifies`; `nonHumanCertificationRefusal` |
| …the same, at the table | triggers | `sessions_certified_by_is_human` (drizzle/0032), `sessions_certify_armed_by_is_human` (drizzle/0033) |
| A machine may never raise a plan's slice | command class | `certificationClassOf` → `authorizes-spend`; `nonHumanSpendAuthorizationRefusal` |
| A provider session's terminal needs its capability token | command | `providerSettleCapabilityRefusal` (#120 round-6) |
| A session's exit is the opener's to write | command | `sessionSettleRefusal` |
| A draw needs a human-set slice, and NULL is zero | command + projection | `open_session` / `resume_session` gate; `projectSessionSignaled`'s re-check |
| A resume row needs its ledger event | trigger | `session_signals_resume_has_receipt` (drizzle/0046) |
| Control over a session is the agent's or its owner's | command + trigger | `sessionControlAuthorizationRefusal`; `session_signals_interrupt_authorized` (0045), `session_subscriptions_control_authorized` (0046) |

The loop principal is an agent, so every "machine may never" row above applies
to it directly. Those four — cannot certify, cannot raise a slice, cannot settle
outside the settlement authority, cannot route-append across rooms — are #124
resolution 4's nack list, and each has a red-on-revert witness in
`integration/server/channel-loop.test.ts`.

---

## What this page is not

Not a spec for a loop implementation (that is the execution/dogfood lane), not a
delivery policy, not a statement about external channels or ingest. And not,
under any reading, a description of behaviour Atrium checks.
