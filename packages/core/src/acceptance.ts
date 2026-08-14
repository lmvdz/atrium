import { payloadAttributions } from './attribution.js';
import type { Actor, Id, Timestamp } from './common.js';
import {
  bearingMessage,
  isAboutTheWindow,
  type ProblemSubject,
  type ProvenanceMessage,
  type ProvenanceProblem,
  referringProblems,
  rejectingProblems,
  validateProposalProvenance,
} from './escalation.js';
import { type AuthoredEvent, authored, type CoreEvent, trustedContext } from './events.js';
import { alignTokens, hasContent, normalizeForReceipt, orderedTokens } from './matching.js';
import {
  type AcceptedObjectType,
  type ClaimPayload,
  type DecisionPayload,
  type ObjectPayloadOf,
  objectPayloadKeys,
  payloadText,
  payloadTextKey,
} from './objects.js';
import {
  type AcceptanceConfig,
  defaultAcceptanceConfig,
  typeCertifiableFromText,
} from './policy.js';
import { type Proposal, proposerIsMachine, type StoredProposal } from './proposal.js';
import { appendEvent, compareCursor } from './reduce.js';
import { type CoreState, canonicalJson, type ObjectRecord } from './state.js';

/**
 * The acceptance engine — #4's matrix, entire.
 *
 * The reducer holds the *floor* of this matrix (`authority.ts`): the rows that
 * are trust boundaries, enforced where nothing can route around them. This file
 * decides what a worker should emit at all, given inputs the reducer applies
 * more narrowly — the messages a reading was drawn from, who wrote them, what
 * the room has already accepted.
 *
 * The two read one θ table (`policy.ts`), so they cannot disagree about whether
 * a reading is strong enough, and `AcceptanceConfig` refuses to be configured
 * below the floor, so the engine can only ever be the stricter of the two.
 *
 * ## What "two boundaries" does and does not mean
 *
 * r4's receipt said the engine and the reducer are two boundaries, unqualified,
 * and r4's blind review was right that the claim outruns the code. Both call the
 * *same* `validateProposalProvenance`, so **every defect in quote semantics
 * survives both**: switching off the engine does not help, because the reducer
 * accepts what the validator passes; switching off the reducer does not help,
 * because the engine emits `auto_accept` on the same input.
 *
 * That is deliberate and it stays. Two implementations of "does this quote bear
 * this sentence" is two answers to one question, which is the defect
 * `policy.ts` exists to prevent for θ — and `RETRO.md` records what it costs
 * when a rule has two homes. So the claim is scoped instead of withdrawn or
 * padded:
 *
 *  - **Independently enforced at the floor** (`authority.ts`, and nothing here
 *    can weaken them): who the actor is, that a proposal is cited and is real,
 *    open, type-matching and room-matching, that a non-human acted on its own
 *    reading, the confidence floor, payload equality, provenance equality, that
 *    a message window exists at all, and that a quote exists at all.
 *  - **One implementation, called from both**: everything about what the quote
 *    *means* — where it sits in its message, what the statement drops or adds,
 *    who wrote it, and whether the window revisits it. A defect here is a defect
 *    in both layers, and `boundary.test.ts` pins that as a property rather than
 *    letting a receipt imply otherwise.
 *
 * **The receipt is not optional, and an empty one is not a receipt.** In round 1
 * `messages` was an optional field whose absence produced an empty problem set,
 * so the caller that forgot it got auto-acceptance instead of a refusal — the
 * exact fail-open shape a trust boundary must not have. Round 2 made it required
 * and round 2's gauntlet walked through the door that was left: `messages: []`
 * satisfies "required" and satisfies nothing else. A model proposal judged with
 * no window *or an empty one* is discarded with `missing_message_context`.
 *
 * Everything here is pure. No clock: `answerBinding` takes its timestamp. No id
 * generation: it takes its ids. That is what makes an acceptance decision
 * reproducible from the log months later, which is the property the whole
 * correction story rests on.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * The decision
 * ───────────────────────────────────────────────────────────────────────── */

/** Who a commitment's sentence came from. */
export type CommitmentAttribution =
  /** The owner wrote the message bearing it — "I'll finish it tomorrow". */
  | 'self'
  /** Somebody else did — "Justin will handle it". Nobody gets committed by it. */
  | 'third_party';

export type AcceptanceVerdict =
  /** Accept it now, as `~`. */
  | 'auto_accept'
  /** Keep it staged. `visibility` says where it shows. */
  | 'pending'
  /** Drop it. Never shown, never stored as a live proposal. */
  | 'discard';

export type AcceptanceVisibility =
  /** It became an object; nothing is pending. */
  | 'accepted'
  /** Current state, marked unconfirmed. Never in Needs-you. */
  | 'quiet'
  /** Needs-you: somebody has to act on it. */
  | 'needs_you'
  /** Nowhere. */
  | 'none';

/**
 * Which cell of the matrix fired. One name per cell, so tests can pin them.
 *
 * **Data, so a coverage test can iterate it instead of restating it.** r4's
 * blind review found the shape this closes: `acceptance.test.ts` carried a test
 * titled *"reaches every rule name the type declares"* whose supposedly complete
 * list omitted `receipt_not_certifiable`, so the test passed and would have gone
 * on passing if that engine behaviour were deleted. A hand-written list catches
 * a rule that disappears from the source and is blind to one that appears; the
 * derived list is blind the other way. Deriving the *type* from the data makes
 * them the same object, so a test iterating it is exhaustive by construction.
 *
 *  - `missing_message_context` — no window, an empty one, or one with no words
 *    in any body. A model reading judged without the messages it cites.
 *  - `provenance_failed` — a `reject`-severity receipt problem.
 *  - `receipt_not_certifiable` — a `refer`-severity one: the check declines to
 *    rule either way, so it is never auto-accepted and never discarded.
 *  - `duplicate_of_accepted` — the room already accepted this, from these
 *    messages.
 *  - `below_theta_min` — too weak to be worth anybody's attention, with nothing
 *    wrong in the receipt.
 *  - `theta_band` — between θ_min and θ_auto: shown quietly, never Needs-you.
 *  - `auto_accept` — at or above θ_auto, for a type that may auto-accept.
 *  - `never_auto_accepts` — at or above θ_auto, for a type that never does at
 *    any confidence. Named for the *rule* rather than the type: it was
 *    `decision_never_auto`, which misnamed every non-decision that reached it,
 *    and since r5 three types are in that row.
 *  - `type_not_certified` — at or above θ_auto, for a type whose rule the
 *    proposal is entitled to *apply* but whose being-this-type nothing in the
 *    text establishes. r7. Kept distinct from `never_auto_accepts` because they
 *    are different facts: one says a machine may not perform this act, the other
 *    says nothing proves this *was* that act.
 *  - `third_party_commitment` — an obligation somebody else's sentence put a
 *    name on. It goes to the named owner.
 *  - `human_proposer` — a person staged it, so θ does not apply.
 */
