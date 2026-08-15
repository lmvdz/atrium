import type { IncomingMessage } from 'node:http';
import { coreEventTypes } from '@atrium/db';
import { describe, expect, it } from 'vitest';
import { Command } from '../src/commands.js';
import { ClientFrame, EphemeralFrame, EphemeralNote, LedgerNote } from '../src/protocol.js';
import { declaredRoomId, isCoreEvent, RoomEvent } from '../src/room-events.js';
import { createStubSessionAuthenticator } from '../src/session.js';

/**
 * The wire contract and the ledger's event union, checked without a database.
 * These are the parts a malformed frame reaches first.
 */

const at = '2026-07-31T12:00:00.000Z';

describe('the ledger event union', () => {
  it('folds exactly @atrium/core’s six types, and no more', () => {
    const core = [
      'proposal_recorded',
      'proposal_rejected',
      'proposal_superseded',
      'object_accepted',
      'object_corrected',
      'relation_added',
    ];
    expect([...core].sort()).toEqual([...coreEventTypes].sort());
  });

  it('treats message_posted and attention_resolved as ledger-only', () => {
    const message = RoomEvent.parse({
      id: 'e1',
      at,
      type: 'message_posted',
      roomId: 'r1',
      messageId: 'm1',
      body: 'hello',
    });
    expect(isCoreEvent(message)).toBe(false);
    expect(declaredRoomId(message)).toBe('r1');

    const attention = RoomEvent.parse({
      id: 'e2',
      at,
      type: 'attention_resolved',
      roomId: 'r1',
      attentionId: 'a1',
      status: 'dismissed',
    });
    expect(isCoreEvent(attention)).toBe(false);
    expect(declaredRoomId(attention)).toBe('r1');
  });

  /**
   * #21's contract, held at the *ledger's* boundary rather than only at core's.
   *
   * `CoreEvent.parse` refuses an actor in the payload, but the two ledger-only
   * kinds never reach it — they are not core events — so without a guard of its
   * own this union would be the one door in the wall. The table's
   * `core_events_payload_has_no_actor` check is a constraint on every row and
   * cannot make an exception for two types, so the schema must not either.
   *
   * Catches: deleting the `superRefine` guard from `RoomEvent`, or narrowing it
   * to the core-typed variants. Either leaves a `message_posted` payload able to
   * carry an `actor` key that nothing folds and nothing believes but that sits
   * in the log looking authoritative — and that the database then rejects at
   * INSERT, three inferences from the cause.
   */
  it('refuses an actor inside the payload, for the ledger-only kinds too', () => {
    const actor = { kind: 'human', userId: 'u1' };
    const forged = RoomEvent.safeParse({
      id: 'e1',
      at,
      actor,
      type: 'message_posted',
      roomId: 'r1',
      messageId: 'm1',
      body: 'hello',
    });
    expect(forged.success).toBe(false);
    expect(forged.error?.issues.some((issue) => issue.path[0] === 'actor')).toBe(true);

    const forgedCore = RoomEvent.safeParse({
      id: 'e2',
      at,
      actor,
      type: 'proposal_rejected',
      proposalId: 'p1',
    });
    expect(forgedCore.success).toBe(false);
  });

  /**
   * The six agent/plan/session lifecycle kinds are ledger-only (#116). This is
   * the unit half of "the covenant reducer is untouched": every one parses as a
   * `RoomEvent`, every one is `isCoreEvent === false`, and NONE is in
   * `coreEventTypes` — so folding a room's core-typed subsequence is byte-for-byte
   * identical whether they are present or absent. `coreEventTypes` staying six is
   * the whole claim; the `folds exactly six` test above pins the count, and this
   * pins that the new kinds did not sneak into it.
   *
   * Catches: adding any of the six to `coreEventTypeSet`/`coreEventTypes`, which
   * would make the reducer try to fold a plan and `CoreState` grow a concept of
   * one — the exact thing #114's resolution forbids.
   */
  it('treats the six lifecycle kinds as ledger-only, out of the covenant fold', () => {
    const samples: Array<[string, Record<string, unknown>]> = [
      ['plan_opened', { planId: 'p1', agentUserId: 'a1', title: 'work' }],
      ['plan_settled', { planId: 'p1' }],
      ['session_opened', { sessionId: 's1', planId: 'p1', harness: 'claude', model: 'opus' }],
      ['session_settled', { sessionId: 's1' }],
      ['session_failed', { sessionId: 's1' }],
      [
        'signal_raised',
        {
          targetUserId: 'u1',
          subjectKind: 'message',
          subjectId: 'm1',
          class: 'blocking_question',
          reason: { kind: 'question_names_you', question: 'which cutover?' },
        },
      ],
    ];
    for (const [type, extra] of samples) {
      const event = RoomEvent.parse({ id: `e-${type}`, at, type, roomId: 'r1', ...extra });
      expect(isCoreEvent(event), type).toBe(false);
      expect(declaredRoomId(event), type).toBe('r1');
      expect((coreEventTypes as readonly string[]).includes(type), type).toBe(false);
    }
    // The count is unchanged: the covenant still folds exactly six.
    expect(coreEventTypes).toHaveLength(6);
  });

  /**
   * The ledger's no-actor guard covers the lifecycle kinds too (#116, #21's
   * contract). They never reach `CoreEvent.parse`, so without `RoomEvent`'s own
   * `superRefine` a `plan_opened` could smuggle an `actor` key into the payload —
   * and the table's `core_events_payload_has_no_actor` check would then refuse it
   * three inferences from the cause. Refused here, at the schema, instead.
   */
  it('refuses an actor in a lifecycle payload', () => {
    const forged = RoomEvent.safeParse({
      id: 'e1',
      at,
      actor: { kind: 'agent', userId: 'a1' },
      type: 'session_opened',
      roomId: 'r1',
      sessionId: 's1',
      planId: 'p1',
      harness: 'claude',
      model: 'opus',
    });
    expect(forged.success).toBe(false);
    expect(forged.error?.issues.some((issue) => issue.path[0] === 'actor')).toBe(true);
  });

  /**
   * THE SIGNAL/INTERRUPT KINDS ARE LEDGER-ONLY TOO (#127, #123 resolution 1).
   *
   * The same claim the lifecycle test above makes, made again for the two new
   * kinds because it is the claim the whole decision rests on: a steer is
   * coordination, not the room's understanding, so the reducer must never fold
   * one. Both parse as a `RoomEvent`, both are `isCoreEvent === false`, neither is
   * in `coreEventTypes`, and the covenant still folds exactly six.
   *
   * RED-ON-REVERT: add either type to `coreEventTypeSet` / `coreEventTypes` and
   * the `isCoreEvent` and `includes` assertions go red, and so does the count.
   */
  it('treats the signal/interrupt kinds as ledger-only, out of the covenant fold', () => {
    const samples: Array<[string, Record<string, unknown>]> = [
      ['session_signaled', { sessionId: 's1', signalId: 'sig1', kind: 'steer' }],
      [
        'session_subscribed',
        {
          sessionId: 's1',
          subscriptionId: 'sub1',
          source: 'channel',
          matcher: 'the migration lands',
          expiresAt: at,
        },
      ],
    ];
    for (const [type, extra] of samples) {
      const event = RoomEvent.parse({ id: `e-${type}`, at, type, roomId: 'r1', ...extra });
      expect(isCoreEvent(event), type).toBe(false);
      expect(declaredRoomId(event), type).toBe('r1');
      expect((coreEventTypes as readonly string[]).includes(type), type).toBe(false);
    }
    expect(coreEventTypes).toHaveLength(6);
  });

  /**
   * A SUBSCRIPTION HAS NO SPELLING WITHOUT A HORIZON (#123 resolution 6).
   *
   * `expiresAt` is mandatory in the event, not merely validated in the command —
   * so the wedge shape (a wait that holds a session open forever and blocks its
   * plan's settle with nothing owed to anybody) cannot be written down at all,
   * including by an in-process caller that never goes through `Command.parse`.
   *
   * RED-ON-REVERT: give `expiresAt` a `.nullable().default(null)` or an
   * `.optional()` and this parse succeeds — the test goes red.
   */
  it('refuses a subscription with no expiry — the horizon is mandatory', () => {
    const horizonless = RoomEvent.safeParse({
      id: 'e1',
      at,
      type: 'session_subscribed',
      roomId: 'r1',
      sessionId: 's1',
      subscriptionId: 'sub1',
      source: 'channel',
      matcher: 'anything',
    });
    expect(horizonless.success).toBe(false);
    expect(horizonless.error?.issues.some((issue) => issue.path[0] === 'expiresAt')).toBe(true);
  });

  /**
   * REPLAY ≡ LIVE ACROSS THE THREE SHAPES #128 WIDENED.
   *
   * `causeMessageId` was added to `message_posted`, `plan_opened` and
   * `session_opened` (#124 resolution 3). Three event shapes got a new key, and
   * every row of those kinds already in a ledger OMITS it — a replay parses
   * those rows with today's schema, so if the key were required, or defaulted to
   * anything but `null`, the same ledger would yield different events before and
   * after this change and the live ≡ replay guarantee would be gone.
   *
   * This is the omitted-key parse pin, and it asserts the VALUE, not merely that
   * the parse succeeded: `undefined` would also "parse" under an `.optional()`
   * and would then serialise differently on the way back out.
   *
   * RED-ON-REVERT: drop `.default(null)` from any of the three (leaving
   * `.nullable()`) and that shape's parse throws; make it `.optional()` without
   * a default and the `toBe(null)` assertion goes red on `undefined`; make it
   * required and both go red.
   */
  it('parses a pre-#128 row of each widened kind, defaulting the routing receipt to null', () => {
    const older: Array<[string, Record<string, unknown>]> = [
      ['message_posted', { messageId: 'm1', body: 'before the field existed' }],
      ['plan_opened', { planId: 'p1', agentUserId: 'a1', title: 'work' }],
      ['session_opened', { sessionId: 's1', planId: 'p1', harness: 'claude', model: 'opus' }],
    ];
    for (const [type, extra] of older) {
      const event = RoomEvent.parse({ id: `e-${type}`, at, type, roomId: 'r1', ...extra });
      expect('causeMessageId' in event, type).toBe(true);
      expect((event as { causeMessageId: string | null }).causeMessageId, type).toBe(null);
    }
  });

  /**
   * …AND A ROW THAT CARRIES ONE KEEPS IT (#128). The other half of the widening:
   * a pin that only proves the omitted key defaults would stay green if the
   * field were hard-coded to `null` and the payload's value thrown away, which
   * is exactly how a routing receipt becomes ornament.
   *
   * RED-ON-REVERT: replace the field with `z.null().default(null)` — the
   * omitted-key pin above stays green, and this one goes red.
   */
  it('keeps a routing receipt a widened event actually carries', () => {
    const posted = RoomEvent.parse({
      id: 'e1',
      at,
      type: 'message_posted',
      roomId: 'r1',
      messageId: 'm2',
      body: 'the answer arm',
      causeMessageId: 'm1',
    });
    expect((posted as { causeMessageId: string | null }).causeMessageId).toBe('m1');
  });

  /**
   * REPLAY ≡ LIVE ACROSS THE WIDENED `signal_raised` (#127).
   *
   * #127 widened `SignalRaised.subjectKind` from three subjects to four so a
   * subscription-expiry escalation can name the SESSION it is about. A widening
   * must not change how an OLDER row folds: every `signal_raised` already in a
   * ledger names one of the original three, and a replay parses those rows with
   * today's schema. This pins that all three still parse, and that the new
   * subject parses too — so the same ledger yields the same events before and
   * after the change.
   *
   * RED-ON-REVERT: narrow the enum back (dropping `session`) and the fourth case
   * fails; replace it rather than widening it (e.g. `z.enum(['session'])`) and the
   * first three fail — either direction is caught.
   */
  it('parses every signal_raised subject, old and new, so a replay is unchanged', () => {
    for (const subjectKind of ['object', 'proposal', 'message', 'session'] as const) {
      const raised = RoomEvent.parse({
        id: `e-${subjectKind}`,
        at,
        type: 'signal_raised',
        roomId: 'r1',
        targetUserId: 'u1',
        subjectKind,
        subjectId: 'x1',
        class: 'blocking_question',
        reason: { kind: 'question_names_you', question: 'which cutover?' },
      });
      expect(raised.type === 'signal_raised' && raised.subjectKind, subjectKind).toBe(subjectKind);
      expect(isCoreEvent(raised), subjectKind).toBe(false);
    }
  });

  it('refuses presence — it is not a kind of event at all (#14)', () => {
    expect(
      RoomEvent.safeParse({ id: 'e1', at, type: 'presence_changed', roomId: 'r1' }).success,
    ).toBe(false);
  });

  it('leaves the room of a correction, a rejection or a supersession to state', () => {
    const corrected = RoomEvent.parse({
      id: 'e1',
      at,
      type: 'object_corrected',
      objectId: 'o1',
      action: 'retract',
    });
    expect(declaredRoomId(corrected)).toBeNull();

    const rejected = RoomEvent.parse({ id: 'e2', at, type: 'proposal_rejected', proposalId: 'p1' });
    expect(declaredRoomId(rejected)).toBeNull();

    // The sixth core type, which #21 added. Catches: leaving
    // `proposal_superseded` out of `declaredRoomId`'s room-less arm, where it
    // would fall through to the exhaustiveness `never` and stop compiling — or,
    // worse, out of the `RoomEvent` union entirely, where the ledger would parse
    // a durable row as unknown and refuse to fold the whole page.
    const superseded = RoomEvent.parse({
      id: 'e3',
      at,
      type: 'proposal_superseded',
      proposalId: 'p1',
    });
    expect(declaredRoomId(superseded)).toBeNull();
    expect(isCoreEvent(superseded)).toBe(true);
  });

  it('requires a canonical timestamp with an offset', () => {
    const bad = RoomEvent.safeParse({
      id: 'e1',
      at: 'yesterday',
      type: 'message_posted',
      roomId: 'r1',
      messageId: 'm1',
      body: 'hello',
    });
    expect(bad.success).toBe(false);
  });
});

