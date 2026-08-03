import {
  type AcceptanceDecision,
  acceptedObjectRef,
  decideAcceptance,
  type EscalationTriggerKind,
  evaluateEscalation,
  isType,
  objectStatement,
  Proposal,
  type ProvenanceMessage,
  type ProvenanceProblem,
  rejectingProblems,
  statementBearing,
  validateProposalProvenance,
} from '@atrium/core';
import type { Database } from '@atrium/db';
import { interpretations, messages } from '@atrium/db/schema';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { reconcileStoredAttention } from '../attention-projection.js';
import { objectFromProposal } from '../commands.js';
import { CommandError, type Ledger } from '../ledger.js';
import type { Logger } from '../logger.js';
import { projectRoomEvent } from '../projections.js';
import type { RoomEvent } from '../room-events.js';
import { type ExtractedReading, mintProposal } from './extraction.js';
import { assemblePrompt } from './prompt.js';
import {
  type InterpretationProvider,
  MalformedModelOutputError,
  type ModelRouting,
} from './provider.js';

/**
 * The interpretation worker (#23) — one pass over everything a room has said
 * that nobody has read yet.
 *
 * ## The shape, and why each piece is where it is
 *
 * 1. **Claim.** Every message this run will read gets a row in
 *    `interpretations` first, keyed `(message_id, interpretation_version)`. The
 *    unique index on that pair is the idempotency mechanism: a second worker
 *    racing on the same room claims nothing, and a *retry* of this run finds
 *    its own rows still `pending` and reuses them — same interpretation id,
 *    therefore the same content-addressed proposal ids, therefore a
 *    `proposal_recorded` the reducer refuses as already recorded. Zero
 *    duplicates across retries is a consequence of those two facts, not a
 *    check somebody remembered to write.
 * 2. **Route.** The tier is chosen from the raw text, before any call —
 *    `evaluateEscalation` in `packages/core`. #8's original triggers read off
 *    the default pass's own output and the spike measured them firing 0/6
 *    times, so they were replaced with deterministic pre-call ones. Choosing
 *    the tier before the call is also what keeps a burst to *one* provider
 *    call: there is no "call the cheap model, then maybe call the dear one".
 * 3. **One call.** The whole drained window goes in one prompt. That is the
 *    coalescing bar: twelve messages in a burst cost one call.
 * 4. **Judge.** `validateProposalProvenance` then `decideAcceptance`, both from
 *    `packages/core`. Nothing in this file re-implements either.
 * 5. **Append.** Through `ledger.append`, the same seam the socket layer uses,
 *    so the receipt window, the actor rules and the projections are the ones
 *    the rest of the system already has.
 * 6. **Settle.** The interpretation rows move to `succeeded`, and if a message
 *    arrived while the run was in flight a follow-up job is enqueued into the
 *    *next* coalescing slot rather than dropped.
 *
 * ## What this file may never do
 *
 * Render anything as a person's words that they did not write (#10). Every
 * proposal that leaves here carries a quote checked against a cited message
 * with reply-blockquotes stripped, and a claimant or owner resolved to an
 * actual author id in the window — a name the model invented is refused in
 * `mintProposal`, not renamed into something plausible.
 */

/* ── job payload ────────────────────────────────────────────────────────── */

/**
 * The job is per **room**, not per message.
 *
 * #8's coalescing decision: `singletonKey = room` with a ~10s window, and the
 * worker drains every uninterpreted message the room has. A per-message job
 * would be one provider call per message, which is the cost profile the whole
 * queue design exists to avoid — and it would hand the reducer input in
 * arrival order rather than room order.
 */
export interface InterpretRoomJob {
  roomId: string;
}

/* ── configuration ──────────────────────────────────────────────────────── */