export const ACCEPTANCE_RULE_NAMES = [
  'missing_message_context',
  'provenance_failed',
  'receipt_not_certifiable',
  'duplicate_of_accepted',
  'below_theta_min',
  'theta_band',
  'auto_accept',
  'never_auto_accepts',
  'type_not_certified',
  'third_party_commitment',
  'human_proposer',
] as const;

export type AcceptanceRuleName = (typeof ACCEPTANCE_RULE_NAMES)[number];

export interface AcceptanceDecision {
  verdict: AcceptanceVerdict;
  visibility: AcceptanceVisibility;
  /** The named owner who must confirm, for a third-party commitment. */
  awaitingConfirmFrom: Id | null;
  /** The matrix cell. */
  rule: AcceptanceRuleName;
  /** Why, in words a room could be shown. */
  reason: string;
  /** The confident line for this type. */
  thetaAuto: number;
  /** Whether crossing it may accept, or only surface. */
  autoAcceptAvailable: boolean;
  thetaMin: number;
  /** Only set for commitments. */
  attribution: CommitmentAttribution | null;
  /** The accepted object this duplicates, when that is why it was discarded. */
  duplicateOf: Id | null;
  /**
   * **What this verdict is a fact about** — r11. See `ProblemSubject`.
   *
   * `'the_window'` means the answer is a function of what the caller's window
   * happened to hold, not of the reading: no window at all, or the findings that
   * drove the verdict were computed over a window that did not reach every
   * message the proposal cites. Re-run the same proposal against a complete
   * window and the verdict may be anything.
   *
   * It exists because a *consumer* — `attention.ts` — was treating "not
   * `needs_you`" as "this cycle judged this subject and it owes nobody
   * anything", and one of the ways to be not-`needs_you` is `discard /
   * provenance_failed` on a window that slid past the bearing message. A
   * verdict's disposition and a verdict's standing are two different facts and
   * only one of them was on this type.
   */
  about: ProblemSubject;
}

/**
 * An already-accepted object, as the deduplicator needs it.
 *
 * ## The whole payload, and the reason it is not three named fields — r10
 *
 * This carried `{objectId, type, text, messageIds}` until r10: the *sentence*
 * and nothing else. A duplicate is `discard` / `visibility: 'none'` — no
 * proposal, no attention item, no issue, no trace — so every field the type
 * could not express was a field whose difference destroyed a reading in
 * silence. One message naming two people is enough:
 *
 * ```
 * m1 (carol): "Alice and Bob will each run the backfill before the freeze."
 *   → commitment{owner: alice}  accepted
 *   → commitment{owner: bob}    discard / duplicate_of_accepted / o_alice
 * ```
 *
 * Bob is never asked, and `state.objects` holds Alice's commitment and nothing
 * else. The same shape, all `discard`: an `unverified` claim re-read as
 * **disputed**, a commitment gaining a `due`, a commitment changing `owner`, a
 * claim changing `claimant`.
 *
 * **No caller could close this**, which is why the repair is a type. The
 * distinction has to be *expressible* before any filtering of `acceptedObjects`
 * can reach it, and `text` had nowhere to put it.
 *
 * ## Exhaustive by construction, not by enumeration
 *
 * The obvious repair — add `owner` and `claimant`, the two fields the finding
 * was demonstrated with — is the one `RETRO.md` refuses by name: it is a
 * denylist of the fields somebody has thought of, and `due`, `status`,
 * `verification` and `decidedBy` were all on the floor beside them. So the ref
 * carries the **whole payload**, the union is keyed by `type` so the two cannot
 * disagree, and `payloadsMatch` compares every key of the type's own schema plus
 * every key either payload actually carries. A field added to
 * `objectPayloadByType` next round is compared by strict equality from the
 * moment it is added — the safe direction, because a difference the comparison
 * does not understand makes two readings *distinct*, which stages a proposal
 * rather than deleting one.
 *
 * ## …and whether the thing it matches is still standing
 *
 * `retractedAt` and `supersededById` are the record's own answer to "what state
 * is it in" (`attention.ts`'s `isLive`, same two fields, same meaning).
 * Discarding a re-reading against a tombstone means a retracted thing can never
 * be re-proposed: the room withdraws a commitment, the next pass over the same
 * window reads it again, and the reading dies against the tombstone of the thing
 * it would have restored.
 *
 * Build one with `acceptedObjectRef` rather than by hand.
 */
export type AcceptedObjectRef = {
  [K in AcceptedObjectType]: {
    objectId: Id;
    type: K;
    /**
     * The object's whole payload — every field, not the sentence alone. See the
     * docblock above for why this is not `text`.
     */
    payload: Readonly<ObjectPayloadOf<K>>;
    /** The messages it was drawn from. */
    messageIds: readonly Id[];
    /** Set by a `retract` correction; a tombstone is not a duplicate target. */
    retractedAt: Timestamp | null;
    /** Set when another object replaced this one; likewise not a target. */
    supersededById: Id | null;
  };
}[AcceptedObjectType];

/**
 * The one derivation of an `AcceptedObjectRef` from the room's state.
 *
 * Exported because the alternative is every caller writing the projection by
 * hand, and a caller that forgets `retractedAt` re-creates the defect the field
 * exists to close. `#23`'s worker maps `Object.values(state.objects)` through
 * this.
 */
export function acceptedObjectRef(record: ObjectRecord): AcceptedObjectRef {
  return {
    objectId: record.object.id,
    type: record.object.type,
    payload: record.object.payload,
    messageIds: record.object.provenance.messageIds,
    retractedAt: record.retractedAt,
    supersededById: record.supersededById,
  } as AcceptedObjectRef;
}

