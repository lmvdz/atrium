import type { DatabaseHandle } from '@atrium/db';
import { acceptedObjects, corrections, proposals } from '@atrium/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandInput } from '../../apps/server/src/commands.js';
import {
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  startTestServer,
  TestClient,
  type TestServer,
} from '../support/harness.js';

/**
 * #22 r10, against a real server, a real Postgres and three real sockets.
 *
 * The four defects have one class between them — *a member puts an obligation on
 * another member's name* — and r9 closed one route to it. These are the other
 * routes, plus the reason it mattered that they reached the room at all: a
 * refused write was broadcast to every other participant with no marker on it,
 * and replayed to cold readers by `since`.
 *
 * Everything here is judged on **what is in the database** and **what arrives on
 * the other participants' sockets**, never on the actor's own ack. The refusal
 * convention makes that necessary rather than fastidious: a business refusal is
 * an `ack` with a non-empty `issues`, so a test that read only the frame type
 * would call every one of these a success.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
const open: TestClient[] = [];

async function connect(userId: string): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId);
  open.push(client);
  return client;
}

beforeEach(async () => {
  handle ??= openDatabase(10);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['mallory', 'victim', 'bystander']);
  server = await startTestServer(handle);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

const issuesOf = (ack: { type: string; issues?: string[] }) =>
  ack.type === 'ack' ? (ack.issues ?? []) : ['NACK'];

/** Stage a proposal and return its server-minted id, read off the event echo. */
/** The draft as a *caller* writes it — defaults not yet applied. See `CommandInput`. */
type DraftInput = Extract<CommandInput, { name: 'record_proposal' }>['proposal'];

async function stage(client: TestClient, proposal: DraftInput): Promise<string> {
  const ack = await client.command({ name: 'record_proposal', roomId: room.roomId, proposal });
  if (ack.type !== 'ack') throw new Error(`staging was nacked: ${JSON.stringify(ack)}`);
  const frame = await client.waitFor((f) => f.type === 'event' && f.entry.event.id === ack.eventId);
  if (frame.type !== 'event' || frame.entry.event.type !== 'proposal_recorded') {
    throw new Error('no proposal echo');
  }
  return frame.entry.event.proposal.id;
}

/** Accept a proposal and return the minted object's id, or null if none was. */
async function accept(
  client: TestClient,
  proposalId: string,
): Promise<{ issues: string[]; objectId: string | null }> {
  const ack = await client.command({ name: 'accept_proposal', roomId: room.roomId, proposalId });
  if (ack.type !== 'ack') return { issues: ['NACK'], objectId: null };
  const frame = await client.waitFor((f) => f.type === 'event' && f.entry.event.id === ack.eventId);
  const objectId =
    frame.type === 'event' && frame.entry.event.type === 'object_accepted'
      ? frame.entry.event.object.id
      : null;
  return { issues: issuesOf(ack), objectId };
}

async function objectRow(objectId: string) {
  const [row] = await handle.db
    .select()
    .from(acceptedObjects)
    .where(and(eq(acceptedObjects.id, objectId), eq(acceptedObjects.roomId, room.roomId)));
  return row;
}

