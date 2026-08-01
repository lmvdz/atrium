import type { CorrectionAction } from './events.js';
import type { AcceptedObject, AcceptedObjectType } from './objects.js';
import type { CoreState, CorrectionRecord, ObjectRecord } from './state.js';

/**
 * Corrections, read back.
 *
 * The reducer writes the chain (`reduce.ts`); this reads it. Three jobs, all of
 * them #5's:
 *
 *  1. **Reachability.** "Every corrected object renders with its correction
 *     chain reachable (who, when, why-note)." A tombstoned object is still in
 *     state, and so is everything that happened to it.
 *  2. **Anti-repetition.** "The interpretation prompt injects recent corrections
 *     of the relevant type as few-shot counterexamples." That is
 *     `correctionCounterexamples`, and it is a pure function so the prompt is
 *     reproducible from the log.
 *  3. **Measurement.** "The eval harness tracks correction rate per type as the
 *     live quality metric." That is `correctionRateByType`.
 *
 * Note what is deliberately *not* here: the accepted-state block. The
 * interpretation spike measured supplying it in the extraction prompt as a
 * recall collapse from 19 objects to 11, with the dispute edge and the
 * `disputed` flag lost — so #8's second amendment removed it, and dedup happens
 * in `acceptance.ts` instead. Corrections stayed, because a correction is a
 * counterexample rather than a comprehension aid: it says *don't read it that
 * way*, which is the one thing a model cannot infer from the window.
 */

/** The field each type puts a person's name in. `reattribute` moves this one. */
export const ATTRIBUTION_FIELD: Readonly<Record<AcceptedObjectType, string | null>> = Object.freeze(
  {
    decision: 'decidedBy',
    commitment: 'owner',
    claim: 'claimant',
    open_question: null,
    objective: null,
  },
);

/** The field each type puts its text in. `retype` carries this across. */
export const TEXT_FIELD: Readonly<Record<AcceptedObjectType, string>> = Object.freeze({
  decision: 'statement',
  commitment: 'statement',
  claim: 'statement',
  open_question: 'question',
  objective: 'title',
});

/**
 * The payload a retype starts from: the old text, under the new type's key.
 *
 * "That was only a suggestion" turns a Decision into a Claim without anybody
 * retyping the sentence — the sentence was never the problem, the *type* was
 * (#5: "the canonical fix"). Anything the new type needs and the old one did not
 * carry (a claim's `claimant`, a commitment's `owner`) must come from the
 * event's `patch`, and the reducer refuses the retype if it does not.
 */
export function retypeCarryOver(
  from: AcceptedObject,
  to: AcceptedObjectType,
): Record<string, unknown> {
  const text = (from.payload as Record<string, unknown>)[TEXT_FIELD[from.type]];
  return typeof text === 'string' ? { [TEXT_FIELD[to]]: text } : {};
}

/* ─────────────────────────────────────────────────────────────────────────
 * Reading the chain
 * ───────────────────────────────────────────────────────────────────────── */

/** Every correction applied to one object, oldest first. */
export function correctionChain(state: CoreState, objectId: string): CorrectionRecord[] {
  return state.corrections.filter((correction) => correction.objectId === objectId);
}

/** Every chain, keyed by object id. Objects with no corrections are absent. */
export function correctionChains(state: CoreState): Record<string, CorrectionRecord[]> {
  const out: Record<string, CorrectionRecord[]> = {};
  for (const correction of state.corrections) {
    const chain = out[correction.objectId] ?? [];
    chain.push(correction);
    out[correction.objectId] = chain;
  }
  return out;
}

/**
 * Everything reachable about one object, tombstoned or not — the shape the
 * "corrected object renders with its correction chain" requirement needs.
 */
export interface ObjectHistory {
  record: ObjectRecord;
  corrections: CorrectionRecord[];
  /** Set while the object is withdrawn. It is still here; that is the point. */
  retractedAt: string | null;
  /** The object that retired this one, if any. */
  supersededById: string | null;
  /** Relations that answered this question before somebody reopened it. */
  priorAnswers: string[];
  /** How many times the room disagreed with what it was told. */
  revision: number;
}