export interface InterpretConfig {
  /** Most messages one pass will read. A backlog drains over several passes. */
  maxWindowMessages: number;
  /**
   * How many already-interpreted messages precede the window.
   *
   * Two jobs: the escalation triggers need earlier messages to recognise a
   * reply-blockquote *of an earlier room message*, and the acceptance window
   * has to be the room in order rather than a slice starting at the first
   * unread line.
   */
  contextMessagesBefore: number;
}

export const DEFAULT_INTERPRET_CONFIG: InterpretConfig = Object.freeze({
  maxWindowMessages: 50,
  contextMessagesBefore: 25,
});

export interface InterpretDeps {
  db: Database;
  ledger: Ledger;
  provider: InterpretationProvider;
  routing: ModelRouting;
  logger: Logger;
  config?: InterpretConfig;
  /**
   * Enqueue a follow-up pass for this room, into the next coalescing slot.
   *
   * Supplied by `queue.ts`. Optional so a test can run the job without a queue
   * — but its absence is logged, because a run that finds leftovers and cannot
   * schedule the next pass has left messages uninterpreted with nothing to wake
   * anybody up.
   */
  enqueueFollowUp?: (roomId: string) => Promise<void>;
  /** Notify live readers after attention reconciliation has committed. */
  onProjectionChanged?: (roomId: string) => void | Promise<void>;
}

/* ── result ─────────────────────────────────────────────────────────────── */

/** Why a reading did not become a `~` in the room. */
export interface RejectedReading {
  reason: string;
  detail: string;
  reading?: ExtractedReading;
  problems?: ProvenanceProblem[];
  decision?: AcceptanceDecision;
}