describe('ClientFrame', () => {
  it('accepts the complete authenticated command vocabulary', () => {
    const names = [
      'send_message',
      'answer_message',
      'accept_proposal',
      'correct',
      'answer_bind',
      'supersede_object',
      'resolve_attention',
      'set_presence',
      'record_proposal',
      'stage_semantic_command',
      'reject_proposal',
      'set_typing',
      'advance_seen',
      // The agent/plan/session lifecycle verbs (#116).
      'open_plan',
      'settle_plan',
      'open_session',
      'settle_session',
      'raise_signal',
      // The budget/rlimit spend-authorization (#118): human-only slice set/raise.
      'set_plan_rlimit',
      // The signal/interrupt boundary (#127). `resume_session` is its OWN verb
      // rather than a third `kind` on `signal_session`, because a resume SPENDS a
      // plan's slice and a steer does not — a verb whose authorization you cannot
      // read off its name is a verb nobody checks correctly.
      'signal_session',
      'resume_session',
      'subscribe_session',
      // The live progress channel (#159): the single door a running session's
      // phases / heartbeat / diff deltas enter, authority-guarded like settle.
      'report_session_progress',
    ];
    const declared = Command.options.map((option) => option.shape.name.value);
    expect([...declared].sort()).toEqual([...names].sort());
  });

  it('refuses an empty message body', () => {
    const frame = ClientFrame.safeParse({
      type: 'command',
      commandId: 'c1',
      command: { name: 'send_message', roomId: 'r1', body: '' },
    });
    expect(frame.success).toBe(false);
  });

  it('refuses a negative since cursor before it reaches the database', () => {
    expect(ClientFrame.safeParse({ type: 'since', roomId: 'r1', roomSeq: -1 }).success).toBe(false);
    expect(ClientFrame.safeParse({ type: 'since', roomId: 'r1', roomSeq: 0 }).success).toBe(true);
  });

  it('caps a catch-up page so one frame cannot ask for the whole log', () => {
    expect(
      ClientFrame.safeParse({ type: 'since', roomId: 'r1', roomSeq: 0, limit: 5000 }).success,
    ).toBe(false);
  });

  it('defaults the optional halves of send_message rather than demanding them', () => {
    const frame = ClientFrame.parse({
      type: 'command',
      commandId: 'c1',
      command: { name: 'send_message', roomId: 'r1', body: 'hi' },
    });
    expect(frame).toMatchObject({
      command: { clientMessageId: null, replyToId: null, attachments: [] },
    });
  });
});