export function objectHistory(state: CoreState, objectId: string): ObjectHistory | null {
  const record = state.objects[objectId];
  if (!record) return null;
  return {
    record,
    corrections: correctionChain(state, objectId),
    retractedAt: record.retractedAt,
    supersededById: record.supersededById,
    priorAnswers: [...record.reopenedFromAnswers],
    revision: record.revision,
  };
}

/** Objects that are tombstoned but still reachable — the "nothing is erased" view. */
export function tombstoned(state: CoreState): ObjectRecord[] {
  return Object.keys(state.objects)
    .sort()
    .map((id) => state.objects[id])
    .filter((record): record is ObjectRecord => !!record && record.retractedAt !== null);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Counterexamples for the interpretation prompt
 * ───────────────────────────────────────────────────────────────────────── */

export interface CounterexampleQuery {
  /** Restrict to corrections of these types. Empty or absent means all. */
  types?: readonly AcceptedObjectType[];
  /** Restrict to these verbs. Absent means every verb that teaches something. */
  actions?: readonly CorrectionAction[];
  /** Newest N. Default 5 — a prompt is not a corpus. */
  limit?: number;
}

export interface Counterexample {
  objectId: string;
  /** The type as it was read, before any retype. */
  objectType: AcceptedObjectType;
  action: CorrectionAction;
  at: string;
  /** One sentence, ready to inject. */
  text: string;
  note: string | null;
}

/**
 * Verbs that teach the interpreter something.
 *
 * `restore` is excluded: it undoes a retraction, so the lesson it carries is
 * "that earlier correction was wrong", which as a few-shot example teaches the
 * model to be *less* careful. The others each say "you read this wrong, this
 * way".
 */
const INSTRUCTIVE_ACTIONS: readonly CorrectionAction[] = Object.freeze([
  'retype',
  'reattribute',
  'retract',
  'amend',
  'reopen',
]);

/**
 * The most recent corrections, newest first, as counterexamples.
 *
 * Deterministic: `state.corrections` is in canonical log order, so "newest"
 * means "last in the log", and the same log always yields the same block. That
 * matters more than it looks — the corrections block is part of the prompt, so
 * a nondeterministic one makes every interpretation unreproducible and #24's
 * eval unable to tell a prompt change from a model change.
 */
export function correctionCounterexamples(
  state: CoreState,
  query: CounterexampleQuery = {},
): Counterexample[] {
  const types = query.types && query.types.length > 0 ? new Set(query.types) : null;
  const actions = new Set(query.actions ?? INSTRUCTIVE_ACTIONS);
  const limit = query.limit ?? 5;

  const out: Counterexample[] = [];
  for (let index = state.corrections.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const correction = state.corrections[index];
    if (!correction) continue;
    if (!actions.has(correction.action)) continue;
    if (types && !types.has(correction.objectType)) continue;
    out.push({
      objectId: correction.objectId,
      objectType: correction.objectType,
      action: correction.action,
      at: correction.at,
      note: correction.note,
      text: counterexampleText(state, correction),
    });
  }
  return out;
}

function counterexampleText(state: CoreState, correction: CorrectionRecord): string {
  const before = asRecord(correction.before);
  const after = asRecord(correction.after);
  const subject = objectText(state, correction);

  switch (correction.action) {
    case 'retype': {
      const to = typeof after.type === 'string' ? after.type : 'something else';
      return `Read as a ${correction.objectType}, but it was a ${to}: "${clip(subject)}"`;
    }
    case 'reattribute': {
      const field = ATTRIBUTION_FIELD[correction.objectType];
      const was = field ? before[field] : undefined;
      const now = field ? after[field] : undefined;
      return `Attributed the ${correction.objectType} to "${String(was)}", but it belonged to "${String(now)}": "${clip(subject)}"`;
    }
    case 'retract':
      return `Read a ${correction.objectType} that was not one, and it was withdrawn: "${clip(subject)}"`;
    case 'reopen':
      return `Treated this ${correction.objectType} as settled when it was not; it was reopened: "${clip(subject)}"`;
    case 'amend': {
      const field = TEXT_FIELD[correction.objectType];
      const was = before[field];
      const now = after[field];
      if (typeof was === 'string' && typeof now === 'string' && was !== now) {
        return `Worded the ${correction.objectType} as "${clip(was)}", corrected to "${clip(now)}"`;
      }
      return `The ${correction.objectType} "${clip(subject)}" was corrected: ${describeDiff(before, after)}`;
    }
    case 'restore':
      return `A withdrawn ${correction.objectType} was restored: "${clip(subject)}"`;
    default: {
      const exhaustive: never = correction.action;
      return `unknown correction ${JSON.stringify(exhaustive)}`;
    }
  }
}

/**
 * The counterexample block, ready to paste into the extraction prompt (#5, and
 * #8's prompt-context resolution).
 *
 * Returns `''` when there is nothing to teach, so a caller can concatenate it
 * unconditionally without emitting an empty heading — an empty "recent
 * corrections" section reads as "the room has never corrected us", which is a
 * different and wrong statement.
 */
export function formatCounterexamples(state: CoreState, query: CounterexampleQuery = {}): string {
  const examples = correctionCounterexamples(state, query);
  if (examples.length === 0) return '';
  // The note is quoted as what it is — the note somebody attached to the
  // correction — and not as "the room said", which narrates a speech act nobody
  // performed. CONVENTIONS: the system never synthesizes speech, and a note
  // written into a form is not a sentence the room uttered.
  const lines = examples.map((example) => {
    const why = example.note ? ` (correction note: "${clip(example.note, 120)}")` : '';
    return `- ${example.text}${why}`;
  });
  return [
    'Recent corrections from this workspace. These are readings that were wrong;',
    'do not repeat their shape.',
    '',
    ...lines,
  ].join('\n');
}

/* ─────────────────────────────────────────────────────────────────────────
 * Measurement
 * ───────────────────────────────────────────────────────────────────────── */

export interface CorrectionRate {
  accepted: number;
  corrected: number;
  /** `corrected / accepted`, or 0 when nothing of this type was accepted. */
  rate: number;
}

/**
 * #5's live quality metric: how often each type gets corrected after acceptance.
 *
 * Counts *objects* corrected, not corrections — three amendments to one badly
 * read decision is one thing read badly, and counting events would let a single
 * argument dominate the metric.
 */
export function correctionRateByType(state: CoreState): Record<AcceptedObjectType, CorrectionRate> {
  const out = {
    decision: { accepted: 0, corrected: 0, rate: 0 },
    commitment: { accepted: 0, corrected: 0, rate: 0 },
    open_question: { accepted: 0, corrected: 0, rate: 0 },
    claim: { accepted: 0, corrected: 0, rate: 0 },
    objective: { accepted: 0, corrected: 0, rate: 0 },
  } satisfies Record<AcceptedObjectType, CorrectionRate>;

  const correctedByType = new Map<string, AcceptedObjectType>();
  for (const correction of state.corrections) {
    correctedByType.set(correction.objectId, correction.objectType);
  }

  for (const record of Object.values(state.objects)) {
    out[record.object.type].accepted += 1;
  }
  for (const type of correctedByType.values()) {
    out[type].corrected += 1;
  }
  for (const type of Object.keys(out) as AcceptedObjectType[]) {
    const entry = out[type];
    entry.rate = entry.accepted === 0 ? 0 : entry.corrected / entry.accepted;
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ───────────────────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The object's text as it reads now — the correction's own text if it has one. */
function objectText(state: CoreState, correction: CorrectionRecord): string {
  const before = asRecord(correction.before);
  const field = TEXT_FIELD[correction.objectType];
  const fromBefore = before[field];
  if (typeof fromBefore === 'string' && fromBefore.length > 0) return fromBefore;
  const record = state.objects[correction.objectId];
  if (!record) return correction.objectId;
  const current = (record.object.payload as Record<string, unknown>)[
    TEXT_FIELD[record.object.type]
  ];
  return typeof current === 'string' ? current : correction.objectId;
}

function describeDiff(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = keys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (changed.length === 0) return 'nothing changed';
  return changed
    .map((key) => `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`)
    .join(', ');
}

function clip(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
