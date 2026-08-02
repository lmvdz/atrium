import type { EscalationMessage } from '../src/index.js';

/**
 * Message shapes drawn from the interpretation spike's corpus.
 *
 * Source: `research/spike/window-B.txt` on branch `research/interpretation-spike`
 * — a real four-message argument out of microsoft/TypeScript#9998 that ends in a
 * concession. It is here rather than invented because the three things these
 * fixtures have to exercise are things nobody writes on purpose:
 *
 *  - a GitHub reply-blockquote that reproduces another person's whole paragraph,
 *    which is what made the spike's worst error possible (a claim attributed to
 *    jordanbtucker at confidence 0.98, citing two of *dhlolo's* messages, whose
 *    quoted sentence exists in them only because dhlolo quoted him);
 *  - a concession buried at the end of a long quote-reply ("Honestly, you are
 *    right"), which is the retraction chain the whole escalation tier exists for;
 *  - code fences, markdown emphasis, playground URLs and nested `> >` quoting,
 *    which is what the normalizer has to survive.
 *
 * Trimmed for length — the code blocks and playground links are shortened — but
 * the quoting structure, the authorship and the wording are verbatim.
 */

export const JORDAN = 'jordanbtucker';
export const DHLOLO = 'dhlolo';
export const MARTIN = 'MartinJohns';

const JORDAN_OPENER =
  "I just ran into a problem with this for the first time despite using TypeScript for years.\n\nHere's a simplified example to demonstrate. Essentially, my class has a property. That property can be changed by a method, but TypeScript doesn't think it can.\n\n```ts\nclass Foo {\n  state: 'online' | 'offline' = 'online'\n\n  foo() {\n    if (this.state !== 'online') return\n    this.bar()\n    if (this.state === 'offline') return\n  }\n}\n```";

/** m1 — jordanbtucker opens. No quote, no concession, no future tense. */
export const messageOpener: EscalationMessage = {
  id: 'msg_c2094541944',
  authorId: JORDAN,
  body: JORDAN_OPENER,
};

/**
 * m2 — dhlolo replies by quoting the whole of m1, then adds two lines of his
 * own. Every word of jordanbtucker's paragraph is in this message, and
 * jordanbtucker wrote none of *this* message. This is the trap.
 */
export const messageQuotingOpener: EscalationMessage = {
  id: 'msg_c2094548285',
  authorId: DHLOLO,
  body: `${JORDAN_OPENER.split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\nThe error occurs on line 8 not line 5, right? I think it works as intended.`,
};

/** m3 — jordanbtucker quotes the error message and disputes the reading. */
export const messageDispute: EscalationMessage = {
  id: 'msg_c2094551807',
  authorId: JORDAN,
  body: `@dhlolo The error occurs on line 7.\n\n> This comparison appears to be unintentional because the types '"online"' and '"offline"' have no overlap.(2367)\`\n\nLine 5 contains \`if (this.state !== 'online') return\`, not line 8.\n\nWhile TypeScript is correct that \`this.state\` must be \`'online'\` immediately after line 5, line 6 (\`this.bar()\`) changes that, so TypeScript *should not* be so confident that \`this.state\` is still \`'online'\` after line 6.`,
};

/**
 * m4 — the concession, at the end of a long quote-reply. The spike's one real
 * supersession, and the default pass never proposed it.
 */
export const messageConcession: EscalationMessage = {
  id: 'msg_c2094576921',
  authorId: DHLOLO,
  body: `> The problem is that TypeScript assumes that \`this.state\` can't have been changed at all.\n\nHonestly, you are right. It seems to be too optimistic in your case which class method may set class property. But other choices could be assuming that all method could change property(which seems to be too pessimistic), or analyse deeper(which may make things much more complicated).`,
};

/** A plain technical message: none of the four triggers should fire on it. */
export const messageOrdinary: EscalationMessage = {
  id: 'msg_c2096766082',
  authorId: 'craigphicks',
  body: "It's not uncommon to see member functions named `XXXMutating` or `XXXNonMutating()` or similar, especially in a garbage collected language like JS. That's because there may be multiple agents referencing the same object that depend upon that object not changing.",
};

/**
 * A message in the shape #4 spends most of its length on, and which the public
 * RFC corpus never produced once — named-person future tense, i.e. somebody
 * committing somebody else. Written rather than drawn, and #24 flags the gap:
 * the attribution rules are untestable on a public technical thread.
 */
export const messageThirdPartyCommitment: EscalationMessage = {
  id: 'msg_synthetic_commitment',
  authorId: JORDAN,
  body: '@dhlolo will take the narrowing fix and land it before the 5.5 branch cuts. Can you also check whether the playground repro still fails on nightly?',
};

/** The window in room order, as the worker would hand it over. */
export const spikeWindow: EscalationMessage[] = [
  messageOpener,
  messageQuotingOpener,
  messageDispute,
  messageConcession,
  messageOrdinary,
];