export interface AcceptanceContext {
  config?: AcceptanceConfig;
  /**
   * The window's messages — **required, and non-empty**, and the reason is the
   * whole of round 1's second blocking finding. Commitment attribution and
   * provenance validation cannot be done without them, and in round 1 that meant
   * they silently were not done: no messages, no problems, auto-accept. A model
   * proposal judged with no window is discarded now.
   *
   * The type cannot say "non-empty", so the check does: `[]` is refused with the
   * same rule as `undefined`. Round 2's gauntlet found the version that only
   * asked about `undefined`, and an empty array is not a smaller window — it is
   * the same absence with a different spelling.
   *
   * A human-staged proposal does not go through θ at all, so it survives an
   * empty window; there is nothing to check when the person staging the reading
   * is the receipt.
   *
   * ## What this window has to *be* — r6, and it is a contract
   *
   * **The room's messages, in room order, continuing past the ones the proposal
   * cites.** Not "the messages this receipt cites", which is the natural reading
   * and is what `commitmentAttribution` narrows to one function below — and
   * which silently turns the later-correction scan off:
   *
   * | window supplied     | verdict for the same proposal |
   * | ------------------- | ----------------------------- |
   * | the whole room      | `receipt_not_certifiable`     |
   * | the cited messages  | `auto_accept`                 |
   *
   * That is r2's `messages: []` and r3's `[{ body: '' }]` one level out: absence
   * and emptiness were made one fact, and **truncation was left invisible**.
   * `laterRevision` now refuses a window that holds nothing but the citations —
   * a window the proposal chose is not a window — and reports how far it read on
   * the way past.
   *
   * **A window that reaches one message past the citations and stops short of
   * the room's end** was the remaining hole, and it was left here as "the
   * caller's to honour" — a rule in prose, enforced nowhere, which is the shape
   * every round of this ticket has been failed for. #86 closed it for the caller
   * that ships, and not by looking harder: a truncated window and a room that
   * ended are the same bytes, and no pure function of this array can tell them
   * apart. What tells them apart is a number both sides know.
   * `atrium_receipt_window` (`drizzle/0011`) stops at
   * `RECEIPT_POLICY.maxLaterMessagesCarried`, one more than
   * `maxLaterMessagesScanned`, so a truncated tail is always over the read bound
   * and refers, and a shorter one is provably the room's end — and
   * `laterRevision` refuses by name if that relation is ever broken.
   *
   * It remains the caller's to honour for a caller that is not that supplier,
   * which is why the refusal exists at all rather than the contract being
   * assumed.
   */
  messages: readonly ProvenanceMessage[];
  /**
   * What the room has already accepted, for deduplication.
   *
   * This is where dedup belongs. The spike tested the alternative directly —
   * putting a compressed accepted-state block in the extraction prompt — and it
   * dedups well (zero re-proposed objects) at a cost of collapsing recall from
   * 19 objects to 11, losing the dispute edge and the `disputed` flag, and
   * producing no cross-window relations at all. It is a de-duplication input,
   * not a comprehension aid. Doing it here costs nothing and is testable
   * without a model.
   */
  acceptedObjects?: readonly AcceptedObjectRef[];
}

/**
 * The person a payload puts on the hook, if any.
 *
 * **Delegates now, and declares nothing.** Until #22 r10 this was a second,
 * narrower answer to "who does this payload name" — it resolved `claim →
 * claimant`, `commitment → owner` and `null` for everything else, while
 * `ATTRIBUTION_FIELD` two files away already knew about `decision → decidedBy`.
 * The acceptance path read this one, so a decision naming somebody else went
 * through every gate unexamined (r10, D2). One derivation, in `attribution.ts`;
 * this is the arity adapter for the callers that want at most one name, and it
 * is safe because that module refuses at import to classify two attribution
 * fields on one type.
 */
export function payloadAttributedTo(
  type: AcceptedObjectType,
  payload: Record<string, unknown>,
): Id | null {
  return payloadAttributions(type, payload)[0] ?? null;
}

/**
 * Did the owner of this commitment write the message it was read out of?
 *
 * **The message bearing the sentence, not any cited message.** Round 1's
 * gauntlet: an owner who authored *any* cited message counted as a
 * self-statement, so padding `provenance` with one unrelated message the owner
 * happened to write turned "Justin will handle it" into "Justin said he would
 * handle it" and auto-accepted an obligation nobody agreed to. The quote names
 * the bearing message; its author is the only authorship that answers the
 * question.
 *
 * With no quote, or no window, the answer is `third_party`, deliberately. #4's
 * rule is "nobody gets committed by someone else's sentence", and the only way
 * to honour it without evidence is to ask the named person. An unproven
 * self-statement is a third-party statement.
 */
export function commitmentAttribution(
  owner: Id,
  citedMessageIds: readonly Id[],
  messages: readonly ProvenanceMessage[] | undefined,
  quote: string | null | undefined,
): CommitmentAttribution {
  // Absent, empty, and empty-of-content are one state: nobody supplied the words.
  if (!messages?.some((message) => hasContent(message.body))) return 'third_party';
  if (!hasContent(quote)) return 'third_party';
  const cited = new Set(citedMessageIds);
  const citedMessages = messages.filter((message) => cited.has(message.id));
  const bearing = bearingMessage(quote, citedMessages);
  return bearing !== null && bearing.authorId === owner ? 'self' : 'third_party';
}