export interface InterpretRunResult {
  roomId: string;
  /** Empty when the room had nothing unread — no provider call was made. */
  messageIds: string[];
  interpretationIds: string[];
  tier: 'default' | 'escalation';
  model: string;
  triggers: EscalationTriggerKind[];
  providerCalls: number;
  proposalsRecorded: string[];
  /** Proposals that reached accepted state in this pass. */
  objectsAccepted: string[];
  /** Prior-version proposals this run contradicted and retired. */
  proposalsSuperseded: string[];
  /** Readings identical to a still-open proposal from an earlier version. */
  unchanged: number;
  rejected: RejectedReading[];
  /** Messages that arrived while the run was in flight. */
  leftover: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/* ── the job ────────────────────────────────────────────────────────────── */

interface Candidate {
  message: ProvenanceMessage;
  seq: number;
  interpretationId: string;
  interpretationVersion: number;
  /** Prior interpretation ids for this message, newest first. */
  priorInterpretationIds: string[];
}

export async function runInterpretation(
  deps: InterpretDeps,
  job: InterpretRoomJob,
): Promise<InterpretRunResult> {
  const config = deps.config ?? DEFAULT_INTERPRET_CONFIG;
  const { roomId } = job;

  const claimed = await claimWindow(deps.db, roomId, config);
  if (claimed.length === 0) {
    return empty(roomId, deps.routing.default);
  }

  const context = await readContext(deps.db, roomId, claimed, config);
  const window = claimed.map((candidate) => candidate.message);
  const priorMessages = context.filter(
    (message) => !window.some((drained) => drained.id === message.id),
  );

  const state = deps.ledger.coreState();
  const acceptedRefs = Object.values(state.objects)
    .filter((record) => record.object.roomId === roomId)
    .map((record) => acceptedObjectRef(record));
  const acceptedDecisions = Object.values(state.objects)
    .filter((record) => record.object.roomId === roomId && isType(record.object, 'decision'))
    .map((record) => ({
      objectId: record.object.id,
      statement: objectStatement(record.object) ?? '',
    }));

  // Deterministic, pre-call, computed on the raw text. Nothing in it reads a
  // model's self-report — see `escalation.ts` and #8's amendment.
  const verdict = evaluateEscalation({ messages: window, priorMessages, acceptedDecisions });
  const tier = verdict.escalate ? 'escalation' : 'default';
  const model = verdict.escalate ? deps.routing.escalation : deps.routing.default;

  const prompt = assemblePrompt({ messages: window, state });
  const startedAt = new Date().toISOString();
  await markStarted(deps.db, claimed, model, startedAt);

  deps.logger.info('interpretation pass starting', {
    roomId,
    messages: window.length,
    tier,
    model,
    triggers: verdict.kinds,
    counterexamples: prompt.counterexampleCount,
  });

  let result: Awaited<ReturnType<InterpretationProvider['generate']>>;
  try {
    result = await deps.provider.generate({
      model,
      system: prompt.system,
      prompt: prompt.prompt,
    });
  } catch (error) {
    // The rows stay `pending`, deliberately: pg-boss will retry this job, the
    // next drain finds the same rows and reuses the same interpretation ids,
    // and nothing partial was written. Only the dead-letter handler moves them
    // to `failed`, because only it knows the retries are done.
    if (error instanceof MalformedModelOutputError) {
      deps.logger.warn('interpretation output malformed — retrying', {
        roomId,
        model,
        error: error.message,
      });
    }
    throw error;
  }

  const run: InterpretRunResult = {
    roomId,
    messageIds: window.map((message) => message.id),
    interpretationIds: claimed.map((candidate) => candidate.interpretationId),
    tier,
    model: result.model,
    triggers: verdict.kinds,
    providerCalls: 1,
    proposalsRecorded: [],
    objectsAccepted: [],
    proposalsSuperseded: [],
    unchanged: 0,
    rejected: [],
    leftover: 0,
    costUsd: result.usage.costUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };

  const priorProposals = collectPriorProposals(deps, roomId, claimed);

  for (const reading of result.output.readings) {
    const candidate = candidateFor(reading, claimed);
    if (candidate === null) {
      run.rejected.push({
        reason: 'uncited',
        detail: `cites no message this pass drained (${reading.messageIds.join(', ') || 'nothing'})`,
        reading,
      });
      continue;
    }

    const minted = mintProposal(reading, {
      roomId,
      interpretationId: candidate.interpretationId,
      model: result.model,
      createdAt: startedAt,
      messages: context,
    });
    if (!minted.ok) {
      run.rejected.push({ reason: 'unmintable', detail: minted.problem.reason, reading });
      continue;
    }

    const parsed = Proposal.safeParse(minted.proposal);
    if (!parsed.success) {
      run.rejected.push({
        reason: 'schema',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
        reading,
      });
      continue;
    }
    const proposal = parsed.data;

    const problems = validateProposalProvenance(
      {
        type: proposal.type,
        provenance: proposal.provenance,
        quote: proposal.quote,
        proposer: proposal.proposer,
        attributedTo: attributedTo(proposal),
        statement: statementOf(proposal),
      },
      context,
    );
    /**
     * `reject`, and only `reject`.
     *
     * `packages/core` grades a provenance problem three ways and the grades
     * mean different things to a worker. A `reject` is a statement about the
     * words — the quote is not in the message, it only exists inside somebody
     * else's reply-blockquote, the person named authored nothing — and a
     * reading that fails one is not a reading, so it is dropped and never
     * reaches the room. A `refer` is "a person has to look at this", which is
     * exactly what a `~` is *for*: dropping those would delete the proposal
     * instead of surfacing it, and on this branch every proposal citing the
     * newest message in its window earns one (`superseded_by_later_message`,
     * the #86 contradiction). `decideAcceptance` reads the same problems and
     * turns a `refer` into `pending / quiet`, which is the correct destination.
     *
     * Using `blockingProblems` here — everything that is not `reclassify` —
     * silently merges the two, and the symptom is a room with no readings at
     * all rather than a room with readings nobody has confirmed.
     */
    const fatal = rejectingProblems(problems);
    if (fatal.length > 0) {
      run.rejected.push({
        reason: 'provenance',
        detail: fatal.map((problem) => `${problem.kind}: ${problem.detail}`).join(' | '),
        reading,
        problems: fatal,
      });
      continue;
    }

    /**
     * What this reading is a re-reading *of*.
     *
     * Two prior readings drawn from the same message are not the same reading —
     * one message routinely yields several — so "overlapping citation" alone
     * would have every new reading retire every old one from that message. What
     * identifies a reading is **the sentence it rests on**, and the quote is the
     * only thing that names that sentence.
     *
     * The type is deliberately *not* part of this predicate. A re-read that
     * turns yesterday's claim into a decision is the canonical correction (#5
     * gave it a verb — `retype`), and it is a contradiction of the earlier
     * reading rather than an addition to it. Requiring the types to match would
     * leave both on screen, disagreeing, with nothing marking either as stale.
     */
    const sameSentence = priorProposals.filter(
      (prior) =>
        prior.provenance.some((id) => proposal.provenance.includes(id)) &&
        sameStatement(prior.quote, proposal.quote),
    );

    // The same sentence read the same way is a re-derivation, not a
    // contradiction. Record nothing and retire nothing: the spike measured two
    // identical runs sharing only ~45% of their objects, so "the new run did
    // not mention it" is not evidence against a prior reading.
    if (
      sameSentence.some(
        (prior) =>
          prior.type === proposal.type && sameStatement(prior.statement, statementOf(proposal)),
      )
    ) {
      run.unchanged += 1;
      continue;
    }

    const decision = decideAcceptance(proposal, {
      messages: context,
      acceptedObjects: acceptedRefs,
    });
    if (decision.verdict === 'discard' && decision.about === 'the_reading') {
      run.rejected.push({
        reason: `acceptance:${decision.rule}`,
        detail: decision.reason,
        reading,
        decision,
      });
      continue;
    }

    /**
     * A retry landing on its own earlier work.
     *
     * The reducer would refuse the duplicate on its own — that is the guarantee
     * the content-addressed id buys — but it refuses it as `applied_with_issue`,
     * which still writes a ledger row that changes nothing. Rows are history and
     * history is replayed (#25), so a room that crashed once would replay with a
     * second `proposal_recorded` for a proposal it already had. Checking the
     * fold first makes the retry silent instead of merely harmless; the
     * reducer's refusal stays underneath as the backstop for the case this
     * cannot see, which is another instance recording it between these lines.
     */
    const alreadyRecorded = deps.ledger.coreState().proposals[proposal.id];
    if (alreadyRecorded) {
      deps.logger.debug('proposal already recorded — retry landing on its own work', {
        roomId,
        proposalId: proposal.id,
      });
      run.proposalsRecorded.push(proposal.id);
    } else {
      const appended = await deps.ledger.append<RoomEvent>({
        roomId,
        actor: { kind: 'model', model: result.model },
        build: ({ id, at }) => ({ id, at, type: 'proposal_recorded', proposal }),
        project: (ctx) => projectRoomEvent(ctx),
      });
      if (appended.issues.length > 0) {
        run.rejected.push({
          reason: 'proposal_refused',
          detail: appended.issues.join(' | '),
          reading,
          decision,
        });
        deps.logger.warn('proposal recorded no reading — the reducer refused it', {
          roomId,
          proposalId: proposal.id,
          issues: appended.issues,
        });
        continue;
      }
      run.proposalsRecorded.push(proposal.id);
    }

    // Everything this run contradicts: a still-open reading of the same
    // sentence that now says something else. Only these — a prior reading the
    // new run simply did not re-derive keeps its `~`.
    for (const prior of sameSentence) {
      if (run.proposalsSuperseded.includes(prior.id)) continue;
      const appended = await deps.ledger.append<RoomEvent>({
        roomId,
        actor: { kind: 'model', model: result.model },
        build: ({ id, at }) => ({
          id,
          at,
          type: 'proposal_superseded',
          proposalId: prior.id,
          supersededByProposalId: proposal.id,
          reason: `re-interpreted at version ${candidate.interpretationVersion}: the same sentence now reads differently`,
        }),
        project: (ctx) => projectRoomEvent(ctx),
      });
      if (appended.issues.length > 0) {
        deps.logger.warn('supersession took no effect', {
          roomId,
          proposalId: prior.id,
          issues: appended.issues,
        });
        continue;
      }
      run.proposalsSuperseded.push(prior.id);
    }

    // Same reason as the `proposal_recorded` check above: a retry must not
    // re-append an acceptance the first attempt already landed.
    if (decision.verdict !== 'auto_accept' || alreadyRecorded?.status === 'accepted') continue;

    try {
      const accepted = await deps.ledger.append<RoomEvent>({
        roomId,
        actor: { kind: 'model', model: result.model },
        build: ({ id, at }) => ({
          id,
          at,
          type: 'object_accepted',
          object: objectFromProposal(proposal, null, at),
        }),
        project: (ctx) => projectRoomEvent(ctx),
      });
      /**
       * **`append` returning is not the reducer having applied it.**
       *
       * The ledger throws for `rejected` and `malformed`, and it does NOT throw
       * for `applied_with_issue` — a *business* refusal writes its row, fans it
       * out marked, and changes no state (see `LedgerEntry.issues`). The first
       * draft of this block read the event back off the `AppendResult` and
       * counted the object, which is a value that exists on a refused append
       * too. So `objectsAccepted` reported acceptances that had not happened:
       * `core_events` held an `object_accepted` row, `accepted_objects` held
       * nothing, and the run said one object was accepted.
       *
       * That is the exact shape of the failure this codebase keeps finding —
       * "the append returned" standing in for "the fold took it". `issues` is
       * the fold's own record and is the only thing that answers it.
       */
      if (appended(accepted) && accepted.event.type === 'object_accepted') {
        run.objectsAccepted.push(accepted.event.object.id);
      } else {
        run.rejected.push({
          reason: 'acceptance_refused',
          detail: accepted.issues.join(' | '),
          reading,
          decision,
        });
        deps.logger.warn('auto-acceptance took no effect — the reducer refused it', {
          roomId,
          proposalId: proposal.id,
          rule: decision.rule,
          issues: accepted.issues,
        });
      }
    } catch (error) {
      // A refused acceptance is not a failed job. The proposal is recorded and
      // renders as `~`; a person can still accept it. Failing the whole pass
      // here would put a room's readings behind a retry loop over a decision
      // the engine has already made and stated.
      if (error instanceof CommandError) {
        run.rejected.push({
          reason: 'acceptance_refused',
          detail: error.message,
          reading,
          decision,
        });
        deps.logger.warn('auto-acceptance refused by the ledger', {
          roomId,
          proposalId: proposal.id,
          rule: decision.rule,
          error: error.message,
        });
      } else {
        throw error;
      }
    }
  }

  await markSucceeded(deps.db, claimed, result.raw);

  const attention = await reconcileStoredAttention({
    db: deps.db,
    state: deps.ledger.coreState(),
    roomId,
    messages: context,
    now: startedAt,
  });
  if (attention.refusals.length > 0) {
    deps.logger.warn('attention projection refused evidence in this worker window', {
      roomId,
      refusals: attention.refusals,
    });
  }
  await deps.onProjectionChanged?.(roomId);

  run.leftover = await countUninterpreted(deps.db, roomId);
  if (run.leftover > 0) {
    if (deps.enqueueFollowUp) {
      await deps.enqueueFollowUp(roomId);
    } else {
      deps.logger.warn('messages left uninterpreted and no follow-up scheduler is wired', {
        roomId,
        leftover: run.leftover,
      });
    }
  }

  deps.logger.info('interpretation pass complete', {
    roomId,
    messages: run.messageIds.length,
    tier,
    model: run.model,
    proposals: run.proposalsRecorded.length,
    accepted: run.objectsAccepted.length,
    superseded: run.proposalsSuperseded.length,
    rejected: run.rejected.length,
    leftover: run.leftover,
    costUsd: run.costUsd,
  });

  return run;
}

function empty(roomId: string, model: string): InterpretRunResult {
  return {
    roomId,
    messageIds: [],
    interpretationIds: [],
    tier: 'default',
    model,
    triggers: [],
    providerCalls: 0,
    proposalsRecorded: [],
    objectsAccepted: [],
    proposalsSuperseded: [],
    unchanged: 0,
    rejected: [],
    leftover: 0,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
  };
}

/* ── claiming ───────────────────────────────────────────────────────────── */

/**
 * A row of the drain query.
 *
 * The aliases in that query are **quoted camelCase on purpose**. `db.execute`
 * hands back the driver's own rows, so column names arrive exactly as Postgres
 * spelled them — an unquoted `AS interpretation_id` folds to `interpretation_id`
 * and every read of `row.interpretationId` is `undefined`. TypeScript cannot
 * catch it, because the cast on the query is the only thing that gives these
 * rows a type at all; the symptom is a claim carrying `undefined` for an id,
 * which reaches the driver as a parameter it refuses.
 */
interface PendingRow {
  id: string;
  seq: number;
  authorId: string | null;
  body: string;
  interpretationId: string | null;
  interpretationVersion: number | null;
  interpretationStatus: string | null;
}

/**
 * The messages this pass owns, each with an `interpretations` row to its name.
 *
 * A message is unread when it has no interpretation row at all, or when its
 * newest one is still `pending` — which covers three cases with one predicate:
 * never interpreted, a run that crashed mid-pass, and a re-interpretation
 * somebody staged by inserting the next version (see `scheduleReinterpretation`
 * in `queue.ts`). A `failed` row is deliberately *not* unread: it has been
 * through the retries and the dead-letter, and re-draining it forever is how a
 * poison message becomes an unbounded bill.
 */
async function claimWindow(
  db: Database,
  roomId: string,
  config: InterpretConfig,
): Promise<Candidate[]> {
  const rows = (await db.execute(sql`
    SELECT m.id            AS id,
           m.seq           AS seq,
           m.author_id     AS "authorId",
           m.body          AS body,
           i.id            AS "interpretationId",
           i.interpretation_version AS "interpretationVersion",
           i.status::text  AS "interpretationStatus"
      FROM messages m
      LEFT JOIN LATERAL (
        SELECT x.id, x.interpretation_version, x.status
          FROM interpretations x
         WHERE x.message_id = m.id
         ORDER BY x.interpretation_version DESC
         LIMIT 1
      ) i ON TRUE
     WHERE m.room_id = ${roomId}::uuid
       AND (i.id IS NULL OR i.status = 'pending')
     ORDER BY m.seq ASC
     LIMIT ${config.maxWindowMessages}
  `)) as unknown as PendingRow[];

  if (rows.length === 0) return [];

  const claimed: Candidate[] = [];
  const unclaimed = rows.filter((row) => row.interpretationId === null);

  const minted = new Map<string, { id: string; version: number }>();
  if (unclaimed.length > 0) {
    // The claim, and the race resolution. `(message_id, interpretation_version)`
    // is unique, so two workers reaching here for the same room insert the same
    // pair and exactly one wins; the loser gets no row back and simply does not
    // read that message this pass. Nothing throws, and nothing is interpreted
    // twice.
    const inserted = await db
      .insert(interpretations)
      .values(unclaimed.map((row) => ({ messageId: row.id, interpretationVersion: 1 })))
      .onConflictDoNothing({
        target: [interpretations.messageId, interpretations.interpretationVersion],
      })
      .returning({ id: interpretations.id, messageId: interpretations.messageId });
    for (const row of inserted) minted.set(row.messageId, { id: row.id, version: 1 });
  }

  for (const row of rows) {
    const own =
      row.interpretationId !== null
        ? { id: row.interpretationId, version: row.interpretationVersion ?? 1 }
        : minted.get(row.id);
    if (!own) continue;
    claimed.push({
      message: { id: row.id, authorId: row.authorId ?? '', body: row.body },
      seq: Number(row.seq),
      interpretationId: own.id,
      interpretationVersion: own.version,
      priorInterpretationIds: [],
    });
  }

  await attachPriorVersions(db, claimed);
  return claimed;
}

/** Earlier interpretation runs of the same messages — the supersession input. */
async function attachPriorVersions(db: Database, claimed: Candidate[]): Promise<void> {
  const bumped = claimed.filter((candidate) => candidate.interpretationVersion > 1);
  if (bumped.length === 0) return;
  const rows = await db
    .select({
      id: interpretations.id,
      messageId: interpretations.messageId,
      version: interpretations.interpretationVersion,
    })
    .from(interpretations)
    .where(
      inArray(
        interpretations.messageId,
        bumped.map((candidate) => candidate.message.id),
      ),
    );
  for (const candidate of bumped) {
    candidate.priorInterpretationIds = rows
      .filter(
        (row) =>
          row.messageId === candidate.message.id && row.version < candidate.interpretationVersion,
      )
      .sort((a, b) => b.version - a.version)
      .map((row) => row.id);
  }
}

/**
 * The room in order around the window.
 *
 * This is `AcceptanceContext.messages` and the escalation triggers' history in
 * one read. It deliberately continues **past** the drained messages: a window
 * that ends at the newest citation cannot answer whether a later message took
 * the sentence back, and `packages/core` refuses to certify one that does
 * (`laterRevision`, `window_ends_at_the_citations`).
 */
async function readContext(
  db: Database,
  roomId: string,
  claimed: readonly Candidate[],
  config: InterpretConfig,
): Promise<ProvenanceMessage[]> {
  const first = Math.min(...claimed.map((candidate) => candidate.seq));
  const from = Math.max(0, first - config.contextMessagesBefore);
  const rows = await db
    .select({ id: messages.id, authorId: messages.authorId, body: messages.body })
    .from(messages)
    .where(and(eq(messages.roomId, roomId), gte(messages.seq, from)))
    .orderBy(asc(messages.seq))
    .limit(config.contextMessagesBefore + config.maxWindowMessages * 2);
  return rows.map((row) => ({ id: row.id, authorId: row.authorId ?? '', body: row.body }));
}

async function markStarted(
  db: Database,
  claimed: readonly Candidate[],
  model: string,
  at: string,
): Promise<void> {
  await db
    .update(interpretations)
    .set({ model, startedAt: new Date(at) })
    .where(
      inArray(
        interpretations.id,
        claimed.map((candidate) => candidate.interpretationId),
      ),
    );
}

async function markSucceeded(
  db: Database,
  claimed: readonly Candidate[],
  raw: unknown,
): Promise<void> {
  await db
    .update(interpretations)
    .set({ status: 'succeeded', raw, completedAt: new Date(), error: null })
    .where(
      inArray(
        interpretations.id,
        claimed.map((candidate) => candidate.interpretationId),
      ),
    );
}

/** How many messages this room still has that nobody has read. */
export async function countUninterpreted(db: Database, roomId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n
      FROM messages m
      LEFT JOIN LATERAL (
        SELECT x.status FROM interpretations x
         WHERE x.message_id = m.id
         ORDER BY x.interpretation_version DESC LIMIT 1
      ) i ON TRUE
     WHERE m.room_id = ${roomId}::uuid
       AND (i.status IS NULL OR i.status = 'pending')
  `)) as unknown as Array<{ n: number }>;
  // Destructured rather than indexed, and not for taste. `rows` is derived from
  // a `Database` handle, and `@atrium/auth`'s room-membership boundary check
  // treats any element access on a handle-derived value with a non-string key as
  // "we could not tell what this reads" — so `rows[0]` fails that test. The
  // guard is over-broad there (a numeric literal cannot be a table name) but it
  // is another lane's, and the safe direction is to write the shape it can read.
  const [row] = rows;
  return row?.n ?? 0;
}

/**
 * Mark a room's still-pending interpretations `failed`.
 *
 * Called only from the dead-letter handler. Until then a pending row is how the
 * next retry finds its own work; flipping it on the first failure would mean a
 * retry re-claims the message under a *new* interpretation id, which is exactly
 * the duplicate-proposal path the content-addressed ids close.
 */
export async function markRoomFailed(db: Database, roomId: string, error: string): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE interpretations
       SET status = 'failed', error = ${error}, completed_at = now()
     WHERE status = 'pending'
       AND message_id IN (SELECT id FROM messages WHERE room_id = ${roomId}::uuid)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length;
}

/* ── helpers ────────────────────────────────────────────────────────────── */

interface PriorProposal {
  id: string;
  type: string;
  statement: string;
  /** The sentence it was read out of — what identifies a reading. */
  quote: string | null;
  provenance: string[];
}

/**
 * Still-open proposals from earlier interpretation runs of the messages this
 * pass is re-reading. Only these are candidates for supersession — a reading
 * from a *different* message is not something this run contradicted.
 */
function collectPriorProposals(
  deps: InterpretDeps,
  roomId: string,
  claimed: readonly Candidate[],
): PriorProposal[] {
  const priorIds = new Set(claimed.flatMap((candidate) => candidate.priorInterpretationIds));
  if (priorIds.size === 0) return [];
  const state = deps.ledger.coreState();
  return Object.values(state.proposals)
    .filter(
      (record) =>
        record.status === 'proposed' &&
        record.proposal.roomId === roomId &&
        record.proposal.interpretationId !== null &&
        priorIds.has(record.proposal.interpretationId),
    )
    .map((record) => ({
      id: record.proposal.id,
      type: record.proposal.type,
      statement: statementOf(record.proposal) ?? '',
      quote: record.proposal.quote,
      provenance: [...record.proposal.provenance],
    }));
}

/**
 * Whether the fold actually took an append, as against merely storing its row.
 *
 * One predicate, used by every append in this file, because the distinction is
 * exactly the one that is easy to lose: `ledger.append` throws only for a
 * *structural* refusal (`rejected`, `malformed`). A **business** refusal —
 * `applied_with_issue` — returns normally, writes the row, and changes nothing.
 * Anything that reads the returned event and believes the state moved is
 * reporting an effect that did not occur.
 */
function appended(result: { issues: readonly string[] }): boolean {
  return result.issues.length === 0;
}

/** The candidate whose message a reading cites, or `null` for a stray citation. */
function candidateFor(reading: ExtractedReading, claimed: readonly Candidate[]): Candidate | null {
  for (const id of reading.messageIds) {
    const match = claimed.find((candidate) => candidate.message.id === id);
    if (match) return match;
  }
  return null;
}

/** The sentence a proposal asserts — `statement`, `question` or `title`. */
function statementOf(proposal: { type: string; payload: Record<string, unknown> }): string | null {
  const payload = proposal.payload;
  for (const key of ['statement', 'question', 'title'] as const) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

/** The person a payload names, for the attribution check. */
function attributedTo(proposal: { payload: Record<string, unknown> }): string | null {
  for (const key of ['owner', 'claimant', 'decidedBy'] as const) {
    const value = proposal.payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Two statements that say the same thing.
 *
 * Mutual bearing under `packages/core`'s own receipt normalisation, rather than
 * `===` on the raw strings: a re-run that spelled the same sentence with a
 * different quantity of whitespace or a different emphasis marker has not
 * contradicted anything, and treating it as a contradiction would retire a
 * perfectly good `~` on every pass.
 */
function sameStatement(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const forward = statementBearing(a, b);
  const backward = statementBearing(b, a);
  return forward.borne && backward.borne;
}
