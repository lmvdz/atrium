# Room entities, authority, and typed addresses

**Status:** proposed — awaiting human review. This document authorizes no implementation.

**Date:** 2026-08-04

## Decision sought

Adopt the smallest room model that lets humans converse with identifiable agents without turning room membership, a mention, or a worker process into ambient authority. The first build slice is only durable typed references to existing humans, attachments, and semantic state. Agent participants remain a design boundary, not an implementation commitment.

## Evidence in the current tree

The design starts from these facts rather than from the desired taxonomy:

- An authenticated session identifies only a human `userId`. Human access is derived from workspace and room membership and is rechecked at command entry and append time.
- Core's trusted actor is an out-of-band union of `human`, `model`, and `system`. It is written beside the event, not accepted from an event payload. `model` names a model string, not a durable participant; `system` has no identity.
- Any actor may stage a proposal. Core reserves decisions, commitments, objectives, corrections, verification, answer binding, and some supersession to humans.
- Contrary to the requested target invariant, a model can currently auto-accept a sufficiently confident claim or open question. This is deliberate and tested in `packages/core/src/authority.ts` and `policy.ts`, not a documentation accident.
- Messages store `mentionUserIds: uuid[]`. The server verifies uniqueness and current room membership, but the reference has no source span, authored label, target type, or attachment/semantic target.
- Attachments are message JSON `{key,name,contentType,size}` protected by a room-bound upload capability. They have no independent stable database identity.
- Proposals and accepted objects have stable UUIDs and room-scoped provenance. Composite foreign keys keep their sources in the same room.
- The composer can insert an attachment's display name after `@`, but that is text only. Rename-safe resolution and replay do not exist.

## Entity taxonomy

### Human member

An authenticated person with a stable user ID and current effective membership in a room. A human authors only their own speech. Membership permits entry to the conversation; it does not by itself grant administration, agent execution, or authority over another person's commitments and claims.

“Human-only” is a floor, not a complete authorization rule. The action must still name which human may perform it. Existing gaps around confirming another person's commitment or verifying another person's claim remain separate defects; this architecture does not bless them.

### Agent participant — future

A social room principal with a stable agent ID, an explicit room participation record, and an owner-visible set of grants. It authors messages and actions as itself. A human authorization receipt may explain why it acted but never changes the action's author to that human.

An agent cannot issue grants, delegate, recruit another agent, certify semantic state, correct accepted state, or change its own participation. It receives only allowlisted capabilities with a room, resource, action, issuer, validity interval, and revocation record.

### Room interpreter

A non-participant service that consumes an ordered room message window and stages readings. It has no chat identity, cannot be mentioned, cannot author conversation, and has no tools. There is one logical interpretation cursor per room, but processes may pool work for many rooms; “one worker process per room” is not an identity or consistency requirement.

Its output is system-presented, model-authored proposed state (`~`) with message, run, model, and stager provenance. The room continues normally if it is absent or fails.

### Room service

A non-social internal principal performing a narrow operation such as storage, projection, presence, replay, or indexing. It may emit system facts in system voice where required, but never a person's speech. Services are not mentionable participants and do not receive social authority from room membership.

A consequential future service action needs an identified service principal and an authorization receipt. Today's anonymous `system` actor is sufficient only for non-consequential internal bookkeeping.

### Addressable resource

An attachment, proposal, or accepted semantic object can be referenced but cannot act. Addressability does not make a resource a participant and does not confer access to it. A reference is valid only when the author is permitted to resolve the target in the same room.

## Capability and authority matrix

`Granted` means an explicit, current, room-scoped allowlist grant. `Policy` means a human identity plus the action-specific rule; membership alone is insufficient.