/**
 * Is this reading something the room already accepted?
 *
 * Same sentence **and** provenance overlap, both required. Either alone is a bad
 * matcher: two different decisions drawn from one message share provenance
 * completely, and two readings of one subsystem share most of their words.
 *
 * ## Why this is not a similarity score any more
 *
 * **r5, from the audit of what every documented limit does with an input inside
 * it — and this one was not on anybody's list.** `escalation.ts` says of its
 * stopword table, in bold: *"This list decides which model reads a window. It
 * has not decided whether a reading becomes a fact since r4, and it must never
 * do so again."* It still did, through here. This function measured similarity
 * with `contentTokens`, which drops stopwords, deduplicates and imposes a
 * three-character floor — and `not`, `all` and `some` are all on that list. A
 * duplicate is **discarded**, so:
 *
 * | already accepted, from msg_1     | newly read, from msg_1              | r4 verdict |
 * | -------------------------------- | ----------------------------------- | ---------- |
 * | The migration is reversible      | The migration is **not** reversible | discarded  |
 * | **All** services restart cleanly | **Some** services restart cleanly   | discarded  |
 *
 * That is r3's gauntlet finding — a similarity measure accepting the negation of
 * the thing it validates — surviving in the one path nobody re-read, and it is
 * *worse* here than there: the reading is not referred or refused, it is
 * destroyed, and what it was contradicting stays on the record. A correction the
 * room can never see is the failure this whole ticket exists to prevent.
 *
 * So the test is the alignment the receipt already uses, over routing tokens: a
 * duplicate is a **re-proposal of the same sentence**, with nothing added and
 * nothing dropped on either side. `duplicateThreshold` is gone rather than
 * tuned — `RETRO.md`: when a value invites a bypass, deleting it invites
 * neither. A near-duplicate now costs a person one click, which is the cheap
 * side of this trade; the expensive side deleted a contradiction in silence.
 *
 * ## …and why the tokens are not the routing ones, r8
 *
 * That paragraph used to read: *"Routing tokens rather than receipt tokens,
 * deliberately: case, fullwidth spellings and markdown are noise… being lossy
 * here means firing more often, which for a re-proposal is the harmless one."*
 * **A duplicate is discarded**, four paragraphs above, in bold. Firing more
 * often is therefore not the harmless direction; it is the destructive one, and
 * the argument had the sign backwards on the one path in this file that deletes
 * a reading outright.
 *
 * r8's review produced the input: NFKC folds `10²` to `102`, so
 *
 * | already accepted, from msg_1        | newly read, from msg_1              | r7 verdict |
 * | ----------------------------------- | ----------------------------------- | ---------- |
 * | the p99 settled at **102** ms       | the p99 settled at **10²** ms       | discarded  |
 *
 * — 100 against 102, gone, with no proposal, no issue and nothing in the room to
 * see. That is the same shape as the `not` and `all`/`some` rows above it, one
 * fold further down.
 *
 * ## …and why there is no fold left at all, r9
 *
 * r8 kept one: `dedupTokens` lower-cased, on the ground that *"case is the one
 * difference that cannot change what a sentence says"*. The same file's receipt
 * policy already said the opposite, in the paragraph that refuses case folding
 * because `US` / `us`, `Bill` / `bill` and `March` / `march` are different
 * words. One more row, from the same corner of the product as the two above:
 *
 * | already accepted, from msg_1              | newly read, from msg_1 + msg_2            | r8 verdict |
 * | ----------------------------------------- | ----------------------------------------- | ---------- |
 * | Set the deploy password to `` `Hunter2` `` | Set the deploy password to `` `hunter2` `` | discarded  |
 *
 * The lower-casing ran straight through the code segment `normalizeForReceipt`
 * had just preserved byte for byte, on the stated ground that a literal
 * respaced is a literal changed — so the record kept the old password and the
 * room was shown nothing else. Citing the earlier message alongside the one
 * being read is ordinary; `sampleLog` does it.
 *
 * Restricting the fold to prose would not have saved it. The counterexamples the
 * receipt policy lists are prose ones, and *"Send the bill to Acme"* is not a
 * re-proposal of *"Send the Bill to Acme"*.
 *
 * So the tokens are `orderedTokens` — the receipt's own — and the rule is one
 * line long: **a duplicate is the same text.** The trade barely has a cost side
 * left, because `borne` makes an accepted object's text a verbatim message body:
 * two readings of one message are already case-identical and still dedup, and a
 * case difference means two different bodies, which is the correction case. What
 * a fullwidth spelling and a re-cased literal cost now is one extra staged
 * proposal apiece, which is the side of this trade the paragraphs above chose
 * twice already — once when they deleted `duplicateThreshold`, once when they
 * dropped NFKC.
 */
export function findDuplicate(
  type: AcceptedObjectType,
  payload: Readonly<Record<string, unknown>>,
  messageIds: readonly Id[],
  accepted: readonly AcceptedObjectRef[],
): AcceptedObjectRef | null {
  const wanted = orderedTokens(payloadText(type, payload));
  if (wanted.length === 0) return null;
  const cited = new Set(messageIds);
  for (const candidate of accepted) {
    if (candidate.type !== type) continue;
    // A withdrawn or replaced object is not a thing the room "already has". Two
    // fields rather than one because that is `isLive`'s own answer to what
    // standing means, and a second definition of it here would be exactly the
    // drift this package keeps finding.
    if (candidate.retractedAt !== null || candidate.supersededById !== null) continue;
    if (!candidate.messageIds.some((id) => cited.has(id))) continue;
    // Total on a ref the type forbids: a JS caller still carrying r9's
    // `{objectId, type, text, messageIds}` reaches here with no payload at all,
    // and `payloadText` would throw inside a path whose whole contract is that
    // it never does. Skipping is the same direction every other guard here
    // takes — a candidate nothing can compare is not a duplicate.
    const candidatePayload = candidate.payload as unknown as Record<string, unknown> | undefined;
    if (candidatePayload === null || typeof candidatePayload !== 'object') continue;
    const have = orderedTokens(payloadText(type, candidatePayload));
    if (have.length === 0) continue;
    // Symmetric by construction: `borne` requires both sides accounted for, so
    // neither "the new one restates the old" nor the reverse is enough alone.
    if (!alignTokens(have, wanted).borne) continue;
    if (!payloadsMatch(type, candidatePayload, payload)) continue;
    return candidate;
  }
  return null;
}

/**
 * **Is every other field of these two payloads the same fact?**
 *
 * The text field is excluded — `findDuplicate` has just compared it with the
 * receipt's own alignment, which forgives the spacing `normalizeForReceipt`
 * forgives and nothing else. Everything else is compared with `canonicalJson`,
 * so key order is never a difference.
 *
 * **The key set is a union of three sources**, and that union is the whole point
 * of the function:
 *
 *  - the type's schema keys (`objectPayloadKeys`), so a field added to
 *    `objectPayloadByType` is compared from the commit that adds it rather than
 *    from the round that finds it missing;
 *  - the keys each side actually carries, because an `AcceptedObjectRef` comes
 *    from a caller and need not have been through the parser, and a payload the
 *    schema does not describe is still a payload somebody stored.
 *
 * A key nobody understands therefore makes two readings **distinct**, which
 * stages a proposal. That is the safe direction and it is the one this whole
 * finding is about: the failure being repaired deleted a reading in silence, and
 * the worst this can do is ask a person about something twice.
 */
function payloadsMatch(
  type: AcceptedObjectType,
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  const textKey = payloadTextKey(type);
  const keys = new Set([...objectPayloadKeys(type), ...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === textKey) continue;
    // `undefined` and an absent key are one state — a payload that omits `due`
    // and one that carries `due: undefined` are the same fact — and neither is
    // `null`, which is a value the schemas use.
    if (canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null)) return false;
  }
  return true;
}

