# Buzz — a power-user's 24-hour critique, and what it means for Atrium

Provenance: a first-person post from a Buzz power-user (not Lars), shared 2026-08-12 as
design intel. Distinct from the read-only scout `BRIEF.md`/`buzz-failures.md`: this is
someone emotionally invested, running Buzz + Codex daily, maintaining a personal fork.
Treat the failures as observed-in-the-field and the wants as a spec for the "end-game
harness." This file is a **settled input** — tickets cite it rather than re-litigate it.

## The split he names (independently re-derives init.md's thesis)

> Buzz has more of the world and the structure. Codex has more of the execution and the
> reliability. The perfect harness is the fusion of both.

This is verbatim Atrium's positioning (`init.md`: independent core / minimal product /
**adapter-ready**; the `ConversationSource`/`ExecutionProvider` seams). His P.S. is the
load-bearing line:

> If Codex gave me better ways to organise projects, domains, agent teams and loops
> outside the chat task list, I'm not even sure I would need Buzz.

→ The **structured world + reliability is the differentiated value; execution can be an
adapter.** Direct validation of Atrium's `ExecutionProvider` bet. The trap is the mirror of
Buzz's: Buzz shipped surfaces without invariants (a half-baked world); Atrium could ship
invariants with too few surfaces (nothing to be reliable *about*). The win is **fewer,
load-bearing surfaces that never lie**, not Buzz feature parity.

## The reframe: his Buzz pain is missing INVARIANTS, not missing features

| Buzz failure (observed) | The invariant it lacks | Where Atrium already answers it |
|---|---|---|
| Agents wake each other, talk in circles, retry, duplicate, burn 5 providers' limits | An **orchestrator owns the loop**; a **budget/circuit-breaker** can stop it | The campaign methodology: subagents block-and-report-once (never poll each other), the orchestrator owns concurrency + caps it (`cores/2`), reap-on-completion, hard load/token ceilings. Buzz made every agent a peer with no loop-owner → thrash. |
| "Projects disappeared — created under an agent's identity, not mine"; duplicate agent identities | A machine has identity but **may draft, never own/certify** | **The covenant** (#96 identity + kind; the certify boundary #102). A machine creating a project under its own identity that vanishes from the human IS the covenant violated. |
| "Agents look online but aren't receiving messages" | **Presence honesty** (liveness ≠ a stale flag) | #14 presence is ephemeral, `seen_seq` is truth; the campaign rule "reconcile against actually-running agents." |
| "Don't just hear an agent claim it's fixed — show me the tests, the files, the result" | **Claim vs verification**, with evidence | The covenant applied to execution: a machine **drafts `~`**, the human **certifies `✓`** against the artifact; the **receipt jumps to the exact source**. Points at messages today, not a running test — see the visibility gap. |
| Workflows running but invisible; cleanup spraying "removed by moderators" notices | **The record never lies about its own state** | The gauntlet discipline the whole campaign is built on: a green thing that doesn't prove itself is the enemy (false-greens caught on #96/#98/#100/#102 and the destination itself). |

## The two genuine gaps (design intel → the tickets)

1. **Agent lifecycle as a first-class property.** His clearest want:
   > Persistent main agents that own domains, plus throwaway specialists that research /
   > implement / review / test and **disappear** — without every temporary worker becoming
   > another permanent character cluttering the system.

   This is EXACTLY the campaign's orchestration pattern (one persistent orchestrator holding
   context/judgment/ownership; dozens of ephemeral worktree-isolated builders/critics, reaped
   on completion). **Buzz's core modeling error: every agent is a permanent identity** — so
   cleanup means duplicate-identity hell and moderation-notice spam. Atrium treats
   participants as first-class (kinded, #99) but does NOT distinguish **persistent member**
   from **ephemeral worker**. Lifecycle should be a property of a participant, not an
   afterthought. → Decision ticket.

2. **The execution-visibility surface — the real greenfield nobody has, including us.**
   > See what's running, what's blocked, what's waiting on me, what's burning tokens, what
   > actually produced something. Manage the loops, graphs, dependencies and flows without
   > digging through chats or config.

   Even in the campaign just run, this view is reconstructed by hand from the tracker + task
   notifications — no single pane. It maps onto the three surfaces only partially (attention
   = "waiting on me," decisions-so-far = "current state") and only for **conversation**, not
   for **execution / tokens / the dependency graph**. His "loops, graphs, dependencies" is a
   surface Atrium has not drawn. → Decision ticket.

## What NOT to take from it

- Don't chase Buzz's feature breadth (forums/canvases/Pulse/mobile parity). His own complaint
  is that breadth-without-invariants is what makes Buzz half-baked and un-trustable.
- Don't wire a real model gateway into execution just to look "real" — the campaign's own
  destination proved the value is in Atrium's surfaces being trustworthy, not the model.
- Voice / ChatGPT-Live on top is his end-state, but it's a *presentation* layer over a
  trustworthy control plane — it is worthless over a plane that lies. Invariants first.