describe('#4 across every route by which a name arrives on an object', () => {
  it('refuses reattributing your own commitment onto a colleague — D1', async () => {
    /**
     * Three commands, one ordinary member: stage a commitment you own, accept it
     * (legitimate — nobody else's name on it), then move it. Under r9 all three
     * acked with `issues: []`, `accepted_objects` held a commitment owned by the
     * victim, and the victim's socket got the `object_corrected` frame live.
     *
     * Mutation: remove the `correctionAttributionRefusal` call from
     * `applyObjectCorrected` in `@atrium/core`.
     */
    const mallory = await connect(room.people.mallory as string);
    const victim = await connect(room.people.victim as string);
    await mallory.subscribe(room.roomId);
    await victim.subscribe(room.roomId);

    const proposalId = await stage(mallory, {
      type: 'commitment',
      payload: { statement: 'I will write the migration', owner: room.people.mallory as string },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const minted = await accept(mallory, proposalId);
    expect(minted.issues).toEqual([]);
    const objectId = minted.objectId as string;

    const mark = victim.frames.length;
    const ack = await mallory.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'reattribute',
      patch: { owner: room.people.victim as string },
    });

    expect(issuesOf(ack as { type: string; issues?: string[] })[0]).toContain(
      `putting user "${room.people.victim}"'s name on it`,
    );
    // The database, not the ack: still Mallory's.
    expect((await objectRow(objectId))?.payload).toMatchObject({
      owner: room.people.mallory as string,
    });
    expect(
      await handle.db.select().from(corrections).where(eq(corrections.objectId, objectId)),
    ).toEqual([]);
    // And the victim's socket: the frame arrives, because the row took a
    // position in the log — but it arrives marked, which is D4's half of this.
    const frame = await victim.waitFor(
      (f) => f.type === 'event' && f.entry.event.type === 'object_corrected',
      5000,
      mark,
    );
    if (frame.type !== 'event') throw new Error('unreachable');
    expect(frame.entry.issues.length).toBeGreaterThan(0);
  });

  it('refuses reattributing onto a uuid that belongs to no user — D1', async () => {
    const mallory = await connect(room.people.mallory as string);
    await mallory.subscribe(room.roomId);
    const proposalId = await stage(mallory, {
      type: 'commitment',
      payload: { statement: 'I will write the migration', owner: room.people.mallory as string },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const objectId = (await accept(mallory, proposalId)).objectId as string;

    // No FK on the payload, and none needed: it is refused for not being the
    // corrector's own name, which the reducer can answer without a directory.
    const ghost = '11111111-2222-4333-8444-555555555555';
    const ack = await mallory.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'reattribute',
      patch: { owner: ghost },
    });
    expect(issuesOf(ack as { type: string; issues?: string[] })[0]).toContain(ghost);
    expect((await objectRow(objectId))?.payload).toMatchObject({
      owner: room.people.mallory as string,
    });
  });

  it('refuses a self-accepted decision that names somebody else as decider — D2', async () => {
    /**
     * Two commands, both `ack issues: []` under r9, and the room's record then
     * said the victim cancelled the audit. `payloadAttributedTo` resolved
     * `decision → null`, so no gate ever saw the name.
     *
     * Mutation: reclassify `decidedBy` as anything but `attribution` in
     * `attribution.ts`.
     */
    const mallory = await connect(room.people.mallory as string);
    await mallory.subscribe(room.roomId);
    const proposalId = await stage(mallory, {
      type: 'decision',
      payload: {
        statement: 'We are cancelling the audit',
        decidedBy: room.people.victim as string,
        status: 'active',
      },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const result = await accept(mallory, proposalId);
    expect(result.issues[0]).toContain(`puts user "${room.people.victim}"'s name on it`);

    // Server truth: nothing minted, and the proposal is still waiting for the
    // person it names — which is where it should wait.
    expect(
      await handle.db.select().from(acceptedObjects).where(eq(acceptedObjects.roomId, room.roomId)),
    ).toEqual([]);
    const [row] = await handle.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(row?.status).toBe('proposed');
  });

  it('lets a second person accept that same decision', async () => {
    // The design position r9 recorded and r10 does not touch. Without this the
    // fix would read as "decisions may not name anybody", which is not the rule.
    const mallory = await connect(room.people.mallory as string);
    const victim = await connect(room.people.victim as string);
    await mallory.subscribe(room.roomId);
    await victim.subscribe(room.roomId);
    const proposalId = await stage(mallory, {
      type: 'decision',
      payload: {
        statement: 'We are cancelling the audit',
        decidedBy: room.people.victim as string,
        status: 'active',
      },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const result = await accept(victim, proposalId);
    expect(result.issues).toEqual([]);
    expect((await objectRow(result.objectId as string))?.type).toBe('decision');
  });

  it('refuses a retype that mints the obligation, and keeps row and fold agreed on type — D3', async () => {
    /**
     * Two halves, both of them r10's.
     *
     * The authority half: an `objective` names nobody, so nothing has grounds to
     * refuse it — and `retype` to a commitment then puts a colleague's name on
     * it without ever staging one.
     *
     * The read-model half: `projectObjectCorrected` wrote payload, revision,
     * retracted/superseded and updatedAt, and **never `type`**, which was only
     * ever written at insert. So a legal retype left the row reading
     * `type = 'objective'` carrying a commitment payload, permanently, with both
     * partial indexes filing it under the wrong type.
     *
     * Mutation for the second half: delete `type: record.object.type` from
     * `projectObjectCorrected`'s `.set({…})`.
     */
    const mallory = await connect(room.people.mallory as string);
    await mallory.subscribe(room.roomId);
    const proposalId = await stage(mallory, {
      type: 'objective',
      payload: { title: 'Finish the audit', status: 'open' },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const objectId = (await accept(mallory, proposalId)).objectId as string;

    const stolen = await mallory.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'retype',
      toType: 'commitment',
      patch: { owner: room.people.victim as string },
    });
    expect(issuesOf(stolen as { type: string; issues?: string[] })[0]).toContain(
      `putting user "${room.people.victim}"'s name on it`,
    );
    expect((await objectRow(objectId))?.type).toBe('objective');

    // The same retype onto himself is legal — and now the row moves with the
    // fold. Under r9 this line returned 'objective'.
    const own = await mallory.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'retype',
      toType: 'commitment',
      patch: { owner: room.people.mallory as string },
    });
    expect(issuesOf(own as { type: string; issues?: string[] })).toEqual([]);
    const row = await objectRow(objectId);
    expect(row?.type).toBe('commitment');
    expect(row?.payload).toMatchObject({ owner: room.people.mallory as string });

    // …and they still agree after a restart, which is where r9's version
    // diverged for good: the fold said commitment, the row said objective, and
    // nothing ever reconverged them.
    const restarted = await startTestServer(handle);
    try {
      const state = restarted.ledger.coreState();
      expect(state.objects[objectId]?.object.type).toBe('commitment');
      expect((await objectRow(objectId))?.type).toBe('commitment');
    } finally {
      await restarted.close();
    }
  });
});

describe('#4’s other half — a sentence arriving under somebody else’s name', () => {
  it('refuses the five commands that made the victim confess to taking kickbacks — r11', async () => {
    /**
     * r10 closed *nobody gets committed by someone else's sentence* and left
     * *nobody gets **quoted*** open, while the refusal text went on citing it.
     * `correctionAttributionRefusal` compared name sets and never looked at the
     * field the sentence is in, so five commands — every one an `ack` with
     * `issues: []` — turned the victim's own accepted commitment into a `✓`
     * claim in which he confesses to taking kickbacks, in his name, with
     * Mallory's words:
     *
     *   amend {statement}      ← the defect
     *   amend {due}            ← legal, and stays legal
     *   retype → claim         ← legal: the victim's name was already there
     *   amend {verification}   ← isHuman-gated only; #68, not this round
     *   amend {statement}      ← the defect again, now on a verified claim
     *
     * Driven against a real server and judged on `accepted_objects` and on the
     * victim's and the bystander's sockets, because the actor's own ack is not
     * evidence: a business refusal *is* an ack.
     *
     * Mutation: `the_gate_never_refuses_on_the_sentence` — drop the clause in
     * `correctionAttributionRefusal` that compares `objectStatement(after)`
     * with `objectStatement(before)`.
     */
    const mallory = await connect(room.people.mallory as string);
    const victim = await connect(room.people.victim as string);
    const bystander = await connect(room.people.bystander as string);
    await mallory.subscribe(room.roomId);
    await victim.subscribe(room.roomId);
    await bystander.subscribe(room.roomId);

    // The victim stages and self-accepts his own commitment. Entirely legal.
    const victimId = room.people.victim as string;
    const OWN_WORDS = "I'll review the Q3 deck before Friday";
    const proposalId = await stage(victim, {
      type: 'commitment',
      payload: { statement: OWN_WORDS, owner: victimId },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const minted = await accept(victim, proposalId);
    expect(minted.issues).toEqual([]);
    const objectId = minted.objectId as string;

    const marked = (ack: { type: string; issues?: string[] }) => issuesOf(ack);

    const first = await mallory.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'amend',
      patch: { statement: 'I falsified the Q3 revenue figures' },
    });
    expect(marked(first)[0]).toContain(
      `rewording a sentence that stands under user "${victimId}"'s name`,
    );

    // The three that assert nothing under his name still land — the round does
    // not freeze the product to close the leak.
    for (const legal of [
      { action: 'amend' as const, patch: { due: '2026-08-14T17:00:00.000Z' } },
      { action: 'retype' as const, patch: { claimant: victimId }, toType: 'claim' as const },
      { action: 'amend' as const, patch: { verification: 'verified' } },
    ]) {
      const ack = await mallory.command({
        name: 'correct',
        roomId: room.roomId,
        objectId,
        action: legal.action,
        patch: legal.patch,
        ...(legal.toType ? { toType: legal.toType } : {}),
      });
      expect(marked(ack)).toEqual([]);
    }

    const last = await mallory.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'amend',
      patch: { statement: 'I have been taking kickbacks from the vendor' },
    });
    expect(marked(last)[0]).toContain(
      `rewording a sentence that stands under user "${victimId}"'s name`,
    );

    // The database. Under r10 this row read `revision: 5` with Mallory's
    // sentence in it; the sentence is the victim's own, and only the three
    // legal acts moved the revision.
    const row = await objectRow(objectId);
    expect(row?.type).toBe('claim');
    expect(row?.payload).toMatchObject({
      claimant: victimId,
      statement: OWN_WORDS,
      verification: 'verified',
    });
    expect(row?.revision).toBe(3);
    expect(
      (await handle.db.select().from(corrections).where(eq(corrections.objectId, objectId))).map(
        (entry) => entry.action,
      ),
    ).toEqual(['amend', 'retype', 'amend']);

    // And the other participants' sockets: both refused rows arrive — the log
    // is gap-free — and both arrive carrying the reason they took no effect.
    for (const watcher of [victim, bystander]) {
      const refused = watcher.frames.filter(
        (frame) => frame.type === 'event' && frame.entry.issues.length > 0,
      );
      expect(refused).toHaveLength(2);
      for (const frame of refused) {
        if (frame.type !== 'event') throw new Error('unreachable');
        expect(frame.entry.event.type).toBe('object_corrected');
        expect(frame.entry.issues[0]).toContain('nobody gets committed, or quoted');
      }
    }
  });

  it('lets the person named reword it, and leaves every other verb alone', async () => {
    /**
     * The other direction, and the one a fix for this is most likely to get
     * wrong: refusing whenever a name is *present* rather than when the
     * sentence *changes* freezes the product instead of leaking. Seven
     * corrections by somebody who is not named, on an object that names the
     * victim, plus the victim rewording his own sentence.
     *
     * Mutation: `the_sentence_clause_fires_on_a_name_being_present`, and
     * `the_sentence_clause_ignores_whose_name_it_is` for the last line.
     */
    const mallory = await connect(room.people.mallory as string);
    const victim = await connect(room.people.victim as string);
    await mallory.subscribe(room.roomId);
    await victim.subscribe(room.roomId);

    const victimId = room.people.victim as string;
    const proposalId = await stage(victim, {
      type: 'commitment',
      payload: { statement: "I'll ship the migration on Tuesday", owner: victimId },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const objectId = (await accept(victim, proposalId)).objectId as string;

    const byMallory = [
      { action: 'amend' as const, patch: { due: '2026-09-01T09:00:00.000Z' } },
      { action: 'amend' as const, patch: { status: 'done' } },
      { action: 'reopen' as const, patch: {} },
      { action: 'retract' as const, patch: {} },
      { action: 'restore' as const, patch: {} },
    ];
    for (const step of byMallory) {
      const ack = await mallory.command({
        name: 'correct',
        roomId: room.roomId,
        objectId,
        action: step.action,
        patch: step.patch,
      });
      expect(issuesOf(ack as { type: string; issues?: string[] })).toEqual([]);
    }

    // The person named may reword it — the one correction the product most
    // needs to keep, because it is what turns `~` into `✓`.
    const own = await victim.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'amend',
      patch: { statement: "I'll ship the migration on Wednesday" },
    });
    expect(issuesOf(own as { type: string; issues?: string[] })).toEqual([]);

    const row = await objectRow(objectId);
    expect(row?.payload).toMatchObject({
      statement: "I'll ship the migration on Wednesday",
      owner: victimId,
      due: '2026-09-01T09:00:00.000Z',
    });
    expect(row?.revision).toBe(6);
  });

  it('does not read a retype’s carried sentence as a rewording', async () => {
    /**
     * #5's canonical fix — "that was only a suggestion" — carries the text from
     * one type's key to another's. Comparing the patch's keys instead of the two
     * sentences would refuse it on anybody else's object and take the affordance
     * out of the product.
     *
     * Mutation: compare `Object.hasOwn(event.patch, TEXT_FIELD[type])` instead
     * of `objectStatement(after) === objectStatement(before)`.
     */
    const mallory = await connect(room.people.mallory as string);
    const victim = await connect(room.people.victim as string);
    await mallory.subscribe(room.roomId);
    await victim.subscribe(room.roomId);

    const victimId = room.people.victim as string;
    const SENTENCE = 'we should drop the flag after GA';
    const proposalId = await stage(victim, {
      type: 'commitment',
      payload: { statement: SENTENCE, owner: victimId },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const objectId = (await accept(victim, proposalId)).objectId as string;

    const ack = await mallory.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'retype',
      toType: 'open_question',
      patch: {},
    });
    expect(issuesOf(ack as { type: string; issues?: string[] })).toEqual([]);
    const row = await objectRow(objectId);
    expect(row?.type).toBe('open_question');
    // The same sentence, under the new type's own key — which is what makes it
    // a statement about how it was read rather than a new sentence.
    expect(row?.payload).toMatchObject({ question: SENTENCE });
  });
});