| Act | Human member | Agent participant | Interpreter | Room service |
|---|---|---|---|---|
| Read conversation | current membership | granted scope | bounded interpreter installation | operation's minimum scope |
| Author chat | as self | granted, as self | never | never; system facts only |
| Be mentioned | while addressable member | while active and mentionable | never | never |
| Mention a target | same-room visible target | granted chat plus same-room visible target | never | never |
| Stage a semantic proposal | current member | granted proposal type | yes, with run provenance | never |
| Certify `✓` | action-specific human policy | never | never in target architecture | never |
| Correct accepted state | action-specific human policy | never | never | never |
| Assign work | action-specific human policy | never in v1 | never | never |
| Execute a tool/action | explicit human invocation or policy | explicit action/resource grant | interpretation only | fixed service operation |
| Grant or delegate | authorized human grantor | never | never | never |

Mention, assignment, and execution are three different commands. `@agent` routes attention; it does not start a run. Assignment records requested responsibility; it still does not authorize a tool. Execution checks a current grant at the point of use and again at the durable consequence.

## Authority model

Four predicates must remain separate:

1. **Identity:** who is authenticated or which installed service is running.
2. **Participation:** whether that principal may enter, read, speak, or be addressed in this room.
3. **Action authority:** whether this principal may perform this semantic or administrative act.
4. **Resource grant:** whether it may use this tool or data resource with this operation and constraints.

Future grants are append-only facts with stable IDs: `subject`, `room`, allowlisted `action`, allowlisted `resource/scope`, `issuer`, `issuedAt`, optional `expiresAt`, and an optional later revocation referencing the grant. V1 grants are non-delegable. A replacement grant is a new record, never mutation of history. Receipts for consequential acts retain actor ID, grant ID, effective revision, inputs or safe input digest, outcome, and provenance.

Revocation changes future evaluation immediately. It does not delete old messages, old mentions, or the grant receipt that justified a past action. Authorization is rechecked after queue delay and inside the transaction that commits a consequence, following the repository's existing membership/append pattern.

## Typed address space

The conceptual address is a discriminated value, never a display name:

```ts
type RoomAddress =
  | { kind: 'human'; userId: UUID }
  | { kind: 'agent'; agentId: UUID } // reserved; not in the first slice
  | { kind: 'attachment'; attachmentId: UUID }
  | { kind: 'semantic'; subjectKind: 'proposal' | 'object'; subjectId: UUID };
```

Every message reference also stores its exact authored span:

```ts
type MessageReference = {
  id: UUID;
  roomId: UUID;
  messageId: UUID;
  ordinal: number;
  start: number; // UTF-16 offset, matching browser/JS string indexing
  end: number;
  surface: string; // must equal body.slice(start, end)
  target: RoomAddress;
};
```

The body remains the author's speech. Rendering uses the exact stored body span, not a reconstructed current display name. Resolution may show the target's current name and state in adjacent UI. Thus a rename changes resolution metadata, never historical speech. A deleted or departed target renders the original surface plus a tombstone; it is not silently retargeted.

The server validates all references atomically before appending the message:

- spans are ordered, non-overlapping, within the body, and match `surface` exactly;
- every target exists, is visible to the author, and belongs to the command's room;
- a human target is a current room member;
- an attachment is a durable room attachment the sender may read and, for a newly uploaded attachment, is bound to this message;
- a semantic target is a durable proposal or object in this room, including historical/retracted state that remains visible;
- duplicate references are allowed only when they identify distinct authored spans.

Any failure refuses the entire send and preserves the client draft. The external error is one generic “reference is unavailable” response for missing, unauthorized, and cross-room targets, preventing an existence oracle. The trusted room comes from the authenticated command context, never a client target field.

### Attention routing

- `@human` creates durable attention for that user only after the message commits.
- Future `@agent` creates an inbox signal for that agent only; it is neither an assignment nor execution authority.
- `@attachment` and `@semantic` create durable contextual links, not recipient attention.
- Leaving or revocation prevents new references and delivery. Historical references remain. Pending attention becomes inaccessible with room access; it is not rewritten as though it never existed.

Replay reads message body and reference rows from the same committed projection. It does not re-resolve by parsing `@display-name`, so rename, duplicate names, and changed membership cannot alter the historical target.

## Lifecycles

### Join

