# Verdict

**Building Atrium as a standalone greenfield product—with no Coven or QM integration in the first version—is the wiser path.**

But “from scratch” needs a strict boundary:

> **Build Atrium’s differentiated product model from scratch. Reuse commodity infrastructure. Do not build an autonomous-agent runtime until the product proves it needs one.**

So:

```text
Greenfield Atrium Core                 Yes
Greenfield Atrium UI/UX                Yes
Native minimal multiplayer chat        Yes
No Coven/QM dependency at launch       Yes

Custom authentication system           No
Custom database                         No
Custom realtime protocol                No
Custom job queue                        No
Custom model abstraction                No
Custom PTY/sandbox/agent harness        No
Full Slack feature parity               Definitely no
```

The best strategy is not “integrate first” and not “invent everything.”

It is:

> **Independent core, minimal standalone product, adapter-ready architecture.**

# Why independence is currently valuable

Neither Coven nor QM is mature enough that Atrium should make one of them foundational.

Coven explicitly describes itself as an **early MVP** with expected rough edges. Its architectural boundary is nevertheless useful: it presents itself as a neutral local execution runtime with a versioned socket API intended for external clients. That means Atrium can remain independent now and add Coven later without reorganizing its entire domain model. 

QM is even less appropriate as a foundational hosted backend today. Its security documentation calls it early experimental software and explicitly says that it is not a hardened public or multi-tenant service boundary. 

That does **not** mean either project is bad. It means:

* their product models may change;
* their APIs may change;
* their priorities are not controlled by you;
* they solve adjacent problems rather than Atrium’s central UX problem;
* depending on them would introduce organizational and technical coupling before you have validated Atrium.

Starting independently lets you determine Atrium’s correct model without inheriting:

```text
Coven:
session-first, local coding-agent execution

QM:
scope-first, agent-powered organizational chat

Atrium:
understanding-first, stateful multiplayer conversation
```

# What Atrium should actually build from scratch

These are the pieces that constitute the product and should remain entirely yours.

## 1. The semantic collaboration model

Atrium needs first-class concepts for:

```text
Conversation
Objective
Branch
Decision
Commitment
Open question
Claim
Evidence
Responsibility
Dependency
Blocker
Supersession
Attention requirement
```

This is the main architectural innovation.

Neither the message transcript nor an external agent session should be canonical. The canonical model is the group’s evolving shared understanding.

## 2. The conversation-to-state engine

Atrium must determine how a message affects shared state:

```text
“That sounds good.”
    ↓
Was something actually approved?

“I’ll finish it tomorrow.”
    ↓
Was a commitment made?
Who owns it?
What does “tomorrow” mean?

“Actually, we cannot support legacy tokens.”
    ↓
Does this supersede an earlier decision?
Which branches are now affected?
```

This includes:

* typed semantic proposals;
* confidence;
* provenance;
* acceptance rules;
* human correction;
* supersession;
* deterministic state reduction.

That engine should not live inside Coven, QM, a model provider, or a general orchestration framework.

## 3. The new information architecture

The differentiated interface consists of three synchronized surfaces:

```text
Conversation
What people and agents are saying

Current state
What the group now understands and is committed to

Attention
What specifically requires this person
```

The process tree or semantic map is a projection of that state, not the whole product.

## 4. The compression model

Atrium must decide what is:

* raw activity;
* meaningful change;
* shared organizational state;
* relevant to the current user.

The fundamental transformation is:

```text
Hundreds of messages and machine events
              ↓
A handful of meaningful state changes
              ↓
Perhaps one item requiring human attention
```

That is arguably Atrium’s strongest source of product defensibility.

## 5. Trust and correction

Users must be able to say:

> “That was only a suggestion, not a decision.”

or:

> “Justin did not commit to that; he was only estimating.”

Atrium must then:

* reverse or amend the derived state;
* preserve the correction;
* retain the original source;
* avoid repeatedly making the same interpretation error.

Without this, Atrium becomes an unreliable AI summary layer rather than a trusted collaborative environment.

# What not to build from scratch

## Authentication

Use an established authentication system or library. Do not spend months implementing:

* password reset;
* OAuth;
* sessions;
* email verification;
* invitations;
* organization membership;
* multifactor authentication.

Atrium’s value does not depend on novel authentication.

## Realtime transport

Use ordinary WebSockets and server-authoritative state.

You do not need to invent:

* a synchronization protocol;
* a peer-to-peer network;
* a custom CRDT;
* a distributed event bus.

Messages can be append-only. Semantic state can be updated through server commands.

## Persistence

Use PostgreSQL.

Do not build:

* a custom event database;
* a graph database;
* an embedding-native database;
* a distributed ledger.

Postgres can initially hold:

```text
messages
semantic proposals
accepted semantic objects
relations
provenance
workspace events
attention projections
users and memberships
```

## Infrastructure orchestration

Start with one application server, one worker process, one database, and object storage.

Avoid:

* microservices;
* Kubernetes;
* Kafka;
* NATS;
* Temporal;
* Redis;
* a dedicated vector database.

Those technologies may become justified later, but none are required to test whether Atrium solves the chat problem.

## Agent execution

Do not initially build:

* PTY supervision;
* harness adapters;
* shell command policies;
* Git worktree management;
* credential injection;
* process isolation;
* sandboxing;
* local agent persistence;
* remote fleet scheduling.

Those are difficult security and systems-engineering problems. Coven and QM demonstrate how large that surface becomes: Coven’s daemon alone handles project boundaries, PTY execution, session persistence, event logging, harness routing, and authority enforcement.  QM’s security model documents numerous boundaries involving credentials, sandboxes, browser activity, egress, external content, model providers, connectors, and administrative access. 

Building all of that before validating the Atrium interface would be a major strategic mistake.

# A standalone Atrium does need native chat

There is one apparent contradiction:

> If Atrium is solving chat, shouldn’t you avoid rebuilding chat?

You should avoid rebuilding **Slack**. You still need to build the smallest conversation environment capable of proving Atrium.

The first version needs:

```text
Workspaces
Rooms or objectives
Human participants
Messages
Composer
Replies or contextual responses
Attachments
Presence
Semantic branch association
Current-state view
Needs-you view
```

It does not need:

```text
Hundreds of integrations
Voice calls
Video calls
Emoji ecosystem
Custom bots
Enterprise retention controls
Complex channel administration
Canvas documents
Workflow marketplace
Email bridge
Full mobile applications
Slack-compatible everything
```

The native chat exists so you can control the information architecture. It should not become a years-long Slack replacement project.

# Start with humans, not autonomous agents

The first Atrium validation should work with:

```text
Five humans
Several simultaneous subjects
A few hundred messages
No Coven
No QM
No autonomous coding agents
```

The test is:

> After being absent for several hours, can a participant understand the current situation, important changes, unresolved questions, and their responsibilities substantially faster than in Slack?

If the answer is no, adding agents will not rescue the product. It will only generate more volume.

If the answer is yes, agents become an accelerant:

* they maintain state;
* detect contradictions;
* propose branch structures;
* execute commitments;
* retrieve evidence;
* monitor deadlines;
* compress machine activity.

This keeps the product thesis properly ordered:

```text
1. Human comprehension
2. Multiplayer conversation
3. Shared continuity
4. Attention routing
5. Agent participation
6. Autonomous execution
```

# The recommended greenfield architecture

```text
┌───────────────────────────────┐
│         Atrium Web            │
│                               │
│ Conversation                  │
│ Current state                 │
│ Needs you                     │
│ Semantic/process map          │
└───────────────┬───────────────┘
                │ HTTP + WebSocket
┌───────────────▼───────────────┐
│        Atrium Server          │
│                               │
│ Messages                      │
│ Commands                      │
│ Authentication                │
│ Realtime events               │
│ Permissions                   │
└───────────────┬───────────────┘
                │
┌───────────────▼───────────────┐
│        Semantic Core          │
│                               │
│ Interpretation proposals      │
│ Validation                    │
│ Deterministic reducer         │
│ Provenance                    │
│ Corrections                   │
│ Attention computation         │
└───────────────┬───────────────┘
                │
┌───────────────▼───────────────┐
│          PostgreSQL           │
│                               │
│ Raw source events             │
│ Accepted state                │
│ Relationships                 │
│ Read projections              │
└───────────────────────────────┘
```

A practical initial stack:

```text
TypeScript
Node.js
React / Next.js
PostgreSQL
Drizzle
WebSockets
A PostgreSQL-backed job queue
Provider-neutral structured LLM calls
S3-compatible attachment storage
Playwright + Vitest
```

This is “from scratch” at the product layer, not at the infrastructure layer.

# Keep adapter seams without building integrations