describe('a refused append on the wire — D4', () => {
  it('reaches every other subscriber carrying its refusal, live and on catch-up', async () => {
    /**
     * The one that makes the other three worse. r9's refusal was delivered to
     * the actor's own socket in its `ack` and to nobody else, while the row was
     * appended and `hub.broadcast` fanned the full frame — payload and all — to
     * every subscriber, and `since` replayed it to cold readers. So the
     * *refusal* reached one person and the *sentence* reached the room, and
     * stayed in everybody's durable journal.
     *
     * The decision: the row is broadcast, because `room_seq` is advertised
     * gap-free and withholding it would leave a hole every client reads as loss
     * — and it carries the reason it took no effect, on the live path and the
     * catch-up path both, from one derivation in the ledger.
     *
     * Mutation: drop `issues` from `toWire`, or from the `WireEvent` built in
     * `handleCommand`. Either one leaves the other path marked and this fails.
     */
    const mallory = await connect(room.people.mallory as string);
    const victim = await connect(room.people.victim as string);
    const bystander = await connect(room.people.bystander as string);
    await mallory.subscribe(room.roomId);
    await victim.subscribe(room.roomId);
    await bystander.subscribe(room.roomId);

    const proposalId = await stage(mallory, {
      type: 'commitment',
      payload: {
        statement: 'Victim will work through the holidays',
        owner: room.people.victim as string,
        status: 'open',
      },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });

    const markV = victim.frames.length;
    const markB = bystander.frames.length;
    const ack = await mallory.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
    });
    if (ack.type !== 'ack') throw new Error('expected an ack with issues, not a nack');
    expect(ack.issues.length).toBeGreaterThan(0);

    // Server truth first.
    expect(
      await handle.db.select().from(acceptedObjects).where(eq(acceptedObjects.roomId, room.roomId)),
    ).toEqual([]);
    const [proposal] = await handle.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(proposal?.status).toBe('proposed');

    // Live, on both other sockets.
    for (const [who, mark] of [
      [victim, markV],
      [bystander, markB],
    ] as const) {
      const frame = await who.waitFor(
        (f) => f.type === 'event' && f.entry.event.id === ack.eventId,
        5000,
        mark,
      );
      if (frame.type !== 'event') throw new Error('unreachable');
      expect(frame.entry.issues).toEqual(ack.issues);
    }

    // …and on catch-up, to a socket that was not there. Same list, same order.
    const cold = await connect(room.people.bystander as string);
    await cold.subscribe(room.roomId);
    const page = await cold.since(room.roomId, 0);
    const replayed = page.entries.find((entry) => entry.event.id === ack.eventId);
    expect(replayed?.issues).toEqual(ack.issues);
    // Not vacuous: the rows that *did* apply carry an empty list, so "marked"
    // is a distinction and not a constant.
    expect(page.entries.filter((entry) => entry.issues.length === 0).length).toBeGreaterThan(0);
  });

  it('marks a refused row for a cold reader on an instance that never appended it', async () => {
    /**
     * The catch-up path's real question. `issuesFor` reads `CoreState.issues`,
     * which is the fold's own record — so an instance serving a `since` page for
     * rows *another* instance committed has to have folded them before it can
     * say whether they applied. `catchUpPage` folds through the page it just
     * read, and refuses to serve rows it has not folded rather than reporting
     * them clean.
     *
     * Mutation: delete the `foldThrough` call in `catchUpPage`. This instance
     * has folded nothing, so every entry comes back with `issues: []` — a
     * silent fail-open, and exactly the shape the durable-column alternative
     * would have had permanently.
     */
    /**
     * Hydrated **first**, and with its reconciler pushed out of the way.
     *
     * Both matter. Starting it after the append would have it fold the row
     * during `hydrate`, and leaving the 200 ms reconcile timer running would
     * have it fold the row on the next tick — either way the fold in
     * `catchUpPage` would be a no-op and removing it would change nothing.
     * `lastSeq` on this instance has to still be behind the page it is asked
     * for, which is the only state in which the question has an answer.
     */
    const other = await startTestServer(handle, { reconcileIntervalMs: 600_000 });
    const before = other.ledger.lastSeq();

    const mallory = await connect(room.people.mallory as string);
    await mallory.subscribe(room.roomId);
    const proposalId = await stage(mallory, {
      type: 'commitment',
      payload: {
        statement: 'Victim will work through the holidays',
        owner: room.people.victim as string,
        status: 'open',
      },
      confidence: 1,
      provenance: [],
      quote: null,
      interpretationId: null,
    });
    const ack = await mallory.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
    });
    if (ack.type !== 'ack') throw new Error('expected an ack');

    try {
      // The premise, asserted rather than assumed: this instance has not seen
      // the rows it is about to be asked for.
      expect(other.ledger.lastSeq()).toBe(before);
      expect(other.ledger.lastSeq()).toBeLessThan(ack.seq ?? 0);

      const page = await other.ledger.catchUpPage(room.roomId, 0);
      const entry = page.entries.find((row) => row.event.id === ack.eventId);
      expect(entry?.issues).toEqual(ack.issues);
    } finally {
      await other.close();
    }
  });
});