1. A human is admitted through existing workspace/room membership policy.
2. A future agent requires a stable agent principal and a human-issued room participation record; ownership elsewhere does not silently import it.
3. Joining grants no tools. Addressability and speaking are explicit participation properties.
4. Services and interpreters are installed, not joined as participants.

### Grant

1. An authorized human chooses an existing principal, room, allowlisted action/resource scope, and expiry.
2. The server derives the issuer from authentication, validates issuer authority, and appends the grant.
3. Consumers evaluate the grant by stable ID and current revocation/expiry state.
4. No agent-provided grant, wildcard action, or implicit transitive delegation is accepted.

### Mention

1. The composer selects a resolved address and inserts a visible authored token while retaining target ID and span.
2. Send validates body/span/target and current room access atomically.
3. The message and typed references commit together.
4. Projection creates recipient attention only for participant targets.
5. Realtime and replay render the authored token and resolve current metadata independently.

### Assign

1. An authorized human issues an explicit assignment to an active participant.
2. The assignment names objective/request, assignee, issuer, sources, and state.
3. Assignment creates attention and responsibility, not tool access.
4. Any execution separately proves a current applicable grant.

Assignment is future scope; typed mentions must not invent it by side effect.

### Revoke

1. An authorized human appends a revocation naming a grant or participation record.
2. New reads, sends, deliveries, queued executions, and durable consequences recheck and fail closed.
3. Active sockets or workers are evicted/cancelled where possible; append-time checks remain the boundary.
4. Historical events and receipts remain attributable and readable only to principals who still have room access.

### Leave

Human membership removal stops future room access and mentionability. Future agent participation removal also invalidates its room grants. Messages and receipts retain stable actor IDs and authored surfaces. A principal may not erase or rewrite other participants' historical state by leaving.

## Trust and adversarial invariants

- Actor identity is derived at a trusted seam and stored outside caller-controlled event payloads.
- Authorization never changes authorship. “Acting under a grant from Lars” remains authored by the agent.
- No machine actor may produce `✓` in the target architecture; every machine reading remains `~` until an authorized human act.
- A worker cannot acquire participant status merely by choosing an actor label or model name.
- A room ID and target ID supplied by the same adversary do not prove co-residency. Same-room checks are anchored in stored target rows.
- Database constraints or exhaustive triggers enforce every target kind; unknown kinds fail closed.
- Membership, mention, assignment, and capability grant never imply one another.
- Grant evaluation is allowlist-only, non-transitive, and repeated at durable consequence time.
- Revocation preserves historical truth while terminating future use and delivery.
- References never synthesize a person's words: the rendered surface is a validated slice of their stored message.
- Interpretation and agent failures cannot prevent ordinary message append, replay, or human semantic commands.
- Consequential acts retain actor, issuer/grant, room, sources, and outcome in inspectable receipts.

## Minimum persistence and protocol shape

### First slice

1. Give every upload a server-minted `attachmentId` bound by the signed upload capability to `roomId`, storage key, metadata, and expiry. Persist a normalized room attachment row when the message claims it; do not use the object key as public identity.
2. Add normalized `message_references` with stable reference ID, `(room_id,message_id)`, ordinal, UTF-16 span, exact surface, discriminant, and target fields.
3. Enforce `(room_id,message_id)` and target same-room integrity in SQL. Because polymorphic foreign keys do not exist, use an exhaustive trigger/function over an allowlisted discriminant, with conformance tests that refuse to boot or migrate if its guards are absent. Do not rely only on application queries.
4. Replace wire `mentionUserIds` with `references[]` in a versioned protocol transition. During migration, server-produced replay may translate old human mention arrays into legacy references with no spans; new sends must use typed references. Do not fabricate spans for old data.
5. Project typed references with messages and derive human attention from committed human reference rows.
6. Render exact body spans. Resolve current target metadata separately and show unavailable/tombstone state without changing speech.

The concrete schema may split target columns or use JSON only if the migration demonstrates equivalent exhaustive SQL-level type and room enforcement. An unconstrained generic `{kind,id}` JSON blob is rejected.

