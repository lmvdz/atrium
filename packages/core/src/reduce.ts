import type { z } from 'zod';
import type { CoreEvent } from './events.js';
import {
  type AcceptedObject,
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
} from './objects.js';
import { relationShapeError } from './relations.js';
import {
  type CoreState,
  emptyState,
  type ObjectRecord,
  type ProposalRecord,
  type ReducerIssue,
} from './state.js';

/**
 * The deterministic reducer.
 *
 * Contract:
 *  - Pure. No clock, no randomness, no I/O. Given the same events it returns a
 *    state that serializes byte-identically, on any machine, in any order of
 *    arrival — events are canonically ordered by `(at, id)` before folding.
 *  - Total. A malformed or unapplicable event never throws; it lands in
 *    `state.issues` so replay of a real log can never wedge.
 *  - Append-only. Corrections and supersessions change *status*, never history:
 *    the prior value is written to `state.corrections` and the object stays.
 */
export function reduce(events: readonly CoreEvent[], initial?: CoreState): CoreState {
  const state = initial ? cloneState(initial) : emptyState();
  for (const event of orderEvents(events)) {
    applyEvent(state, event);
  }
  return state;
}

/**
 * Canonical event order: ascending timestamp, ties broken by event id. Two
 * nodes handed the same set in different orders reduce to the same state.
 */
export function orderEvents(events: readonly CoreEvent[]): CoreEvent[] {
  return [...events].sort((a, b) => (a.at === b.at ? compare(a.id, b.id) : compare(a.at, b.at)));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Structural clone. Hand-rolled rather than `structuredClone` so this package
 * depends on nothing beyond the ECMAScript standard library — it must run
 * unchanged in Node, in a worker, and in the browser.
 */
function cloneState(state: CoreState): CoreState {
  return deepClone(state) as CoreState;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) out[key] = deepClone(source[key]);
    return out as T;
  }
  return value;
}

function fail(state: CoreState, eventId: string, reason: string): void {
  const issue: ReducerIssue = { eventId, reason };
  state.issues.push(issue);
}

