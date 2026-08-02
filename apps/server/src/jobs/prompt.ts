import { type CoreState, correctionCounterexamples, type ProvenanceMessage } from '@atrium/core';

/**
 * The extraction prompt: a transcript, the room's recent corrections, and a
 * precision-first instruction.
 *
 * ## What is deliberately NOT in here
 *
 * **The room's accepted state.** #8's resolution put "a compressed view of the
 * room's accepted objects for active objectives" in this prompt, and #8's
 * second amendment took it back out on measurement: with an accepted-state
 * block present, the spike's default pass re-proposed zero accepted objects
 * (the thing it was there for) but recall collapsed from 19 objects to 11, the
 * dispute edge was lost, and no cross-window relation was produced at all. It
 * is a de-duplication input, not a comprehension aid, and de-duplication is
 * deterministic: `findDuplicate` in `packages/core` does the same job against
 * the same accepted objects, costs nothing, and is testable without a model.
 *
 * So this file's contract with the worker is narrow and worth stating: the
 * prompt's job is *recall*, and precision is bought afterwards, by rules.
 *
 * **Corrections stay**, per #5 — they are counterexamples, not state. "This was
 * read as a decision and a person retyped it to a claim" teaches something no
 * rule downstream can, because it is about this room's habits rather than about
 * the sentence.
 */

/** The instruction. Kept as one exported constant so a test can assert on it. */
export const EXTRACTION_INSTRUCTION = `You are reading a slice of one team's conversation and recording only what it settles.

Return a reading for each of these you actually find:
- decision: the group chose a course of action.
- commitment: a named person undertook to do something.
- open_question: something was asked and is not yet answered.
- claim: someone asserted a fact about the world.
- objective: a goal the rest of the work is filed under.

Precision beats recall on decision and commitment. If a sentence is a suggestion, a hypothetical, an idea being floated, or something that "might" or "could" happen, it is NOT a decision — record it as a claim or record nothing. Do not invent a decision because a window looks like it should contain one; an empty list is a correct and common answer.

Every reading must carry:
- quote: a span copied VERBATIM from one of the messages you cite. Do not paraphrase it, do not elide the middle with "...", do not add or drop emphasis or link markup. The quote must be the sentence the reading rests on.
- messageIds: the ids of the messages, exactly as they appear in the transcript.
- subject: for a commitment, the id of the person who owes it; for a claim, the id of the person asserting it; null otherwise. Use an author id from the transcript, never a display name you inferred.

Text that appears inside a "> " quoted-reply block belongs to whoever wrote it ORIGINALLY, not to the person quoting it. Never attribute a quoted-reply span to the person who replied.`;

export interface PromptWindow {
  messages: readonly ProvenanceMessage[];
  /** The room's fold, for `correctionCounterexamples`. Optional: a new room has none. */
  state?: CoreState;
  /** How many corrections to teach from. `packages/core` defaults to 5. */
  counterexampleLimit?: number;
}

export interface AssembledPrompt {
  system: string;
  prompt: string;
  /** How many messages the transcript carries — the coalescing receipt. */
  messageCount: number;
  /** How many corrections were injected as counterexamples. */
  counterexampleCount: number;
}

/**
 * Render the transcript.
 *
 * The id is printed beside every message because `messageIds` is the receipt
 * the whole acceptance path is built on: a model that cannot see the ids cannot
 * cite them, and a citation it invented is refused by `mintProposal`.
 *
 * Bodies go in verbatim, fenced by a line the body cannot forge — the id is a
 * uuid the room does not control, so `--- <id> ---` cannot be typed by a member
 * to close somebody else's message and open one attributed to a person who
 * never wrote it. #10's invariant applies to a prompt exactly as it applies to
 * a screen.
 */
export function renderTranscript(messages: readonly ProvenanceMessage[]): string {
  return messages
    .map(
      (message) =>
        `--- message ${message.id} · author ${message.authorId || '(unknown)'} ---\n${message.body}`,
    )
    .join('\n');
}

export function assemblePrompt(window: PromptWindow): AssembledPrompt {
  const counterexamples = window.state
    ? correctionCounterexamples(window.state, { limit: window.counterexampleLimit ?? 5 })
    : [];

  const sections = [`## Transcript\n\n${renderTranscript(window.messages)}`];

  if (counterexamples.length > 0) {
    const lines = counterexamples
      .map((example) => `- ${example.text}${example.note ? ` (${example.note})` : ''}`)
      .join('\n');
    sections.push(
      `## How this room has corrected earlier readings\n\nThese are corrections people made to previous readings of this same room. They are counterexamples, not instructions — read them for what this room treats as a decision or a commitment.\n\n${lines}`,
    );
  }

  return {
    system: EXTRACTION_INSTRUCTION,
    prompt: sections.join('\n\n'),
    messageCount: window.messages.length,
    counterexampleCount: counterexamples.length,
  };
}