### Future agent slice

Add stable principals, room participation, grants/revocations, agent inbox attention, assignments, and action receipts only after the capability model and the machine-certification conflict are resolved. Do not extend today's `model` string into an agent identity.

## Current conflicts and missing concepts

1. **Machine certification conflict:** core currently allows model auto-acceptance for claims and open questions. The target invariant requires all nonhuman output to remain `~`. This needs an explicit semantic-policy migration and updated tests before agents exist; typed mentions must not alter it incidentally.
2. **Actor conflation:** `model` identifies inference provenance, not a social agent. There is no durable agent or identified service principal.
3. **No capability/grant model:** membership and core actor-kind gates are the only present authority layers; there are no execution resources, grants, assignments, or revocations.
4. **Incomplete human policy:** “human-only” does not decide which human may bind another person's commitment or verification. Existing tracker findings remain open.
5. **Weak mention representation:** `mentionUserIds` lacks target type, exact span, order, and rename-safe authored surface.
6. **No attachment identity:** attachment storage keys and transient composer IDs are not durable room resource IDs.
7. **Historical identity weakness:** some projections may lose useful display identity when a user is deleted even though ledger actor provenance remains. Typed references require an explicit tombstone presentation.

## Decisions proposed

- Separate human, agent, interpreter, service, and resource; do not call all of them “workers.”
- Use one logical interpreter cursor per room, serviced by a pooled worker fleet.
- Keep agents self-authored under human-issued, non-delegable grants.
- Treat mention as durable reference plus optional attention, never as assignment or execution.
- Preserve exact authored surfaces and stable targets independently.
- Make every machine semantic result proposed `~`; record current auto-accept behavior as a required future policy migration.
- Build typed human/attachment/semantic references before agent identities.

## Unresolved before agent implementation

- Which humans may issue, narrow, and revoke agent participation and grants: room owner only, workspace administrators, or an explicit room policy?
- Which human may certify a third-party claim, commitment, or assignment? This must resolve current “any human” gaps rather than inherit them.
- Whether agent read scope can be less than full room history, and how redacted history is represented without giving a misleading completeness claim.
- Whether a future assignment can target a human as well as an agent and what acceptance by the assignee means.
- How identified service principals are provisioned and rotated.

These questions do not block the typed-reference slice because it creates neither agents nor execution.

## Rejected alternatives

- **One worker/agent per room:** process topology is not identity or authority and wastes isolation machinery. Use per-room cursors and explicit principals.
- **Human-owned agent acts as the human:** destroys authorship and makes revocation/provenance uninterpretable.
- **Membership implies tool permission:** turns a social admission into ambient execution authority.
- **`@name` parsed after send:** ambiguous under duplicate names, rename, deletion, and replay.
- **Mention starts the agent:** conflates attention, assignment, and execution and creates accidental spend.
- **Attachment storage key as public identity:** couples durable semantics to storage layout and lacks a relational room boundary.
- **Generic capability engine now:** the project has no execution surface yet. Explicit allowlisted records should be added only with the first real action.
- **Agent kind added to today's actor enum now:** without principals, grants, and lifecycle it would be a label that claims a boundary not enforced.

## Staged plan

1. **Typed references:** humans, attachments, proposals, and accepted objects; durable spans, same-room enforcement, attention, replay, and rename behavior.
2. **Machine-certification alignment:** decide and migrate model claim/open-question auto-acceptance so code and the chosen invariant agree.
3. **Human authority completion:** specify and enforce which human may certify third-party claims, commitments, assignments, and grant agents.
4. **Agent identity and participation:** principals, room participation, addressability, self-authored chat, and revocation; no tools.
5. **Explicit assignment:** durable requests/responsibility distinct from mentions and capabilities.
6. **First execution capability:** one narrow tool with allowlisted resource grants, append-time recheck, cancellation, and receipts. Generalize only after measuring the concrete shape.

Each slice has an observable boundary and can ship or be rejected independently. No later slice is smuggled into the typed-reference schema.
