import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type EscalationMessage,
  type EscalationTriggerKind,
  evaluateEscalation,
  triggersForMessage,
} from '@atrium/core';
import { describe, expect, it } from 'vitest';
import { MalformedModelOutputError } from '../src/jobs/provider.js';

/**
 * Two-tier routing, measured against the corpus #25 will replay.
 *
 * The routing rule is #8's amendment: compute deterministic text triggers on
 * the raw window before any call, and escalate the whole window when any of
 * them fires. This file exists because the *rate* that rule produces is not
 * something anybody has measured, and the cost model in #7 depends on it.
 */

const CORPUS = fileURLToPath(new URL('../../../corpora/ts9998.jsonl', import.meta.url));

function corpusMessages(): EscalationMessage[] {
  return readFileSync(CORPUS, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { author: string; text: string })
    .map((line, index) => ({ id: `m${index}`, authorId: line.author, body: line.text }));
}

/** Fraction of consecutive `size`-message windows that escalate. */
function escalationRate(messages: readonly EscalationMessage[], size: number): number {
  let escalated = 0;
  let windows = 0;
  for (let start = 0; start < messages.length; start += size) {
    const window = messages.slice(start, start + size);
    if (window.length === 0) continue;
    windows += 1;
    if (
      evaluateEscalation({ messages: window, priorMessages: messages.slice(0, start) }).escalate
    ) {
      escalated += 1;
    }
  }
  return escalated / windows;
}

describe('the escalation trigger set', () => {
  /**
   * Mutation: add a confidence band back as a fifth trigger — #8's original
   * θ-band rule. It cannot be computed here at all, because there is no model
   * output at this point in the pipeline; a trigger that needs one is a trigger
   * that costs a second call, and "one coalesced call per burst" stops holding.
   * The spike also measured confidence at 0.937 on the objects judged wrong
   * against 0.928 on the ones judged right, so it would be a second call bought
   * with noise.
   */
  it('is exactly the four deterministic pre-call kinds', () => {
    const messages = corpusMessages();
    const fired = new Set<EscalationTriggerKind>();
    for (const [index, message] of messages.entries()) {
      for (const trigger of triggersForMessage(message, messages.slice(0, index))) {
        fired.add(trigger.kind);
      }
    }
    // The fourth needs an accepted decision to overlap with, which a corpus
    // alone cannot supply — so it is reached explicitly rather than left
    // unmeasured. All four are reachable; nothing else is.
    const overlap = triggersForMessage(
      { id: 'x', authorId: 'alice', body: 'the control flow analysis work is what we settled on' },
      [],
      [{ objectId: 'o1', statement: 'the control flow analysis work is what we settled on' }],
    );
    for (const trigger of overlap) fired.add(trigger.kind);

    expect([...fired].sort()).toEqual([
      'accepted_decision_overlap',
      'concession_marker',
      'named_person_future',
      'reply_blockquote',
    ]);
  });

  /**
   * Mutation: any change to the trigger set, the markers, or the overlap
   * threshold moves these numbers. That is the point — this is a measurement
   * pinned so it cannot drift silently, not a property being asserted.
   *
   * ## WHAT THESE NUMBERS SAY, AND IT IS NOT GOOD NEWS
   *
   * The rule is per **window**, and a window is a coalesced burst. On the 111
   * messages of `ts9998.jsonl`:
   *
   *   per message      35% fire a trigger
   *   5-message window 91% escalate
   *   10-message       100%
   *   20-message       100%
   *
   * #7 priced the pipeline on the escalation tier firing for "the ~10–15% of
   * messages that carry load" — $1.00 per 1k messages on the default pass
   * against $9.00 on the escalation tier. At the shipped window size the
   * default pass never runs on this corpus, so the pipeline is the escalation
   * tier's price, not a blend of the two.
   *
   * This is the mirror image of the defect #8's amendment was written to fix.
   * There, the escalation tier was dead code because its triggers read a signal
   * the default pass never produced; here the *default* pass is dead code
   * because a 10-message window of real conversation almost always contains one
   * concession, one "@name will", or one quote-reply.
   *
   * It is left as a measurement rather than repaired, because every repair is a
   * product decision that belongs to #8 and not to this ticket: escalate only
   * the *messages* that fired rather than the window; require two triggers;
   * weight them; or accept the price and drop the tiering. `InterpretRunResult`
   * carries `tier` and `triggers`, and the pass logs both with the cost, so the
   * decision can be made against a bill rather than against this estimate.
   */
  it('escalates every 10- and 20-message window of the replay corpus', () => {
    const messages = corpusMessages();
    expect(messages).toHaveLength(111);

    expect(escalationRate(messages, 1)).toBeCloseTo(39 / 111, 3);
    expect(escalationRate(messages, 5)).toBeCloseTo(21 / 23, 3);
    expect(escalationRate(messages, 10)).toBe(1);
    expect(escalationRate(messages, 20)).toBe(1);
  });

  /**
   * The history does not decide the tier — it supplies the *receipt*.
   *
   * `reply_blockquote` fires on any substantive blockquote, deliberately: a
   * quote-reply in a 20-message window routinely points at message 3 of a
   * 400-message thread, so requiring the match would drop the chains the
   * trigger exists to catch. What the history buys is `matched` — the earlier
   * message the quote points at, which is what a person reads to see why the
   * escalation tier was paid for.
   *
   * Mutation: stop passing `priorMessages` from the worker. The tier is
   * unchanged, so no test of the routing would notice; every escalation just
   * stops being able to say what it was a reply to.
   */
  it('uses the history to name which earlier message a reply-blockquote points at', () => {
    const earlier: EscalationMessage = {
      id: 'a',
      authorId: 'alice',
      body: 'We are going with Postgres for the queue and nothing else.',
    };
    const reply: EscalationMessage = {
      id: 'b',
      authorId: 'bob',
      body: '> We are going with Postgres for the queue and nothing else.\n\nFine.',
    };
    const blind = evaluateEscalation({ messages: [reply] });
    expect(blind.escalate).toBe(true);
    expect(blind.triggers[0]?.matched).toBeNull();

    const seeing = evaluateEscalation({ messages: [reply], priorMessages: [earlier] });
    expect(seeing.escalate).toBe(true);
    expect(seeing.triggers[0]?.matched).toBe(earlier.id);
  });
});

describe('malformed output is its own error class', () => {
  /**
   * Mutation: throw a bare `Error` for output the schema refuses. The job can
   * then no longer tell "the model said something malformed" — retryable,
   * dead-letterable, and the operator needs the raw text — from "the database
   * is down", which is retryable for an entirely different reason and whose DLQ
   * entry would be useless without the query.
   */
  it('carries the raw text the model actually returned', () => {
    const error = new MalformedModelOutputError('not an object', '{"readings": ');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MalformedModelOutputError');
    expect(error.rawText).toBe('{"readings": ');
  });

  /**
   * Mutation: default `rawText` to `''`. An empty string reads as "the model
   * returned nothing", which is a different fact from "the SDK could not
   * recover what it returned" — and the DLQ alert is the only place either is
   * ever read.
   */
  it('keeps "we could not recover it" distinct from "it was empty"', () => {
    expect(new MalformedModelOutputError('x', null).rawText).toBeNull();
    expect(new MalformedModelOutputError('x', '').rawText).toBe('');
  });
});