function applyEvent(state: CoreState, event: CoreEvent): void {
  if (state.appliedEventIds.includes(event.id)) {
    fail(state, event.id, 'duplicate event id — already applied');
    return;
  }

  switch (event.type) {
    case 'proposal_recorded': {
      if (state.proposals[event.proposal.id]) {
        fail(state, event.id, `proposal "${event.proposal.id}" already recorded`);
        return;
      }
      const record: ProposalRecord = {
        proposal: event.proposal,
        status: event.proposal.status,
        acceptedObjectId: null,
        rejectedReason: null,
      };
      state.proposals[event.proposal.id] = record;
      break;
    }

    case 'proposal_rejected': {
      const record = state.proposals[event.proposalId];
      if (!record) {
        fail(state, event.id, `unknown proposal "${event.proposalId}"`);
        return;
      }
      if (record.status === 'accepted') {
        fail(state, event.id, `proposal "${event.proposalId}" was already accepted`);
        return;
      }
      record.status = 'rejected';
      record.rejectedReason = event.reason;
      break;
    }

    case 'object_accepted': {
      const { object } = event;
      if (state.objects[object.id]) {
        fail(state, event.id, `object "${object.id}" already accepted`);
        return;
      }
      const record: ObjectRecord = {
        object,
        acceptedAt: event.at,
        updatedAt: event.at,
        revision: 0,
        retractedAt: null,
        supersededById: null,
      };
      state.objects[object.id] = record;

      const proposalId = object.provenance.proposalId;
      if (proposalId) {
        const proposal = state.proposals[proposalId];
        if (proposal) {
          proposal.status = 'accepted';
          proposal.acceptedObjectId = object.id;
        }
      }
      break;
    }

    case 'object_corrected': {
      const record = state.objects[event.objectId];
      if (!record) {
        fail(state, event.id, `unknown object "${event.objectId}"`);
        return;
      }

      if (event.action === 'retract') {
        if (record.retractedAt !== null) {
          fail(state, event.id, `object "${event.objectId}" is already retracted`);
          return;
        }
        state.corrections.push({
          eventId: event.id,
          objectId: record.object.id,
          action: 'retract',
          before: { retracted: false },
          after: { retracted: true },
          actor: event.actor,
          note: event.note,
          at: event.at,
        });
        record.retractedAt = event.at;
        record.updatedAt = event.at;
        record.revision += 1;
        return;
      }

      if (event.action === 'restore') {
        if (record.retractedAt === null) {
          fail(state, event.id, `object "${event.objectId}" is not retracted`);
          return;
        }
        state.corrections.push({
          eventId: event.id,
          objectId: record.object.id,
          action: 'restore',
          before: { retracted: true },
          after: { retracted: false },
          actor: event.actor,
          note: event.note,
          at: event.at,
        });
        record.retractedAt = null;
        record.updatedAt = event.at;
        record.revision += 1;
        return;
      }

      const patched = applyPayloadPatch(record.object, event.patch);
      if (!patched.ok) {
        fail(state, event.id, `invalid amendment to "${event.objectId}": ${patched.error}`);
        return;
      }
      state.corrections.push({
        eventId: event.id,
        objectId: record.object.id,
        action: 'amend',
        before: patched.before,
        after: patched.after,
        actor: event.actor,
        note: event.note,
        at: event.at,
      });
      record.object = { ...patched.object, updatedAt: event.at };
      record.updatedAt = event.at;
      record.revision += 1;
      break;
    }

    case 'relation_added': {
      const { relation } = event;
      if (state.relations.some((existing) => existing.id === relation.id)) {
        fail(state, event.id, `relation "${relation.id}" already exists`);
        return;
      }
      const shapeError = relationShapeError(relation);
      if (shapeError) {
        fail(state, event.id, shapeError);
        return;
      }
      const from = state.objects[relation.fromObjectId];
      if (!from) {
        fail(state, event.id, `unknown source object "${relation.fromObjectId}"`);
        return;
      }
      if (relation.to.kind === 'object' && !state.objects[relation.to.objectId]) {
        fail(state, event.id, `unknown target object "${relation.to.objectId}"`);
        return;
      }

      state.relations.push(relation);

      // Structural side effects. Status flips only — nothing is removed.
      if (relation.kind === 'supersedes' && relation.to.kind === 'object') {
        const target = state.objects[relation.to.objectId];
        if (target) {
          target.supersededById = relation.fromObjectId;
          target.updatedAt = event.at;
          if (target.object.type === 'decision') {
            target.object = {
              ...target.object,
              payload: { ...target.object.payload, status: 'superseded' },
              updatedAt: event.at,
            };
          }
        }
      }

      if (relation.kind === 'answers' && from.object.type === 'open_question') {
        from.object = {
          ...from.object,
          payload: { ...from.object.payload, status: 'answered' },
          updatedAt: event.at,
        };
        from.updatedAt = event.at;
      }
      break;
    }

    default: {
      const exhaustive: never = event;
      fail(state, (exhaustive as CoreEvent).id, 'unknown event type');
      return;
    }
  }

  state.appliedEventIds.push(event.id);
}

type PatchResult =
  | { ok: true; object: AcceptedObject; before: unknown; after: unknown }
  | { ok: false; error: string };

/**
 * Merges a partial patch into an object's payload and re-validates it against
 * that type's schema. An amendment that would produce an invalid object is
 * rejected outright rather than half-applied.
 */
function applyPayloadPatch(object: AcceptedObject, patch: Record<string, unknown>): PatchResult {
  const merged = { ...object.payload, ...patch };
  switch (object.type) {
    case 'decision':
      return finish(object, DecisionPayload.safeParse(merged));
    case 'commitment':
      return finish(object, CommitmentPayload.safeParse(merged));
    case 'open_question':
      return finish(object, OpenQuestionPayload.safeParse(merged));
    case 'claim':
      return finish(object, ClaimPayload.safeParse(merged));
    case 'objective':
      return finish(object, ObjectivePayload.safeParse(merged));
    default: {
      const exhaustive: never = object;
      return { ok: false, error: `unknown object type ${JSON.stringify(exhaustive)}` };
    }
  }
}

function finish<T extends AcceptedObject>(
  object: T,
  parsed: z.ZodSafeParseResult<T['payload']>,
): PatchResult {
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map(describeIssue).join('; ') };
  }
  return {
    ok: true,
    object: { ...object, payload: parsed.data } as AcceptedObject,
    before: object.payload,
    after: parsed.data,
  };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