No integration at launch does not mean hardcoding Atrium so integrations become impossible.

Define small internal ports:

```ts
export interface ConversationSource {
  ingest(input: {
    workspaceId: string;
    cursor?: string;
  }): Promise<{
    events: SourceEvent[];
    nextCursor?: string;
  }>;
}

export interface ExecutionProvider {
  start(request: ExecutionRequest): Promise<ExecutionHandle>;

  readEvents(
    handle: ExecutionHandle,
    cursor?: string
  ): Promise<ExecutionEventPage>;

  sendInput(
    handle: ExecutionHandle,
    message: string
  ): Promise<void>;

  cancel(handle: ExecutionHandle): Promise<void>;
}
```

The only initial implementations can be:

```text
NativeConversationSource
HumanExecutionProvider
```

Later:

```text
SlackConversationSource
QMConversationSource
CovenExecutionProvider
DirectClaudeCodeExecutionProvider
```

The important point is that adapters translate external systems into Atrium’s model. They never define that model.

Do not overbuild a grand plugin framework now. A few stable TypeScript interfaces and source-reference fields are enough.

# The best development sequence

## Phase 1: replay an existing conversation

Before building live multiplayer, take real historical chat data—possibly supplied as JSON, Markdown, or pasted text—and render:

* contextual conversation;
* current decisions;
* commitments;
* open questions;
* branches;
* blockers;
* what changed;
* needs-you items;
* source provenance;
* correction controls.

This isolates the hardest question:

> Can Atrium recover and present shared state better than a chronological log?

## Phase 2: add minimal native multiplayer

Implement:

* organization;
* workspace;
* participants;
* live messages;
* presence;
* attachments;
* ordered realtime updates;
* semantic analysis after each message.

Do not add agents yet.

## Phase 3: test long-running collaboration

Run a real project in Atrium.

Measure:

* time to reorient after absence;
* number of repeated questions;
* forgotten commitments;
* missed decisions;
* incorrect semantic interpretations;
* attention items judged useful;
* time spent manually organizing information.

## Phase 4: add one narrow agent

The first agent does not need repository access.

It can:

* propose state changes;
* answer questions using accepted state;
* identify contradictions;
* generate catch-up views;
* ask for clarification;
* maintain branches.

That tests agent participation without requiring an execution runtime.

## Phase 5: add execution only when demanded

Once users naturally make commitments such as:

> “Have an agent investigate this.”

then choose whether to:

* integrate Coven;
* integrate QM;
* invoke coding agents directly;
* build a narrow internal runner.

At that point you will know exactly what execution contract Atrium needs instead of designing one speculatively.

# Decision matrix

| Approach                                                 | Assessment                                     |
| -------------------------------------------------------- | ---------------------------------------------- |
| Fork QM and reshape it into Atrium                       | Too much inherited session/workspace semantics |
| Build inside Coven Cave                                  | Too much coding-agent and OpenCoven coupling   |
| Build every layer yourself, including agent execution    | Excessive scope and security risk              |
| **Build standalone Atrium Core and minimal native chat** | **Best path**                                  |
| Preserve optional Coven/QM adapters for later            | **Best optionality**                           |

# The strategic rule

Use this boundary:

> **Build anything that directly determines how conversation becomes shared understanding. Buy, reuse, or defer almost everything else.**

That means the wise version of “from scratch” is:

```text
Own:
- domain model
- semantic interpretation
- provenance
- correction model
- attention ranking
- conversation information architecture
- process/state visualization

Reuse:
- framework
- database
- authentication
- realtime transport
- storage
- queues
- model APIs
- observability

Defer:
- agent harness
- sandboxing
- coding-runtime orchestration
- external chat integrations
- enterprise features
```

# Final recommendation

**Do not integrate Coven or QM in Atrium v1.**

Build `lmvdz/atrium` as an independent, human-usable product. Validate that it turns a growing conversation into a coherent living state and materially reduces reorientation cost.

At the same time, do **not** declare that Atrium will never integrate with them. Coven’s external-client API may later save substantial execution work, while QM may later be useful as a conversation or organizational-agent source. Coven explicitly intends clients to interact through its versioned daemon contract, so preserving that future option is inexpensive. 

The correct position is:

> **No external runtime dependencies now. No unnecessary reinvention. No closed door to integrations later.**

Or more compactly:

> **Build Atrium from first principles, not from primitive infrastructure.**