/**
 * #4's matrix, applied to one staged reading.
 *
 * The table this implements, exactly — one row per cell, and
 * `acceptance.test.ts` has one test per row:
 *
 * | type                     | c < θ_min | θ_min ≤ c < θ_auto | c ≥ θ_auto            |
 * | ------------------------ | --------- | ------------------ | --------------------- |
 * | claim                    | discard   | pending, quiet     | auto-accept           |
 * | open_question            | discard   | pending, quiet     | auto-accept           |
 * | objective                | discard   | pending, quiet     | pending, Needs-you    |
 * | commitment, self-stated  | discard   | pending, quiet     | pending, Needs-you    |
 * | commitment, third-party  | discard   | pending, quiet     | pending, owner confirm|
 * | decision                 | discard   | pending, quiet     | pending, Needs-you    |
 *
 * The `objective` and `commitment` rows moved out of auto-accept in r5 — see
 * `DEFAULT_ACCEPTANCE_RULES` for why — and **this table said otherwise for one
 * commit**, which grok's blind pass caught and named as the same class of
 * confidently-wrong comment the round had just fixed for the bidi fold. The row
 * a reader trusts is `DEFAULT_ACCEPTANCE_RULES`; this one is prose about it, and
 * `acceptance.test.ts` drives every cell from the table rather than from here.
 *
 * …with one cell in front of all of them: **no window, no verdict**. A model
 * proposal judged without the messages it cites is discarded, because the
 * alternative — an empty problem set read as a clean receipt — is how a wrong
 * citation becomes an accepted fact.
 *
 * …and one cell across all of them, above θ_min: **a receipt nothing can rule
 * on is pending, quiet**. Not accepted, because a machine may not act on a
 * quote it cannot certify; not discarded, because the discrepancy is exactly
 * what a person needs to see. `receipt_not_certifiable`.
 *
 * Two cells are worth defending.
 *
 * **Decision at c ≥ θ_auto is Needs-you, not quiet.** #4 says a pending
 * proposal shows quietly "never in Needs-you unless it blocks something", and #6
 * says `needs_decision` is "a decision proposal awaiting you". Both are right,
 * and the θ band is where they meet: a decision the pass is unsure about shows
 * quietly, and one it is confident about is exactly the thing a person should be
 * asked to confirm. A confident decision proposal *does* block something — the
 * room's current state is wrong until somebody rules on it.
 *
 * **A commitment never auto-accepts, at any confidence, self-stated or not.**
 * Not a threshold: a rule. #4's row split on who the sentence is *about*; it was
 * silent on who does the accepting, and #44's fact-check drove a model straight
 * through that silence. The third-party cell keeps its own name above the
 * general one because only it knows *whose* Needs-you the item belongs in. The
 * spike could not test any of this (one commitment in six runs, self-attributed,
 * on a public RFC thread where nobody says "Ryan will handle it"), so it is
 * implemented from #4's text and is the part of this file most in need of the
 * working-team corpus #24 asks for.
 */
