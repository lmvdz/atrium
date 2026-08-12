# The agent as a first-class participant — what exists, and the minimal delta

**Date**: 2026-08-11
**Base**: `fix/live-v8-fidelity` @ `927ca7eda40d68baf0f2ef8e245db23619c0f3b5` ("docs: the gate is green at 4 workers")
**Branch**: `research/agent-participant` — read-only research, no product code touched
**Ticket**: [#91](https://github.com/lmvdz/atrium/issues/91) · **Map**: [#89](https://github.com/lmvdz/atrium/issues/89) priority 3
**Method**: static read of the tree at that sha. Four parallel read-only sweeps (auth/identity, ws server/attribution, web humanity assumptions, attention/policy), each returning `file:line`; every load-bearing claim re-read by hand against the file before it was written down here. **No suite was run, no server was started, no database was touched.** Where a conclusion is inferred rather than read, it says so.

---

## The one-paragraph answer

Atrium already models a non-human writer end to end — `Actor` has a `model` variant, the DB has an `actor_kind` column, the reducer has ten humanity gates, and the interpret worker writes model-attributed events through the same ledger seam the socket uses. What it has no concept of is a non-human **identity**. `Actor`'s `model` variant carries a model string and no `userId` (`packages/core/src/common.ts:277`), `users` is documented as "one row per human" (`packages/db/src/schema.ts:200-201`), and the single Actor construction on the command path is a hardcoded literal (`apps/server/src/commands.ts:459-461`). So an agent today can either *write as a model with no identity* or *hold a session and be stamped human*. It cannot be both a member and a machine. That asymmetry — not authentication, not the reducer, not the policy table — is the whole delta.

---

## 1. Identity and auth: can an agent hold a session on `/app/[workspace]/[room]` today?

**Yes, but only by being indistinguishable from a person.** There is no service principal, no bot account, no machine credential, and no flag on the user record.

### What the route requires

`apps/web/app/app/[workspace]/[room]/page.tsx` is the entire guard — there is no middleware (`apps/web/middleware.ts` does not exist; the design note is explicit at `apps/web/lib/session.ts:11-14`) and no `app/app/layout.tsx`.

| step | file:line | requirement |
|---|---|---|
| session | `apps/web/app/app/[workspace]/[room]/page.tsx:26` | `requireSession()` — Better Auth **cookie** only |
| verified | `apps/web/lib/session.ts:34` | `session?.emailVerified` must be true, else redirect `/check-email` (`:39`) |
| workspace | `page.tsx:28-29` | `loadWorkspace(slug, userId)` → inner join on `workspace_members` (`apps/web/lib/workspaces.ts:42-61`) |
| room | `page.tsx:31-32` | `loadRoom(...)` → inner join on `memberships` **and** `workspace_members` (`packages/auth/src/room-access.ts:190-210`) |

Four facts, all rows: a session cookie, `users.email_verified = true`, a `workspace_members` row, a `memberships` row.

### Better Auth carries nothing machine-shaped

- **One plugin**: `organization()` — `packages/auth/src/auth.ts:4`, `:375-388`. The caller-extension type forbids adding models (`auth.ts:55-59`); the web app appends only `nextCookies()` (`apps/web/lib/auth.ts:36`).
- **No apiKey / bearer / jwt / admin / anonymous plugin anywhere.** The only `better-auth/plugins` imports in the repo are the organization plugin (`packages/auth/src/auth.ts:4`, `packages/auth/src/org.ts:2`, `packages/db/test/auth-schema.test.ts:4`).
- **Providers**: email+password with `requireEmailVerification: true` (`auth.ts:295-310`), plus optional GitHub OAuth (`auth.ts:364-373`). That is the complete list.
- **The HTTP surface is allowlisted to three routes** — `/verify-email`, `/error`, `/callback/:id` (`packages/auth/src/mounted.ts:108-115`, enforced at `apps/web/app/api/auth/[...all]/route.ts:58-68`). `/sign-in/email` and `/sign-up/email` are deliberately *unreachable over HTTP* (`mounted.ts:25-27`); sign-in exists only as a Server Action (`apps/web/app/(auth)/actions.ts:175-210`). **There is no endpoint an agent could POST credentials to.**
- **Session shape**: `AtriumSession = { sessionId, userId, email, displayName, emailVerified, activeWorkspaceId }` — `packages/auth/src/session.ts:10-18`. No kind, no type, no principal discriminant.
- **`users`**: `id, email, display_name, avatar_url, email_verified, created_at, updated_at` — `packages/db/src/schema.ts:205-220`. **No `ALTER TABLE "users"` exists in any of the 17 migrations** (0000–0016); the shape has never changed. The docblock says "one row per human, not two" (`schema.ts:200-201`), and `packages/db/src/auth-schema.ts:11` repeats it.

### Non-interactive provisioning paths that already exist

This is what makes a scripted participant tractable (§4):

1. **Seed script** — `scripts/seed-replay.ts:136-164` inserts `users`, `workspaces`, `rooms`, `workspace_members` (`:159-161`) and `memberships` (`:162-164`) directly via Drizzle. Note it does **not** set `emailVerified`, which defaults false (`packages/db/src/schema.ts:215`).
2. **Direct-SQL e2e fixture** — `apps/web/e2e/room-access.spec.ts:76-107` inserts a user with `emailVerified: true` (`:90`) plus both membership rows (`:101-104`). Same shape at `apps/web/e2e/role-sync.spec.ts:69,344,437` and `integration/support/harness.ts:117`.
3. **The session-repointing helper — the closest thing to a scripted participant in the tree today** — `apps/web/e2e/replay.spec.ts:8-40`: sign up a throwaway user through the real UI, then in one transaction flip a seeded user's `email_verified` (`:29`), **repoint the live `auth_sessions` row at that seeded user id** (`:30-34`), and delete the throwaway (`:35`). The result is a real, verified, cookie-backed session belonging to an identity that never signed up. Nothing in the product can tell the difference.

**Verdict on (1)**: an agent can hold a real session today. It cannot hold a session that says it is an agent. Every command it then issues is stamped `kind: 'human'`.

---

## 2. The ws server: what a connection needs, and how writes are attributed

### The handshake

`apps/server/src/ws-server.ts`, in order:

| # | check | line | failure |
|---|---|---|---|
| 1 | path is `/ws` | `:480-484` | 404 |
| 2 | origin allowed (**before** session) | `:490-500` | 403 |
| 3 | `session.authenticateUpgrade(request)` | `:508` | throw swallowed to `null` (`:509-512`) |
| 4 | resolved session | `:513-516` | **401**, socket destroyed pre-handshake (`:449-454`) |
| 5 | belt-and-braces at `connection` | `:534` | close `1011 'no session'` |

The resolver is `createUpgradeAuthenticator` (`apps/server/src/ws-auth.ts:46`) → `createSessionResolver` (`:66`) → `getAtriumSession(auth, headers)` (`:75`) → `auth.api.getSession({ headers })` (`packages/auth/src/session.ts:32`). **The cookie is the only credential.** It refuses on lookup throw (`ws-auth.ts:83`), no session (`:86`), and `!emailVerified` (`:93`).

**No token query param, no bearer header, no API key.** The only header/query identity path in the tree is the *stub* authenticator at `apps/server/src/session.ts:134-146` (`x-atrium-user` / `?user=`), used solely by `apps/server/test/protocol.test.ts:293`; production wires the Better Auth one at `apps/server/src/index.ts:198`.

Membership is **not** checked at the handshake — it is per-command and per-subscribe (`ws-server.ts:714`, `:759`; design note at `:50-56`, "Identity at upgrade, membership at command"). Sockets do not outlive sessions: `revalidateSessions()` re-resolves from stored headers and closes `4401 'session revoked'` (`ws-server.ts:981-1009`).

### Attribution — the single line the whole question turns on

```ts
function actorOf(session: Session): Actor {
  return { kind: 'human', userId: session.userId };
}
```
— `apps/server/src/commands.ts:459-461`

No branch, no flag, nothing session-derived beyond `userId`. It is the sole actor source for every socket-originated append (`commands.ts:480, 566, 581, 619, 733, 858`), and the contract note beside it (`:463-472`) says so: core "cannot check that an actor came from an authenticated session… the guarantee is exactly as good as this one derivation". Proposals are force-attributed the same way — `proposer: { kind: 'human', userId: session.userId }` at `commands.ts:1089`, after the client-supplied `proposer` field was **removed** in r9 (`commands.ts:1038-1075`) because a member staged a model-attributed commitment naming a colleague.

**The wire carries no actor.** `ClientFrame` is a closed union of `hello | ping | subscribe | unsubscribe | since | ack_head | command` (`apps/server/src/protocol.ts:20-51`) — no `actor` field on any variant, and none on `Command`. `Actor` appears only *outbound*, as `LedgerEntry.actor` (`protocol.ts:79-80`). The ledger refuses an actor inside an event payload entirely (`apps/server/src/ledger.ts:93-98`).

### How the interpret worker — today's only non-human writer — authenticates

**It does not.** It never touches the WebSocket server, has no session, and holds no credential. It is an in-process pg-boss queue worker sharing the same `Ledger` instance the socket layer uses (`apps/server/src/index.ts:137-158`, note `ledger` at `:145` is the same object passed to `createCommandService` at `:169-173`). Queue `interpret-room` at `apps/server/src/queue.ts:68`, handler at `:218-226`.

Its Actor is built inline from the model id the provider returned, three times, all in `apps/server/src/jobs/interpret.ts`:

- `actor: { kind: 'model', model: result.model }` — `:416` (`proposal_recorded`)
- same — `:444` (`proposal_superseded`)
- same — `:473` (`object_accepted`)

All three call `ledger.append` **with no `authorize` callback** (contrast `commands.ts:482-485`, which always supplies one; the field is optional at `ledger.ts:338, 354` and invoked at `:969`). The file header states the intent at `interpret.ts:57-60`: "the same seam the socket layer uses, so the receipt window, the actor rules and the projections are the ones the rest of the system already has."

Its ceiling is the **reducer**, not authentication: `packages/core/src/reduce.ts:715, 724, 738, 811, 1043, 1696, 1764`.

### And the database already exempts non-humans from membership

`packages/db/drizzle/0004_trusted_actor_and_append_boundary.sql:230` guards the membership check with `IF p_actor_kind = 'human' THEN …`, with the note at `:252`: "A model or the system actor is not a room member and cannot be." Restated at `0009_the_guard_stops_claiming_an_author.sql:131-132`, re-homed onto the table trigger at `0008_invariants_on_the_table.sql:175-186`.

**That last sentence is the sharpest single obstacle in the tree**, and it is a *deliberate* one: the DB currently asserts as an invariant the exact thing the destination scenario needs to stop being true.

**Verdict on (2)**: over the socket, **no** — one identity source, one Actor construction, a literal `'human'`, and no protocol field. In-process, **yes, and it already happens**. Everything below the inbound socket — ledger, schema, `Actor` union, outbound protocol, reducer gates — already models a non-human writer. The only seam with no non-human path is the inbound session → Actor derivation, and the code anticipated this: `commands.ts:1067-1075` speaks of "the day #21's pipeline lands and this seam has a legitimate model-staging caller again".

---

## 3. Humanity assumptions — the enumeration

**Allowlist framing.** The compliant form is: *the participant record carries a kind, every renderer and every projection reads it, and the only place the kind changes an outcome is certify.* A violation is any site that hardcodes person-ness — in a type, a data source, a closed enum, a column, or a rendered word.

**Count: 87 violation sites across five layers.** The headline: **`packages/core` is almost entirely compliant and `apps/web` is almost entirely not.** The core asks "is this actor human?" ten times, explicitly, each with a named refusal. The web never asks, because its participant record has no field to ask about.

### 3a. Identity and schema — 5 sites (the root)

| # | site | assumption |
|---|---|---|
| V1 | `packages/core/src/common.ts:276-277` | **The root.** `{kind:'human', userId}` carries an id; `{kind:'model', model}` does not. A non-human can never appear in `attentionItems.userId`, `acceptedBy.userId`, or any attribution column. |
| V2 | `packages/db/src/schema.ts:200-220` | `users` is "one row per human"; `email` and `display_name` are NOT NULL. It is simultaneously the Better Auth user model. Every membership, attention and attribution FK lands here. |
| V3 | `packages/auth/src/session.ts:10-18` | `AtriumSession` has no principal kind, so nothing downstream of a session can branch. |
| V4 | `packages/db/src/schema.ts:109-114` | `message_reference_kind` is a **closed** enum `['human','attachment','proposal','object']`. Naming an agent needs a migration, not a data read. |
| V5 | `packages/db/drizzle/0004_…sql:230,252` | The membership trigger asserts a non-human "is not a room member and cannot be". |

### 3b. Server attribution — 5 sites

| # | site | assumption |
|---|---|---|
| V6 | `apps/server/src/commands.ts:459-461` | `actorOf` returns a hardcoded `kind:'human'`. **The single highest-leverage line in the tree.** |
| V7 | `apps/server/src/commands.ts:1089` | Proposals staged over the socket are force-attributed human. |
| V8 | `apps/server/src/projections.ts:107-109, 119` | `humanId(actor)` returns NULL for non-humans, and `projectMessagePosted` writes it as `authorId`. **An agent's message would land with `author_id = NULL` and render unattributed.** |
| V9 | `apps/server/src/commands.ts:554, 653` | `message_posted` is produced **only** from the command path — the interpret worker never emits one (`grep message_posted apps/server/src/jobs/interpret.ts` is empty). Nothing non-human can speak in the conversation today. |
| V10 | `packages/db/src/schema.ts:921` | `messages.author_id` → `users.id`. Speaking requires a `users` row. |

### 3c. Attention — 3 sites

`apps/server/src/attention-projection.ts` contains **no `isHuman`, no `kind` discrimination, and no actor at all.** It deals in bare `userId` strings.

| # | site | assumption |
|---|---|---|
| V11 | `attention-projection.ts:24, 43, 90, 94` | The roster is `roomMemberIds` → `memberships.userId` → `users`. The only filter on a mention target is *room membership* (`:94`), never humanity. Addressability is defined as "has a `users` row". |
| V12 | `attention-projection.ts:93` | **HANDOFF.md's claim, verified verbatim**: `const targets = [...new Set(message.mentionUserIds ?? [])]`. |
| V13 | `apps/server/src/projections.ts:141-155` | The *live* mention path gates on `reference.kind === 'human'` — a lexical reference category, not a check on the target's nature. It writes `reference.targetId` straight into `attentionItems.userId`. |

**The register split, confirmed exactly as HANDOFF.md:224 states it.** `attention-projection.ts:93` computes from `message.mentionUserIds`; the client never fills that column. Four independent proofs: the sole non-test `sendMessage(` call site passes `attachments, replyToId, references, semantic` and not `mentionUserIds` (`apps/web/app/app/[workspace]/[room]/LiveRoomSession.tsx:438-443`); `apps/web/src/lib/realtime.ts:1539,1549` default it empty; no `.tsx` under `apps/web/src` references it at all; and `apps/web/e2e/multiplayer.spec.ts:836-841` names this exact line in prose. `mentionSignals` fires only in `apps/server/test/attention-projection.test.ts:67` and `integration/db/typed-references.test.ts:271`, which set the field by hand. **The path is dead for real traffic.** This is map #89's priority-2 item and it is real.

**Inferred, not read**: nothing in `attention-projection.ts` would *block* a non-human. Given a `users` row and a `memberships` row it would pass `roomMemberIds`, pass the `members.has()` filter and get an attention row. The blocker is upstream (V1, V2), not a guard in this file.

### 3d. Core policy and authority — 4 implicit sites, and a correction

**`DEFAULT_ACCEPTANCE_RULES` does not assume the participant is a person, and the ticket's framing of it is wrong.** Verbatim, `packages/core/src/policy.ts:126-133`:

```ts
export const DEFAULT_ACCEPTANCE_RULES: Readonly<Record<AcceptedObjectType, AcceptanceRule>> =
  Object.freeze({
    decision:      Object.freeze({ thetaAuto: 0.7,  thetaMin: 0.5, autoAccept: false }),
    commitment:    Object.freeze({ thetaAuto: 0.75, thetaMin: 0.5, autoAccept: false }),
    open_question: Object.freeze({ thetaAuto: 0.6,  thetaMin: 0.4, autoAccept: true  }),
    claim:         Object.freeze({ thetaAuto: 0.7,  thetaMin: 0.5, autoAccept: true  }),
    objective:     Object.freeze({ thetaAuto: 0.75, thetaMin: 0.5, autoAccept: false }),
  });
```

It is keyed by **object type**. It contains no `Actor`, no `isHuman`, and `policy.ts` imports no actor type at all. `autoAccept: false` means "a machine may not"; the humanity requirement is applied by `authority.ts`/`reduce.ts` through the derived `MODEL_ACCEPTANCE_FLOOR` (`policy.ts:161-168`) and `autoAcceptable` (`:171-173`). **This is a compliant site — it is exactly the "reads the rule, branches on machine-ness" shape the map wants — and it needs no change for an agent participant.**

Consumers, exhaustive: `policy.ts:165, 172, 485, 494`; `escalation.ts:21` (imported) used only at `:1377` to **interpolate two θ numbers into a refusal string**, not as a decision input; tests in `packages/core/test/{guards,representation,acceptance}.test.ts`; `apps/web/e2e/multiplayer.spec.ts:2,709,731`.

The genuine implicit-humanity sites in core:

| # | site | assumption |
|---|---|---|
| V14 | `packages/core/src/policy.ts:315` | `const AGENT = (?:i\|we\|you\|he\|she\|they\|everyone\|…)` with the docblock "A human subject. Anything else is the world, and the world undertakes nothing." A lexical human-subject class on the acceptance path — an agent cannot be the subject of a commitment. |
| V15 | `packages/core/src/authority.ts:592` | `correctionAttributionRefusal`: `actor.kind !== 'human' \|\| userId !== actor.userId` — a non-human is **foreign to every name by construction**. |
| V16 | `packages/core/src/authority.ts:431` | `selfStagedReadingRefusal` returns null for non-humans: the "don't self-accept your own reading" gate applies only to people. |
| V17 | `packages/core/src/reduce.ts:724` | Verified-claim gate is `isHuman` **and nothing else** — any member can mark a claim verified. Known hole #68 (`docs/TRACKER.md:48`), adopted by map #89. Compliant on the humanity axis, under-specified on the authority axis. |

**The compliant core, for the record** — `isHuman` (`authority.ts:225-228`, "the one predicate every gate is built from") has exactly ten call sites, and every one of them is the right shape:

- gates with named refusals: `reduce.ts:715` (decision/commitment/objective minting, via `modelMintingGate` at `authority.ts:189-223`), `:724` (claim verification), `:738` (direct acceptance), `:1043` (corrections), `:1696` (answer relation), `:1764` (supersession)
- derivations, not gates: `reduce.ts:946` (`humanTouchedAt`), `:1635` (`~`→`✓` promotion), `epistemic.ts:36` and `:51` (confirmed vs unconfirmed)
- inline `actor.kind` branches in `authority.ts`: `:242`, `:298-299`, `:431`, `:592`, `:621`

**This is already "diverges only at certify."** The core does not need widening — it needs an `Actor` that can carry an agent's identity so those gates have something to refuse.

### 3e. `apps/web` — 70 sites

There is **no Actor or agent concept anywhere in `apps/web`.** The only participant type is `HumanSummary`, the only participant source is `users` via `roomMemberIds`, and the only reference kind that can name a participant is the literal `'human'`. The single acknowledgement in the entire product that a non-person can be in a room is a **hardcoded fake**: `apps/web/app/gallery/RoomFrame.tsx:695` appends a literal `<span>A</span>` avatar and `:698` renders `${humans.length + 1} on the call · atrium is the voice agent`.

**The root**: `HumanSummary { id, name, presence, note, isViewer }` — `apps/web/src/components/model/records.ts:89-95` — has no discriminant. Its two constructors, `apps/web/lib/replay-view.ts:399` and `apps/web/lib/live-room-view.ts:98`, both read exclusively from `users` via `packages/auth/src/room-access.ts:367`. **Sites V25–V70 below are all downstream of those three lines.**

**Identity strip (`.wsYou` / `.wsSpacer`) — 6 sites.** V18 `AppFrame.tsx:159-169` (`WorkspaceYouProps` is `{initials, title}`; no kind, no agent variant); V19 `gallery/RoomFrame.tsx:414-418` (the only caller — monogram from `initials(viewer.name)`, title `"<name> — you"`); V20 `frame.module.css:169-181` (fixed 26px `border-radius:50%` circle, no variant); V21 `frame.module.css:150-167` (the strip is documented as "what this workspace IS at the top … what YOU are at the foot"); V22 `src/components/model/text.ts:71-72` (`initials()` — the single monogram generator, knows only person names); V23 `app/layout.tsx:49` ("a viewer's initials").

> **Worth flagging against the ticket's wording.** The strip holds *only the viewer's own monogram*. It is not a roster and has no slot for a second participant of any kind. "Identity in the strip" as the map phrases it (#89 priority 3) is not a surface an agent can appear on today, because *no other participant* appears there today. The roster is the **Rail**, which ships folded (`.rail` hidden until `.appRailOpen`) — which is precisely why #93 exists.

**Presence and roster — 13 sites.** V24 `Rail.tsx:24` (`humans: readonly HumanSummary[]`); **V25 `Rail.tsx:65` — the section header literally renders `HUMANS`**; V26 `Rail.tsx:67-68` (`humans.map` → one `HumanRow`, no kind branch); V27 `Rail.tsx:151-181` (`HumanRow`: presence dot + name + note, no agent variant); V28 `Rail.tsx:10-11` + `frame.module.css:337` (presence colour grammar defined as "a green dot beside a **person's** name" / "presence uses BLUE (= human)"); V29 `frame.module.css:329` ("humans are a roster, not navigation"); V30 `records.ts:89-95` (**the root**); V31 `records.ts:87` (`Presence = 'here'|'idle'|'away'` — a human-attendance enum, no agent runstate); V32 `lib/live-room-view.ts:14-18` (`presenceFor` typed `HumanSummary['presence']`); V33 `lib/live-room-view.ts:98-102`; V34 `lib/replay-view.ts:399-405` (every participant coerced to a person, `presence:'away'` hardcoded); V35 `lib/replay-view.ts:406-413` (synthesised person fallback viewer); V36 `src/lib/realtime.ts:994, 1348-1350` (**the presence protocol is `Record<userId, state>` — non-user participants cannot be represented on the channel at all**).

**"N humans" copy — 7 sites.** **V37 `gallery/RoomFrame.tsx:396` — `${props.humans.length} ${… 'human' : 'humans'}`, the rail subtitle on every surface (gallery, live, replay): a participant count labelled "humans"**; V38 `RoomFrame.tsx:698` (`humans.length + 1 … atrium is the voice agent`); V39 `RoomFrame.tsx:695` (the literal `A` avatar, outside the participant loop); V40 `RoomFrame.tsx:564, 683-693` (`CallDock` — person-only avatars + presence); V41 `AppFrame.tsx:108` ("Hide/Show rooms and **people**"); V42 `Rail.tsx:48` (`aria-label="Rooms and people"`); V43 `SinceYouLeftDivider.tsx:41` ("people talking, nothing settled").

**Mention autocomplete — 12 sites.** **V44 `LiveRoomSession.tsx:276` — the data source: `...view.humans.map((human) => ({ kind: 'human' as const, id: human.id, label: human.name }))`. A non-user participant cannot appear as a mention target, full stop.** V45 the chain behind it (`lib/replay-view.ts:399` ← `lib/replay-data.ts:98` `roomMemberIds` ← `:112-118` `select from users`); V46 `src/lib/typed-references.ts:1` (`MessageReferenceKind` closed union — mirrors V4); V47 `Composer.tsx:428` (`target.kind === 'human' ? null : ▤` — person is the *unmarked default*, everything else gets a document glyph); V48 `Composer.tsx:436` ("No matching person, attachment, proposal, or object"); V49 `Composer.tsx:569, 592` ("Reference a person or room item"); V50 `Composer.tsx:580` ("choose a person"); V51 `lib/live-room-view.ts:74-80` (`if (kind === 'human') label = participantName.get(targetId)`; anything not in the human map gets `label: kind`); V52 `lib/replay-view.ts:226-227, 243-245`; V53 `lib/replay-data.ts:89-90, 161-167` (referenced targets re-fetched from `users` only); V54 `records.ts:133` (same closed union in the view model); V55 `lib/live-room-view.ts:81, 92-94` + `lib/replay-data.ts:71` (the legacy `mentionUserIds` path — V12's other end).

**Membership display — 12 sites.** V56 `records.ts:99-103` (`RoomHeadRecord.members: readonly string[]` — bare display-name strings, no id, no kind); V57 `RoomHead.tsx:40-49` (`initials(member)` chips); V58 `RoomHead.tsx:50` (`{members.length} here`); V59 `lib/replay-view.ts:414-417`; V60 `lib/workspaces.ts:89-96` (**`MemberSummary` requires `email` — structurally excludes a non-person member**); V61 `lib/workspaces.ts:98-111` (`listMembers` inner-joins `users`; a non-user row is dropped); V62 `app/app/[workspace]/page.tsx:106-108` (section heading `People`, `id="people"`); V63 `page.tsx:111-120` (rows print `displayName` + `email` unconditionally); V64 `page.tsx:129, 141` (management hooks keyed by `member.email`); V65 `lib/workspaces.ts:112-129` (**invitations are email-only — the only way to add a participant is to email a person**); V66 `gallery/fixtures.ts:279-292, 298` + `gallery/rooms.ts:291, 315, 337`; V67 `gallery/RoomFrame.tsx:172-173` (the shared frame's participant contract is person-typed, consumed at `LiveRoomSession.tsx:647`, `ReplaySession.tsx:366`, `gallery/page.tsx:34`, `gallery/pin/[n]/page.tsx:70`, `app/RoomSession.tsx:194`).

**Attribution in the feed — 8 sites.** V68 `src/components/model/quotation.ts:78-84` (`MessageRecord.actor: string` — a display-name string, no kind, so every feed row's attribution is unkinded); **V69 `TimelineRow.tsx:300-307` — the actor cell's truncation contract is `data-truncates={element:[data-roster-name="${attribution.actor}"]}`, asserting every actor's full name exists in the HUMANS rail roster (`Rail.tsx:176`). A message authored by a non-roster participant breaks this invariant.** V70 `records.ts:412` (`fromViewer` decided by string-comparing display names); V71 `lib/live-room-view.ts:54, 83`; V72 `records.ts:541` + `RoutineCollapse.tsx:30,59,84`; V73 `lib/replay-data.ts:66` (author name via `leftJoin(users)` — pairs with V8: a non-user author renders with no actor); V74 `glyph.ts:186` + `records.ts:764` ("needs you — a reversible gate waiting on a **human**"), `lib/replay-view.ts:869` ("a person must file or decline it"), `glyph.ts:26,94`, `lib/replay-transitions.ts:45`; **V75 `quotation.ts:64-69` — quotation origins `typed`/`seeded` are both defined as "a human typed / a human's words". There is no origin for an agent's authored words, so an agent message must masquerade as human-typed to be quotable** — which collides directly with AGENTS.md's "No synthesized speech" rule and with the two-register typographic split (`primitives.module.css:42`, `lens.module.css:560`, `globals.css:186`).

**Account identity — 4 sites.** V76 `app/app/page.tsx:32` ("Signed in as {session.email}"); V77 `app/account-bar.tsx:10-27`; V78 `app/invite/[id]/page.tsx:58-60` ("sign in as that **person**"); V79 `lib/session.ts:10` ("Every page that shows anything belonging to a person").

**CSS with no data-driven agent variant — 8 sites.** V80 `frame.module.css:52`; V81 `:837` (`.face`); V82 `:784` (`.hereCount`); V83 `:655` `.callAvatar` vs `:666` `.atriumAvatar` (the agent variant exists **only** for the hardcoded avatar, not as a modifier); V84 `:395` `.hrowMe` (the only per-row modifier is "is me"; there is no `.hrowAgent`); V85–V87 the voice registers above.

### Already compliant in `apps/web` (the pattern to copy)

Every one of these branches on a **reference** kind, never a participant kind — the mechanism is right, the vocabulary is closed:

- `Composer.tsx:415-433` — the listbox emits `data-reference-kind` / `data-reference-target` from data and keys by `${kind}:${id}`. Only the candidate *source* (V44) and the `'human'`-as-default glyph rule (V47) are hardcoded.
- `RichMessageBody.tsx:279-289` — rendered mentions carry kind/target/legacy attributes and a resolution title read from the segment. **A new kind needs no change here.**
- `src/lib/typed-references.ts:13-18` — `ReferenceTarget { kind, id, label, detail? }`: the right shape, wrong closed union.
- `LiveRoomSession.tsx:277-298` — attachment/proposal/object candidates each derived from their own data with their own `detail`. **This is the slot an agent participant drops into.**
- `Rail.tsx:96-146` — `RoomRow` derives glyph, tone and tooltip from `room.owed.state` via `<Glyph>`. The same discipline applied to participants *is* the fix.
- `Rail.tsx:163, 168-172` — `human.isViewer` and `data-presence` are read from the record. The mechanism is data-driven; the record just has no kind to read.
- `lib/contextual-reference-attention.ts:25-61` — routes purely on kind discriminants.

---

## 4. The agent driver for the destination scenario

**Recommendation: a scripted participant harness. The interpret worker is disqualified, on a measured fact rather than a preference.**

### Why the interpret worker cannot be the driver

The destination scenario (#89) requires the agent to be *mentionable*, *present*, *attention-receiving*, *answering in the conversation*, and *drafting `~` readings*. The worker can do exactly one of those five.

| requirement | worker today | evidence |
|---|---|---|
| drafts `~` readings | **yes** | `interpret.ts:416, 444, 473` |
| answers in the conversation | **no — structurally impossible** | `message_posted` is emitted only from `commands.ts:554, 653`; `grep message_posted apps/server/src/jobs/interpret.ts` is empty. The worker has no path to author a message. |
| mentionable from the composer | **no** | candidates come from `view.humans` → `users` (V44) |
| present in the strip / roster | **no** | it has no `users` row, no `memberships` row, and presence is keyed by `userId` (V36) |
| receives attention | **no** | `attentionItems.userId` FKs `users`; a model Actor carries no `userId` (V1) |

Adding message-authoring to the worker would mean giving it a `users` row and a `memberships` row — at which point it *is* a participant, and the interesting question ("can a member be a machine?") has been answered by the same delta the harness needs anyway. The worker would then be a second, in-process, session-less write path for the very boundary the campaign must prove server-side, which is the worse place to test it.

### Why a scripted participant harness is the right driver

1. **It exercises the surface under test.** init.md's verdict — "Do not build an autonomous-agent runtime until the product proves it needs one" (`init.md:7`), "No autonomous coding agents" (`:319`), "That tests agent participation without requiring an execution runtime" (`:526`) — points exactly here. The scenario's claim is about Atrium's doors, not a model's judgement. A scripted agent posts *fixed* text at *fixed* points; nothing about the assertion depends on what a model would have said.
2. **The provisioning already exists and is proven.** `apps/web/e2e/replay.spec.ts:8-40` demonstrably mints a real, verified, cookie-backed session for an identity that never signed up. `room-access.spec.ts:76-107` inserts a fully provisioned member (`emailVerified: true` + both membership rows) in one transaction. Two agent principals are the same two transactions.
3. **The e2e runner can already drive the socket deterministically.** `apps/web/e2e/support/flows.ts:189-223` (`sendCommand`) and `:240-337` (`openLiveSocket` / `sendOnLiveSocket` / `liveSocketStatus`) open a WebSocket *from inside the page*, so the browser attaches the session cookie exactly as the app does, send an arbitrary protocol frame, and read the reply — including the close code and the unprompted presence frames. **This is precisely the instrument needed to prove "the API refuses it, not just that the UI hides it"**: send the certify command on the agent's own authenticated socket and assert the `ack`-with-non-empty-`issues` refusal (AGENTS.md:123) plus a zero-row fold.
4. **Determinism is already the house style.** The e2e environment pins `INTERPRET_PROVIDER=acceptance-deterministic` (`apps/web/e2e/support/config.mjs`), whose provider (`apps/server/src/jobs/acceptance-provider.ts:8-40`) understands five exact one-line fixture forms and returns *no readings* for everything else, refusing any other model id (`:22-25`) and refusing to boot if a gateway key is present (`apps/server/src/env.ts:411-428`). The scripted agent's drafted `~` readings can ride the same rails: the agent posts `Claim: …` / `Open question: …` and the existing deterministic provider stages them, with zero new machinery and zero model calls.
5. **The `~`-drafting half stays honest.** The scenario says the agent *drafts* onto the second surface. Under (4) those drafts are still minted by a genuine `{kind:'model'}` actor through the real worker — so the human-only gates in `reduce.ts` are still the thing under test, not a fixture. The agent's *conversation* half and its *drafting* half are attributed correctly and separately, which is the truthful model anyway.

### The shape

Two agent principals, each provisioned as a member with a non-human principal kind (Build ticket 1), each holding a real session. The runner drives their conversational turns as protocol frames on their own sockets — no model in the loop, fixed text, fixed order — while the existing deterministic interpret worker produces the `~` readings from that text. The two human participants are driven through the real UI exactly as `multiplayer.spec.ts` already drives five. Certify is attempted on an agent socket and must be refused by the server.

**Named limitation.** A scripted agent proves the *doors* are open and the *certify boundary* is closed. It proves nothing about whether an agent's contributions are useful — that is Phase 3/4's question (`init.md:513-526`), and the scenario should not be read as evidence for it.

---

## 5. The build tickets this graduates into

Six, in dependency order. The first is load-bearing for all of the rest.

1. **A principal kind on the identity, threaded into the Actor.** Add a non-human principal kind to `users` (or a sibling participant table) and to `AtriumSession`; widen `Actor` with an identified agent variant so a non-human carries a `userId`; branch `actorOf` (`commands.ts:459-461`) on it instead of returning a literal. Touches V1, V2, V3, V6, V7, and the DB membership trigger (V5). *Everything else is blocked on this.*

2. **The participant record gets a kind, and every renderer reads it.** `HumanSummary` → a kinded `ParticipantSummary` (`records.ts:89`) with both constructors (`replay-view.ts:399`, `live-room-view.ts:98`) and the member source (`room-access.ts:367`) carrying it through; roster section, presence indicator, monogram, member chips and counts branch on the field rather than on hardcoded copy. Retires V24–V43 and V56–V67 in one pass.

3. **An agent is a mention target and an attention target — one register, not two.** Extend the reference alphabet (V4/V46) to name a non-human participant, source composer candidates from the kinded roster (V44), and **resolve the `mention_user_ids` / `message_references` split** so `attention-projection.ts:93` and `projections.ts:141-155` read the same register — with a test that fails if a second register reappears. This is map #89 priority 2 and this ticket; they are the same edit and should not be built twice.

4. **A non-human author is attributable.** `projectMessagePosted` must write an author for an agent rather than NULL (V8); the feed's actor column must carry a kind (V68, V69); and an agent's authored words need a voice register of their own (V75) so they never render as human-typed — AGENTS.md's "No synthesized speech" rule, applied to the case it did not anticipate.

5. **The certify boundary refuses an authenticated agent, server-side, mutation-tested.** With ticket 1 landed, a non-human can for the first time hold a session and issue commands — so the reducer's gates (`reduce.ts:715, 724, 738, 811, 1043, 1696, 1764`) must be proven against a *session-borne* non-human, not only against the in-process worker. Includes closing #68 (`reduce.ts:724` gates verified claims on `isHuman` and nothing else). Map #89 calls any hole here campaign-stopping; per the map's routing, both foreign lineages review it.

6. **The scripted participant harness, and the destination scenario spec.** Two provisioned agent principals, deterministic frames on their own sockets, drafts riding the existing acceptance provider, certify refused at the API. Green twice consecutively at 4 workers.

**Explicitly *not* a ticket**: any change to `DEFAULT_ACCEPTANCE_RULES` (§3d) — it is already actor-agnostic and correct.

---

## Contradictions found

Reported because the ticket was written from session memory and asked for exactly this.

1. **`DEFAULT_ACCEPTANCE_RULES` is not a humanity-assumption site.** #91 and #89 priority 3 group it with membership, presence and the strip as a place that "assumes a person". Measured, it is keyed by object type, imports no actor type, and is the *derivation source* for the machine-acceptance floor. It is compliant and needs no change. (§3d)
2. **`authority.ts` does not reference `DEFAULT_ACCEPTANCE_RULES`.** #91 says it does. It imports `{ decideSupersession, MODEL_ACCEPTANCE_FLOOR }` (`authority.ts:11`); the table appears in that file only in prose at `:52` and `:71`.
3. **`escalation.ts` references it, but not as a decision input.** It is used at `escalation.ts:1377` solely to interpolate two θ numbers into a refusal string.
4. **"Identity in the strip" names a surface that holds no roster.** `.wsYou` renders only the *viewer's own* monogram (`AppFrame.tsx:159-169`, sole caller `RoomFrame.tsx:414-418`). No participant other than the viewer appears in the strip today, so an agent appearing there is a new surface, not a widened one. The roster is the Rail, which ships folded — which is why this touches #93.
5. **The `Actor` model with `isHuman` is not, on its own, enough**, and the ticket's framing implies it nearly is. `{kind:'model'}` carries no `userId` (`common.ts:277`), so a non-human has no identity to be a member, an attention target, or a message author with. This is the actual blocker and #91 does not name it.
6. **The database currently asserts the opposite of the destination as an invariant.** `0004_trusted_actor_and_append_boundary.sql:252` — "A model or the system actor is not a room member and cannot be." Not a defect; a deliberate decision that the campaign must now revisit deliberately.
7. **The interpret worker cannot answer in the conversation**, so it cannot be the destination scenario's agent driver even in principle. `message_posted` is produced only by `commands.ts`. #89's "Agent driver choice" is framed as an open trade-off; measured, one arm of it does not exist.
8. **`attention-projection.ts:93` — HANDOFF.md is exactly right**, verbatim, with four independent confirmations that the client never fills the column. Recorded as a *confirmation*, since the map treats it as a claim to verify.
9. **The e2e runner does not run a production build.** #89's destination says "production build, real Postgres". `apps/web/playwright.config.ts:96` runs `pnpm exec next dev` and `config.mjs` sets `NODE_ENV: 'development'`. Real Postgres and the real server process, yes; production build, no. Either the map's wording or the runner needs to move before the scenario can claim it.
10. **`HANDOFF.md` does not exist on `main`** (`c7193a9`), only on `fix/live-v8-fidelity`. AGENTS.md:42 says so ("That branch's `HANDOFF.md`"), but the file is cited across the campaign as though it were a repo-root constant. Related and worth a line for the next session: this worktree's `HEAD` was on `main`, not on the branch its status reported; the brief was rebased onto `927ca7e` before any reading was done.
11. **AGENTS.md and HANDOFF.md disagree about `pnpm lint`** — AGENTS.md:29 says it exits 1 "and always has"; HANDOFF.md:27-31 says it exits 0 now, verified twice. HANDOFF.md is the later measurement on this branch. Not this ticket's to resolve; flagged because AGENTS.md is what a cold reader reads first.

---

## Where this touches #93 (not answered here)

The direct-channel decision is Lars's and is deliberately left open. Three contacts, stated so the build tickets above do not silently pre-empt it:

- **#93 candidate 1** ("a person/agent is a node in the process tree") consumes ticket 2's kinded participant record directly — the process tree would need exactly the discriminant ticket 2 adds. Ticket 2 should ship the field without shipping a navigation affordance.
- **#93 candidate 2** ("the strip is the directory") lands on contradiction 4: the strip has no roster to make clickable. That candidate is a larger build than it reads.
- **#93 candidate 3** ("mention-first, no DM surface v1") *is* ticket 3 — a direct message becomes a room message plus a reference plus attention routing. If the decision goes that way, ticket 3 delivers most of it and #93's build ticket shrinks to copy and affordance.

Nothing in tickets 1–6 forecloses any of the three.