/**
 * The two Postgres channels are untrusted input, and the ephemeral one has a
 * closed alphabet (#22 gauntlet r6, major 1).
 *
 * `NOTIFY` requires no privilege, so both of these strings are reachable by
 * anything that can open a connection to the database. The r6 gauntlet published
 * a forged `event` frame on `atrium_ephemeral` and a subscribed client committed
 * it to its durable journal while `core_events` held nothing at all.
 *
 * The end-to-end refusal is `integration/server/catchup.test.ts`; these are the
 * schemas on their own, because the alphabet is the design decision and a
 * schema is where a design decision can be read.
 */
describe('the bus carries volatile state and invalidation, never history', () => {
  const room = '11111111-1111-4111-8111-111111111111';
  const user = '22222222-2222-4222-8222-222222222222';
  const presence = { type: 'presence', roomId: room, userId: user, state: 'online', at };

  const session = '44444444-4444-4444-8444-444444444444';

  it('accepts exactly the five non-history frames', () => {
    expect(EphemeralFrame.parse(presence)).toMatchObject({ type: 'presence' });
    expect(
      EphemeralFrame.parse({ type: 'typing', roomId: room, userId: user, typing: true, at }),
    ).toMatchObject({ type: 'typing' });
    expect(EphemeralFrame.parse({ type: 'projection_changed', roomId: room, at })).toMatchObject({
      type: 'projection_changed',
    });
    // The live progress frames (#159) — presence-shaped previews, never history.
    expect(
      EphemeralFrame.parse({
        type: 'session_heartbeat',
        roomId: room,
        sessionId: session,
        progressSeq: 0,
        spendMicros: 100,
        contextPct: 0.5,
        at,
      }),
    ).toMatchObject({ type: 'session_heartbeat' });
    expect(
      EphemeralFrame.parse({
        type: 'session_diff_delta',
        roomId: room,
        sessionId: session,
        progressSeq: 1,
        at,
        truncated: false,
        files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
      }),
    ).toMatchObject({ type: 'session_diff_delta' });
    // The whole union, so a frame added to `EphemeralFrame` without a decision
    // shows up here rather than in production.
    expect(EphemeralFrame.options.map((option) => option.shape.type.value).sort()).toEqual([
      'presence',
      'projection_changed',
      'session_diff_delta',
      'session_heartbeat',
      'typing',
    ]);
  });

  it('bounds a diff-delta frame by the FILE count, not the line ceiling (#159 finding 8)', () => {
    // The `files` array is capped at MAX_DIFF_FILES (40), not MAX_DIFF_LINES (2000):
    // a diff carries files, and each file's single hunk is separately line-capped.
    // Mutation this catches: restore `.max(MAX_DIFF_LINES)` on the files array and a
    // frame carrying 41 files parses — fifty times the durable diff's file ceiling.
    const file = (i: number) => ({
      path: `f${i}.ts`,
      status: 'added' as const,
      additions: 0,
      deletions: 0,
    });
    const base = {
      type: 'session_diff_delta',
      roomId: room,
      sessionId: session,
      at,
      truncated: false,
    };
    // 40 files is the cap and still parses.
    expect(
      EphemeralFrame.parse({
        ...base,
        progressSeq: 0,
        files: Array.from({ length: 40 }, (_v, i) => file(i)),
      }),
    ).toMatchObject({ type: 'session_diff_delta' });
    // 41 files — one over the FILE cap, and far under the old line cap — is refused.
    expect(() =>
      EphemeralFrame.parse({
        ...base,
        progressSeq: 1,
        files: Array.from({ length: 41 }, (_v, i) => file(i)),
      }),
    ).toThrow();
  });

  it('carries no epistemic field on the live progress frames (#159 covenant point 2)', () => {
    // The covenant boundary: nothing on this channel asserts certification. A frame
    // carrying a `certified`/`verified` discriminant is a `✓` the machine never
    // earned; the schema strips unknown keys, so such a field cannot survive parse.
    const heartbeat = EphemeralFrame.parse({
      type: 'session_heartbeat',
      roomId: room,
      sessionId: session,
      progressSeq: 0,
      spendMicros: null,
      contextPct: null,
      at,
      certified: true,
      verification: 'verified',
    });
    expect(heartbeat).not.toHaveProperty('certified');
    expect(heartbeat).not.toHaveProperty('verification');
  });

  it('has no spelling for a durable frame', () => {
    // The r6 exploit's payload. It is not "refused by validation" so much as
    // unsayable: `event` is not in the union, so there is no shape to get right.
    const forged = {
      type: 'event',
      entry: {
        roomId: room,
        roomSeq: 1,
        seq: 1,
        actor: { kind: 'human', userId: user },
        event: { id: 'e1', at, type: 'message_posted', body: 'this is not in the ledger' },
      },
    };
    expect(EphemeralFrame.safeParse(forged).success).toBe(false);
    expect(
      EphemeralNote.safeParse({ origin: 'attacker', roomId: room, frame: forged }).success,
    ).toBe(false);
    for (const type of ['catchup', 'ack', 'subscribed', 'welcome', 'error']) {
      expect(EphemeralFrame.safeParse({ ...presence, type }).success).toBe(false);
    }
  });

  it('refuses a note whose envelope and frame name different rooms', () => {
    // The envelope's `roomId` is the fan-out key and the frame's is what the
    // client reads; a note where they differ delivers one room's presence into
    // another room's timeline. Refused rather than reconciled — there is no
    // principled way to pick.
    const elsewhere = '33333333-3333-4333-8333-333333333333';
    expect(EphemeralNote.safeParse({ origin: 'a', roomId: room, frame: presence }).success).toBe(
      true,
    );
    expect(
      EphemeralNote.safeParse({ origin: 'a', roomId: elsewhere, frame: presence }).success,
    ).toBe(false);
    // …and an anonymous relay is refused too: only an instance relays, and it
    // names itself so the echo of its own frame can be ignored.
    expect(EphemeralNote.safeParse({ origin: '', roomId: room, frame: presence }).success).toBe(
      false,
    );
  });

  it('parses a ledger announcement rather than casting it', () => {
    const note = { origin: 'instance-a', roomId: room, seq: 4, roomSeq: 2 };
    expect(LedgerNote.parse(note)).toEqual(note);
    // A null origin is a writer that did not name itself, and every instance
    // must fold it — so it is legal, and it is the only legal absence.
    expect(LedgerNote.parse({ ...note, origin: null }).origin).toBeNull();
    for (const bad of [
      // `Id`, the same room-id contract every other frame uses: printable ASCII
      // with no spaces, non-empty. Not a uuid pattern — room ids are uuids in
      // this deployment, but the wire contract is `Id` everywhere and a second,
      // stricter spelling here would be two rules for one thing.
      { ...note, roomId: '' },
      { ...note, roomId: 'two words' },
      { ...note, seq: '4' },
      { ...note, seq: 0 },
      { ...note, roomSeq: -1 },
      { ...note, roomSeq: 1.5 },
      { origin: null, roomId: room, seq: 4 },
    ]) {
      expect(LedgerNote.safeParse(bad).success).toBe(false);
    }
  });
});

