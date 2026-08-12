import { type Actor, actorUserId } from '@atrium/core';
import { actorKind } from '@atrium/db/schema';
import { describe, expect, it } from 'vitest';
import { actorFromColumns, actorToColumns } from '../src/ledger.js';

/**
 * The actor, from the session to the two columns and back.
 *
 * There is one derivation of the trusted actor (`commands.ts`'s `actorOf`) and
 * one pair of functions that puts it in the ledger's columns and reads it out
 * again. Between them they decide what every certification gate in
 * `@atrium/core` sees, so the properties worth pinning are the ones that would
 * be invisible if they broke: a kind that changes on the way through, a kind
 * that the database can spell and this code cannot, and an id that survives the
 * round trip attached to the wrong discriminant.
 *
 * `actorOf` itself is a closure inside `createCommandService` and is proven
 * end-to-end, against a real session and a real database, in
 * `integration/server/agent-principal.test.ts` — the only place the claim "the
 * kind the session carried is the kind the row holds" can actually be made.
 */

const SAMPLES: readonly Actor[] = [
  { kind: 'human', userId: '11111111-1111-4111-8111-111111111111' },
  { kind: 'agent', userId: '22222222-2222-4222-8222-222222222222' },
  { kind: 'model', model: 'claude-opus-4.6' },
  { kind: 'system' },
];

describe('the ledger’s two actor columns', () => {
  it('round-trips every kind the enum can hold, discriminant included', () => {
    // Enumerated from the DATABASE's enum rather than from a list here: the
    // column is what a replay reads, so a kind Postgres can store and this file
    // has never heard of is a row `actorFromColumns` throws on mid-replay. This
    // is the assertion that fails in the same commit as a migration that adds a
    // value without a case.
    const covered = new Set(SAMPLES.map((actor) => actor.kind));
    expect([...covered].sort()).toEqual([...actorKind.enumValues].sort());

    for (const actor of SAMPLES) {
      const columns = actorToColumns(actor);
      expect(columns.kind).toBe(actor.kind);
      expect(actorFromColumns(columns.kind, columns.id)).toEqual(actor);
    }
  });

  it('gives an agent the same column shape as a human and keeps them distinct', () => {
    // The pair of facts the rest of the system rests on. SAME: `actor_id` holds
    // a user id for both, which is what lets an agent be a member, an attention
    // target and an author by the id `memberships` already uses. DISTINCT: the
    // kind survives, which is what `isHuman` reads.
    //
    // Catches: `actorToColumns` mapping `agent` to `{ kind: 'human' }` — a
    // one-word slip that no round-trip over a single kind would notice, and that
    // would write an agent's history as a person's.
    const agent = { kind: 'agent', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as const;
    const human = { kind: 'human', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as const;

    expect(actorToColumns(agent).id).toBe(actorToColumns(human).id);
    expect(actorToColumns(agent).kind).not.toBe(actorToColumns(human).kind);
    expect(actorFromColumns('agent', agent.userId)).not.toEqual(human);
  });

  it('reads an id off both identified kinds and off neither anonymous one', () => {
    // `actorUserId` is the "does this actor have an identity?" question, which is
    // NOT the "is this actor a person?" question. They gave the same answer for
    // every kind that existed before `agent` did, which is exactly why a call
    // site that conflated them would have been correct until now.
    expect(SAMPLES.map(actorUserId)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      null,
      null,
    ]);
  });

  it('refuses a kind the ledger holds and this code does not know', () => {
    // Guessing would fold the row under an actor nobody chose. The `''` fallback
    // for a missing id is deliberate and different: a NULL id on an identified
    // kind is a row the CHECK constraint cannot exist, and an empty user id
    // matches no membership, so it refuses downstream rather than here.
    expect(() => actorFromColumns('robot', 'x')).toThrow(/unknown value "robot"/);
  });
});