export function decideAcceptance(
  proposal: Proposal | StoredProposal,
  context: AcceptanceContext,
): AcceptanceDecision {
  const config = context.config ?? defaultAcceptanceConfig;
  const rule = config[proposal.type];
  const payload = proposal.payload as unknown as Record<string, unknown>;
  const text = payloadText(proposal.type, payload);
  const attributedTo = payloadAttributedTo(proposal.type, payload);
  const messages = context.messages as readonly ProvenanceMessage[] | undefined;

  const base = {
    thetaAuto: rule.thetaAuto,
    thetaMin: rule.thetaMin,
    autoAcceptAvailable: rule.autoAccept,
    attribution: null,
    duplicateOf: null,
    awaitingConfirmFrom: null,
  } as const;

  // ── No window, no verdict ────────────────────────────────────────────────
  //
  // Fail-closed, and loudly: this is a caller bug, not a reading defect. The
  // failure it replaces was silent in the other direction.
  //
  // **Empty counts as absent.** Round 2's gauntlet found the `undefined`-only
  // form of this check: `messages: []` walked past the door marked "required",
  // and everything downstream then found nothing wrong because there was nothing
  // to look in. The two spellings describe the same state of the world — nobody
  // supplied the messages this reading cites — so they get the same answer.
  //
  // **And empty of content counts as empty.** Round 3's gauntlet found the
  // `length`-only form: one message whose `body` is `""` makes the array
  // non-empty and supplies nothing, which is the same trick one level in. The
  // question is whether anybody supplied words, so the test is `hasContent`.
  const windowIsAbsent =
    messages === undefined || messages.length === 0 || !messages.some((m) => hasContent(m.body));
  // A machine reading — `model` or `agent` (#117) — is never accepted on trust:
  // the window is its receipt. A human is the receipt for their own reading and
  // is not asked for one. The gate is machine-vs-human (`proposerIsMachine`),
  // not model-vs-everything — an agent takes the identical path a model does.
  if (proposerIsMachine(proposal.proposer) && windowIsAbsent) {
    return {
      ...base,
      // The purest window-fact there is: nothing about this reading was read.
      about: 'the_window',
      verdict: 'discard',
      visibility: 'none',
      rule: 'missing_message_context',
      reason:
        messages === undefined
          ? 'no message window was supplied, so the receipt could not be checked — a machine reading is never accepted on trust; supply the messages it cites'
          : messages.length === 0
            ? 'an empty message window was supplied, so the receipt could not be checked — an empty window is not a window; a machine reading is never accepted on trust'
            : `a message window of ${messages.length} message${messages.length === 1 ? '' : 's'} was supplied and not one of them has any words in it, so the receipt could not be checked — a window with nothing in it is not a window; a machine reading is never accepted on trust`,
    };
  }

  // ── The receipt, before anything else ────────────────────────────────────
  //
  // A reading whose citation is wrong is worse than no reading: the citation is
  // what a person clicks to check it, and a wrong one survives casual review.
  // The spike's worst output — a claim at 0.98 confidence attributed to a man
  // who never said it — fails here and nowhere else.
  //
  // Only `reject`-severity problems discard. A `reclassify` one — an owner who
  // did not write the message bearing the sentence — is not a defect in the
  // reading, it *is* the third-party commitment case, and it routes below
  // rather than dying here.
  const problems: readonly ProvenanceProblem[] =
    messages && messages.length > 0
      ? validateProposalProvenance(
          {
            type: proposal.type,
            provenance: proposal.provenance,
            quote: proposal.quote,
            proposer: proposal.proposer,
            attributedTo,
            // The sentence being staged. Without it the quote can be verbatim,
            // correctly attributed, and about something else entirely — r2's
            // gauntlet, major 1.
            statement: text,
          },
          messages,
        )
      : [];
  const rejecting = rejectingProblems(problems);
  if (rejecting.length > 0) {
    return {
      ...base,
      // **Scoped to the findings that produced this verdict, not to every
      // finding in the list** — r11. The two subsets disagree and the difference
      // matters in both directions. A window that dropped a citation always
      // carries `unknown_message` at `refer`, which is *shadowed* here by any
      // `reject`: on the sequence this round was opened on, `quote_not_found`
      // wins and the refer never reaches a return. Scoping to `rejecting`
      // catches it anyway, because `quote_not_found` is itself computed over the
      // survivors. And a proposal with no quote at all is `missing_quote` —
      // `reject`, about the reading, true against any window — so it still
      // concludes rather than being preserved forever by a citation the window
      // happened to miss.
      about: isAboutTheWindow(rejecting) ? 'the_window' : 'the_reading',
      verdict: 'discard',
      visibility: 'none',
      rule: 'provenance_failed',
      reason: `demoted below θ_min: ${rejecting.map((problem) => problem.detail).join('; ')}`,
    };
  }
  const attribution =
    proposal.type === 'commitment'
      ? commitmentAttribution(attributedTo ?? '', proposal.provenance, messages, proposal.quote)
      : null;

  // ── The receipt this check declines to rule on ───────────────────────────
  //
  // **Above the θ_min discard since r5, and the two cases are different
  // questions rather than two heights on one scale.**
  //
  // r4 put this below the discard and defended it: a weak reading should be
  // dropped rather than promoted into the panel by a receipt problem. That
  // argument is right about *one* input and r4 applied it to two. θ_min answers
  // "is this reading worth somebody's attention" — a property of the model's own
  // self-report, and a weak self-report with a clean receipt is noise, so it is
  // still discarded below. A `refer` answers something else entirely: **the
  // receipt and the statement disagree, and the disagreement was detected.**
  // That is evidence about the record, not weakness in the reading.
  //
  // The input that made the difference visible: quote "Bob will not deploy
  // production Friday", statement "Bob will deploy production Friday",
  // confidence 0.4999. r4 discarded it as too weak to show — destroying the
  // exact discrepancy the receipt exists to make visible, one thousandth of a
  // point below a line that has nothing to do with what was found. The
  // inversion is not less real for having been proposed timidly.
  //
  // Still **above everything that can accept**, so there is no path from here to
  // `auto_accept`.
  const referring = referringProblems(problems);
  if (referring.length > 0) {
    return {
      ...base,
      about: isAboutTheWindow(referring) ? 'the_window' : 'the_reading',
      attribution,
      verdict: 'pending',
      visibility: 'quiet',
      rule: 'receipt_not_certifiable',
      reason: `not accepted on a machine's word, and not thrown away: ${referring.map((problem) => problem.detail).join('; ')}`,
    };
  }

  /**
   * **Everything below here judged the reading, and it is provable rather than
   * asserted** — r11.
   *
   * The two returns above are the only ones a receipt finding can produce. Past
   * them the problem list holds no `reject` and no `refer`, and
   * `unknown_message` — the finding that fires for *every* citation this window
   * did not reach — is `refer`. So a window missing a citation cannot reach this
   * line, and the remaining cells (`duplicate_of_accepted`, the θ rows,
   * `third_party_commitment`, `human_proposer`) are answers about the proposal's
   * own confidence, type and attribution.
   *
   * That is a claim about code that changes, so it is measured rather than
   * trusted: `silence.test.ts`, "no verdict past the receipt gate is reachable
   * with a window that missed a citation", drives every rule name against an
   * incomplete window and asserts none of them appears.
   */
  const judged = { ...base, about: 'the_reading' } as const;

  // ── Already in the room ──────────────────────────────────────────────────
  //
  // **Below the referral since r5, and this round's own blind review found it.**
  // The referral was moved above θ_min because a detected discrepancy must not be
  // destroyed for being low-confidence — and `findDuplicate` was still upstream
  // of it, destroying the same discrepancy for a different reason. The input:
  // quote "Alice will not deploy production Friday", statement "Alice will deploy
  // production Friday", against a room that has already accepted the affirmative
  // from the same message. Without `acceptedObjects` the verdict was
  // `receipt_not_certifiable`; with it, `duplicate_of_accepted` — the dropped
  // `not` deleted rather than shown, by the check whose whole job is to suppress
  // things nobody needs to see.
  //
  // A duplicate is a reading the room already has. A referral is a reading the
  // room has *never* been shown, carrying a discrepancy it has never seen, and
  // the two are not the same thing however similar the sentences look.
  const duplicate = context.acceptedObjects
    ? findDuplicate(proposal.type, payload, proposal.provenance, context.acceptedObjects)
    : null;
  if (duplicate) {
    return {
      ...judged,
      attribution,
      verdict: 'discard',
      visibility: 'none',
      rule: 'duplicate_of_accepted',
      duplicateOf: duplicate.objectId,
      reason: `the room already accepted "${duplicate.objectId}" from the same messages, saying the same thing`,
    };
  }

  // ── A person staged this ─────────────────────────────────────────────────
  //
  // θ does not apply. #4's thresholds calibrate *extraction* confidence, and a
  // person's self-report is not that number — it is not a number at all. A
  // human-staged reading goes to the room to be judged, which is what staging
  // means. (A person writing a fact outright uses `answerBinding` or direct
  // acceptance; they do not need a proposal.)
  if (proposal.proposer.kind === 'human') {
    // …with one exception that is not about θ at all: a person naming *somebody
    // else* on a commitment is still somebody else's sentence, and #4's rule
    // does not care whether a machine or a colleague wrote it. The named owner
    // is the one asked, and that is what the attention panel reads to decide
    // whose confirm this is.
    const staged = proposal.proposer.userId;
    const namesAnother =
      proposal.type === 'commitment' && attributedTo !== null && attributedTo !== staged;
    return {
      ...judged,
      verdict: 'pending',
      visibility: 'needs_you',
      attribution: proposal.type === 'commitment' ? (namesAnother ? 'third_party' : 'self') : null,
      awaitingConfirmFrom: namesAnother ? attributedTo : null,
      rule: 'human_proposer',
      reason: namesAnother
        ? `staged by user "${staged}", who named "${attributedTo}" as owner — it waits for "${attributedTo}" to confirm; nobody gets committed by someone else's sentence (#4), whoever wrote it`
        : `staged by user "${staged}" — a person's reading goes to the room to be accepted, not through θ`,
    };
  }

  // ── Below the discard line ───────────────────────────────────────────────
  //
  // Reached only with a receipt nothing found fault with, which is what makes
  // discarding safe: there is no detected discrepancy here to destroy, only a
  // model that is not convinced by its own reading.
  if (proposal.confidence < rule.thetaMin) {
    return {
      ...judged,
      attribution,
      verdict: 'discard',
      visibility: 'none',
      rule: 'below_theta_min',
      reason: `confidence ${proposal.confidence} is below θ_min ${rule.thetaMin} for ${proposal.type} — discarded rather than shown; an unconvincing "~" still costs someone's attention, and its receipt held, so nothing is being thrown away except a weak reading`,
    };
  }

  // ── The band: θ_min ≤ c < θ_auto ─────────────────────────────────────────
  //
  // One cell for every type, decisions included. Shown quietly in current state
  // as unconfirmed, never in Needs-you — #4, and the reasoning is that an
  // uncertain reading is not worth a person's turn, only their glance.
  if (proposal.confidence < rule.thetaAuto) {
    return {
      ...judged,
      attribution,
      verdict: 'pending',
      visibility: 'quiet',
      rule: 'theta_band',
      reason: `confidence ${proposal.confidence} is between θ_min ${rule.thetaMin} and θ_auto ${rule.thetaAuto} for ${proposal.type} — shown quietly in current state as unconfirmed, never in Needs-you unless it blocks something`,
    };
  }

  // ── At or above θ_auto, and somebody else's name is on it ────────────────
  //
  // **Before the never-auto-accepts row since r5**, because r5 moved commitment
  // into that row and the general refusal would otherwise have swallowed the
  // specific one. Both end in `pending, needs_you`; only this one knows *whose*
  // Needs-you, and `awaitingConfirmFrom` is what the attention panel reads to
  // put it in front of the person being committed rather than the room.
  if (proposal.type === 'commitment' && attribution === 'third_party') {
    return {
      ...judged,
      attribution,
      verdict: 'pending',
      visibility: 'needs_you',
      awaitingConfirmFrom: attributedTo,
      rule: 'third_party_commitment',
      reason: `"${attributedTo}" is named as owner but did not write the message this was read out of — surfaced to them to confirm, and accepted only on that confirm; nobody gets committed by someone else's sentence (#4)`,
    };
  }

  // ── At or above θ_auto, but this type never auto-accepts ─────────────────
  //
  // Three types are in this row since r5: decision (#4's absolute), commitment
  // and objective (see `DEFAULT_ACCEPTANCE_RULES`). The rule is read off the
  // table rather than named here, so a type joining or leaving the row changes
  // one line of data.
  if (!rule.autoAccept) {
    return {
      ...judged,
      attribution,
      verdict: 'pending',
      visibility: 'needs_you',
      rule: 'never_auto_accepts',
      reason: `a ${proposal.type} never auto-accepts at any confidence (#4) — at ${proposal.confidence} the pass is confident, so it goes to Needs-you for a person to accept or decline; the room's current state is unsettled until somebody rules on it`,
    };
  }

  // ── …and above θ_auto for text that could be an undertaking ──────────────
  //
  // **r7, and the last place a proposal chose the rule that judged it.** Every
  // check above this line reads the *message bodies* and asks whether the
  // proposal is faithful to them. `proposal.type` is not in the bodies — the
  // model supplies it — and until r7 it selected `rule` on line one of this
  // function. One body, one quote, one author, confidence 0.95: minted as a
  // `commitment` the verdict was `pending / never_auto_accepts`, minted as a
  // `claim` it was `auto_accept`. The cheaper variant needed no type change at
  // all, only the *lowest* θ in the table: an ordinary declarative sentence
  // minted as an `open_question` at 0.65 auto-accepted where the same sentence
  // as a `claim` sat in `theta_band`. (That half is closed in the receipt
  // instead, by `statement_is_not_a_question` — an interrogative is a property
  // of the text, so it is certifiable rather than merely refused.)
  //
  // **Why this row and not a receipt problem, measured.** The first
  // implementation was a `refer`-severity provenance problem, which is where the
  // adjudication's words point. 78 of 1027 tests fell and the shape of the fall
  // refused it: a `refer` outranks θ, so a claim at 0.4999 — a reading the table
  // says to *discard* — came back `pending`, and the whole θ band came back
  // `receipt_not_certifiable`. That empties the discard cell into Needs-you. The
  // gap was that the type picked the rule, so the repair belongs where the rule
  // is picked: below θ_min still discards, the band still bands, and only this
  // one cell moves.
  //
  // **And why it reads the text rather than the type, measured too.** The second
  // implementation asked whether the *type* was certifiable and answered no for
  // every claim, on the correct ground that claim, commitment, decision and
  // objective are the same characters. Run against a plain declarative genuinely
  // in the record — *"The migration is reversible and can be rolled back
  // cleanly."*, quoted verbatim, clean receipt, window extending past it — it
  // moved `auto_accept` to `pending` at **every** confidence at or above θ_auto.
  // That is not closing a laundering hole, it is deleting the auto-accept path:
  // θ_auto exists so a reading genuinely in the record lands without a person's
  // turn. The hole it bought is bounded and visible — a commitment filed as a
  // claim renders as `~` with its quote, not asserted as fact and in nobody's
  // Needs-you — and an empty Current-state pane is neither.
  //
  // So the question is *"could these words be an undertaking"* rather than *"is
  // this type provable"*, and `readsAsCommitment` is read over the statement,
  // which the receipt above has already proved is the author's own words. The
  // reducer reads the same predicate over the same text; the floor stays keyed
  // to `autoAccept`, because a rule about the text cannot live in a table keyed
  // by type.
  //
  // **Over the normalized statement, r8.** The paragraph above says the receipt
  // "has already proved" the statement is the author's own words. What it proved
  // is that the two texts are equal *under `normalizeForReceipt`*, and this line
  // used to hand the predicate the raw statement — so a zero-width space spliced
  // into one word evaded all ten shapes while the receipt stayed clean.
  const statement = normalizeForReceipt(payloadText(proposal.type, payload));
  if (!typeCertifiableFromText(proposal.type, statement)) {
    return {
      ...judged,
      attribution,
      verdict: 'pending',
      visibility: 'needs_you',
      rule: 'type_not_certified',
      reason: `the quoted words read as something somebody is undertaking to do as easily as something they are asserting, and a receipt proves who wrote a sentence rather than what kind of act it was — filed as a ${proposal.type} it would be accepted on the proposal's own word for the one thing the record cannot settle, so at ${proposal.confidence} it goes to Needs-you with its quote for a person to accept or decline`,
    };
  }

  return {
    ...judged,
    attribution,
    verdict: 'auto_accept',
    visibility: 'accepted',
    rule: 'auto_accept',
    reason: `confidence ${proposal.confidence} is at or above θ_auto ${rule.thetaAuto} for ${proposal.type} — accepted as "~"; nothing model-accepted renders as a fact`,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Answer-binding
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * "Your next message resolves it, nothing is inferred."
 *
 * The one path that reaches an accepted Decision without a model in it. A person
 * clicks an open question, writes a reply, and that reply *is* the answer — no
 * proposal is staged, no confidence is computed, nothing is extracted. #4 names
 * this as one of exactly two ways a decision is ever accepted.
 *
 * It is a **command**, not an interpretation: this turns the command into the
 * two events the reducer will fold, and both the object id and the event ids
 * come from the caller. No clock, no uuid, no randomness — hand it the same
 * command twice and you get byte-identical events, which is what makes the whole
 * path replayable.
 *
 * **The actor is not in here.** It is the same trusted argument the reducer
 * takes, for the same reason: a command that carried its own actor would be a
 * self-declared human, and this is the one path that mints an accepted decision.
 */
export interface AnswerBindingCommand {
  /** Event timestamp; also the objects' created/updated time. */
  at: Timestamp;
  roomId: Id;
  /** The open question being answered. */
  questionObjectId: Id;
  /** What the answer is. A decision or a claim — those are what `answers` targets. */
  answer:
    | { type: 'decision'; objectId: Id; payload: DecisionPayload }
    | { type: 'claim'; objectId: Id; payload: ClaimPayload };
  /** The message that carried the answer, and any others it rests on. */
  messageIds: readonly Id[];
  /** Caller-supplied ids: purity is the point. */
  ids: { acceptEventId: Id; relationEventId: Id; relationId: Id };
  /** Carried onto the created object. */
  objectiveId?: Id | null;
}

/**
 * Why this binding cannot be performed against this state, or `null`.
 *
 * Checked here so a caller can refuse before minting events, and checked again
 * by the reducer because a check that only runs upstream is not a check.
 *
 * The ordering rule is the one worth explaining. The two events share a
 * timestamp, so the canonical `(at, id)` order breaks the tie on the *ids the
 * caller chose* — and if the relation sorts first it arrives before the object
 * it points at, fails on an unknown target, and the question stays open with the
 * answer accepted next to it. Round 1's gauntlet found it; the fix is to refuse
 * the command rather than to hope, because ids are the caller's to pick and the
 * caller can pick again.
 */
export function answerBindingRefusal(
  state: CoreState,
  command: AnswerBindingCommand,
  actor: Actor,
): string | null {
  if (actor.kind !== 'human') {
    return 'answer-binding is a person answering a question — only a human may bind an answer, and a model must go through a proposal';
  }
  const record = state.objects[command.questionObjectId];
  if (!record) return `unknown open question "${command.questionObjectId}"`;
  if (record.object.type !== 'open_question') {
    return `object "${command.questionObjectId}" is a ${record.object.type}, not an open question — only a question can be answered`;
  }
  if (record.retractedAt !== null) {
    return `open question "${command.questionObjectId}" is retracted — restore it before answering`;
  }
  if (record.object.payload.status !== 'open') {
    return `open question "${command.questionObjectId}" is already answered — reopen it before binding a different answer, so the room can see that it was settled twice`;
  }
  if (record.object.roomId !== command.roomId) {
    return `open question "${command.questionObjectId}" is in room "${record.object.roomId}", not "${command.roomId}"`;
  }
  if (state.objects[command.answer.objectId]) {
    return `object "${command.answer.objectId}" already exists`;
  }
  const { acceptEventId, relationEventId } = command.ids;
  if (
    compareCursor({ at: command.at, id: acceptEventId }, { at: command.at, id: relationEventId }) >=
    0
  ) {
    return `answer-binding event ids are out of order: the acceptance "${acceptEventId}" must sort strictly before the relation "${relationEventId}" at ${command.at}, or the edge arrives before the object it points at and the question is left open beside its own answer — pick ids whose order matches`;
  }
  return null;
}

/**
 * The events an answer-binding produces: accept the answer, then point the
 * question at it. The `answers` edge is what flips the question to `answered`,
 * so the ordering is load-bearing and `answerBindingRefusal` enforces it.
 *
 * Each event comes back paired with the trusted actor, because that is the shape
 * the reducer folds — the caller passes the pairs straight through.
 */
export function answerBindingEvents(command: AnswerBindingCommand, actor: Actor): AuthoredEvent[] {
  const { answer } = command;
  const object = {
    id: answer.objectId,
    roomId: command.roomId,
    objectiveId: command.objectiveId ?? null,
    type: answer.type,
    payload: answer.payload,
    provenance: {
      messageIds: [...command.messageIds],
      // The whole point: no proposal. A person's word is not an interpretation
      // that needs accepting, and the reducer only lets a human do this.
      proposalId: null,
      interpretationId: null,
    },
    createdAt: command.at,
    updatedAt: command.at,
  };

  const events = [
    {
      id: command.ids.acceptEventId,
      at: command.at,
      type: 'object_accepted',
      object,
    },
    {
      id: command.ids.relationEventId,
      at: command.at,
      type: 'relation_added',
      relation: {
        id: command.ids.relationId,
        roomId: command.roomId,
        kind: 'answers',
        fromObjectId: command.questionObjectId,
        to: { kind: 'object', objectId: answer.objectId },
        note: null,
        createdAt: command.at,
      },
    },
  ] as CoreEvent[];

  return events.map((event) => authored(event, { actor }));
}

/** Refusal or events, in one call. */
export function bindAnswer(
  state: CoreState,
  command: AnswerBindingCommand,
  actor: Actor,
): { ok: true; events: AuthoredEvent[] } | { ok: false; refusal: string } {
  const refusal = answerBindingRefusal(state, command, actor);
  if (refusal !== null) return { ok: false, refusal };
  return { ok: true, events: answerBindingEvents(command, actor) };
}

/**
 * Bind an answer **as one command**: either both events land, or the state comes
 * back untouched.
 *
 * `bindAnswer` mints the pair and leaves applying them to the caller, which is
 * right for a command layer that has to persist them. But a caller that folds
 * them one at a time can land the acceptance, have the relation refused, and
 * leave the room with an answer nobody asked and a question nobody answered —
 * two events, one meaning, no transaction. So the atomic form exists, and it is
 * the one to reach for by default.
 *
 * Nothing is mutated: on refusal the *same state object* comes back, exactly as
 * `appendEvent` does for a rejection.
 */
export function applyAnswerBinding(
  state: CoreState,
  command: AnswerBindingCommand,
  actor: Actor,
):
  | { ok: true; state: CoreState; events: AuthoredEvent[] }
  | { ok: false; state: CoreState; refusal: string } {
  const bound = bindAnswer(state, command, actor);
  if (!bound.ok) return { ok: false, state, refusal: bound.refusal };

  let next = state;
  for (const entry of bound.events) {
    const result = appendEvent(next, entry.event, trustedContext({ actor: entry.actor }));
    if (result.outcome !== 'applied') {
      const why =
        result.outcome === 'rejected' || result.outcome === 'malformed'
          ? result.detail
          : result.issues.map((issue) => issue.reason).join('; ');
      return {
        ok: false,
        state,
        refusal: `answer-binding "${command.ids.acceptEventId}" was rolled back: event "${entry.event.id}" ${result.outcome} — ${why}`,
      };
    }
    next = result.state;
  }
  return { ok: true, state: next, events: bound.events };
}