describe('the #26 session stub', () => {
  const auth = createStubSessionAuthenticator();
  const request = (headers: Record<string, string>, url = '/ws') =>
    ({ headers, url }) as unknown as IncomingMessage;

  it('reads the user from a header', async () => {
    await expect(auth.authenticateUpgrade(request({ 'x-atrium-user': 'u1' }))).resolves.toEqual({
      userId: 'u1',
      principalKind: 'human',
      method: 'stub',
    });
  });

  it('reads the principal kind, and refuses a value it does not recognise', async () => {
    // Catches: `parsePrincipalKind` replaced by `claimed === 'agent' ? 'agent' :
    // 'human'`. That spelling answers "human" for a typo, and a suite that
    // thinks it is driving the agent path would drive the person path and pass —
    // which is the same fail-open direction #90 names one layer up, reproduced
    // in the test fixture rather than in the product.
    await expect(
      auth.authenticateUpgrade(request({ 'x-atrium-user': 'u1', 'x-atrium-principal': 'agent' })),
    ).resolves.toEqual({ userId: 'u1', principalKind: 'agent', method: 'stub' });
    await expect(
      auth.authenticateUpgrade(request({}, '/ws?user=u2&principal=agent')),
    ).resolves.toEqual({ userId: 'u2', principalKind: 'agent', method: 'stub' });
    // `model` and `system` are `actor_kind` values, not `principal_kind` values:
    // they name anonymous server-side writers, which is exactly what a session
    // cannot be. Refusing them here is what keeps the two enums from bleeding.
    for (const claimed of ['Agent', 'HUMAN', 'model', 'system', 'robot']) {
      await expect(
        auth.authenticateUpgrade(request({ 'x-atrium-user': 'u1', 'x-atrium-principal': claimed })),
      ).resolves.toBeNull();
    }
  });

  it('reads it from the query string, which is all a browser socket can send', async () => {
    await expect(auth.authenticateUpgrade(request({}, '/ws?user=u2'))).resolves.toMatchObject({
      userId: 'u2',
    });
  });

  it('refuses an unidentified socket rather than inventing an anonymous one', async () => {
    // A default identity would make every membership check downstream vacuous
    // the first time somebody forgot to pass a user.
    await expect(auth.authenticateUpgrade(request({}))).resolves.toBeNull();
    await expect(auth.authenticateUpgrade(request({ 'x-atrium-user': '   ' }))).resolves.toBeNull();
    await expect(auth.authenticateUpgrade(request({}, '/ws?user='))).resolves.toBeNull();
  });
});
