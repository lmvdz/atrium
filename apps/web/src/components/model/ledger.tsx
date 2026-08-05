'use client';

/* ---------------------------------------------------------------------------
 * THE ATTRIBUTION LEDGER — how a render boundary looks a citation up.
 *
 * A `Quotation` is a message id and nothing else (model/quotation.ts). Whatever
 * a component prints beside quoted words — the name, the time, the words — is
 * derived from the RECORD, here, at the moment of rendering. Round 4's forgery
 * was `{...quotationFrom(msg)!, actor: 'priya'}`; there is no field to overwrite
 * any more, and if there were, nothing would read it.
 *
 * WHY A CONTEXT AND NOT A PROP.
 *
 * The ticket's scope boundary is "props-driven with zero data fetching and zero
 * global state", and this is neither a fetch nor global state: it is a value
 * handed in at the top of a subtree, scoped to that subtree, with no setter and
 * no mutation. The alternative — threading `messages` through Timeline, every
 * row, the composer, the receipt and the lens — puts the ledger on a dozen prop
 * tables where a caller can pass a DIFFERENT one to different rows, which is the
 * "two sources of truth" shape this ticket has spent four rounds deleting.
 *
 * WHAT HAPPENS WITH NO LEDGER: it throws. Not a fallback, not a degraded render,
 * not "" for the actor. An audit may not exempt the case its rule covers
 * (CONVENTIONS), and neither may a renderer: a quotation nobody can resolve is a
 * quotation nobody should be printing.
 * ------------------------------------------------------------------------- */

import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import type {
  Attribution,
  Citation,
  MessageLedger,
  MessageRecord,
  Quotation,
  SourceLocation,
} from './quotation';
import { messageLedger, resolveCitation, resolveQuotation, sourceLocation } from './quotation';

interface Register {
  readonly ledger: MessageLedger;
  /** the room this subtree is rendering — the other half of "is this here?" */
  readonly here: string;
}

const LedgerContext = createContext<Register | null>(null);

export interface AttributionLedgerProps {
  /**
   * The records this subtree may cite. Either the raw records (the usual case —
   * the same register the feed was built from) or a prebuilt ledger.
   */
  readonly messages: Iterable<MessageRecord> | MessageLedger;
  /**
   * THE ROOM THIS SUBTREE IS SHOWING. Required, and required here rather than on
   * three component prop tables.
   *
   * ROUND 8, D3: three render boundaries answered "is this message's source in
   * this room?" from ONE operand — whether the record carried a room at all —
   * because the room on screen was not available to any of them. The register is
   * where the other operand belongs: this provider already is "the records this
   * page holds", and which room the page is showing is the same kind of fact
   * about the same page. A comparison needs both sides in one scope; putting the
   * room here is what makes `sourceLocation` callable once instead of guessed at
   * three times.
   */
  readonly room: string;
  readonly children: ReactNode;
}

function asLedger(messages: Iterable<MessageRecord> | MessageLedger): MessageLedger {
  return 'recordFor' in messages ? messages : messageLedger(messages);
}

export function AttributionLedger({ messages, room, children }: AttributionLedgerProps) {
  const ledger = useMemo(() => asLedger(messages), [messages]);
  const register = useMemo(() => ({ ledger, here: room }), [ledger, room]);
  /* TWO REGISTERS IN ONE TREE IS NOT A CONFIGURATION, IT IS THE DEFECT.
     Found by the round-5 blind critic: nesting `<AttributionLedger>` silently
     took the inner one, so a subtree could resolve `m14` against a register the
     rest of the page had never seen — and nothing anywhere reported that two
     registers were live at once. React context is designed to shadow, which is
     right for a theme and wrong for the one thing on this page whose whole job
     is being the single source of truth about who wrote what.

     The inner provider refuses rather than shadowing. A page that genuinely
     needs a second record set builds ONE ledger out of both — `messageLedger`
     already throws when two records claim one id, which is the check that makes
     merging honest and shadowing dishonest. */
  const outer = useContext(LedgerContext);
  if (outer !== null && outer.ledger !== ledger) {
    throw new Error(
      'AttributionLedger: this subtree is already inside a record register, and nesting a second one shadows the first.\n' +
        '  Two registers in one tree is the state in which a name over words is a coin flip: the outer rows and the inner rows resolve the same message id against different records, and nothing reports it.\n' +
        '  Build one ledger from both record sets — `messageLedger` refuses two records claiming one id, which is the check nesting skips.',
    );
  }
  return <LedgerContext.Provider value={register}>{children}</LedgerContext.Provider>;
}

function useRegister(from: string): Register {
  const register = useContext(LedgerContext);
  if (register === null) {
    throw new Error(
      `${from}: rendered outside an <AttributionLedger>, so there is no record to check the attribution against.\n` +
        '  A quotation cites a message; printing one without the record it cites is how a name ends up over words that are not that person’s.',
    );
  }
  return register;
}

/**
 * The ledger this subtree resolves against, or a throw. `from` names the caller
 * so the message says which boundary refused rather than which hook did.
 */
export function useMessageLedger(from: string): MessageLedger {
  return useRegister(from).ledger;
}

/** The room this subtree is showing. The other operand of every "…, not here". */
export function useHere(from: string): string {
  return useRegister(from).here;
}

/**
 * WHERE A CITED MESSAGE IS, RELATIVE TO THE ROOM ON SCREEN.
 *
 * The one door for the question round 8's D3 was three wrong answers to. It
 * returns the record as well, because every caller needs both and looking the
 * record up twice is two lookups that can disagree.
 */
export function useCitedLocation(
  citation: Citation,
  from: string,
): { readonly record: MessageRecord; readonly location: SourceLocation } {
  const register = useRegister(from);
  const record = resolveCitation(register.ledger, citation, from);
  return { record, location: sourceLocation(record, register.here) };
}

/**
 * THE RENDER-BOUNDARY DERIVATION, in one call. Every component that prints a
 * name, a time or the words of a quotation goes through this and renders what it
 * returns — not what it was handed.
 */
export function useAttribution(quotation: Quotation, from: string): Attribution {
  const ledger = useMessageLedger(from);
  return resolveQuotation(ledger, quotation, from);
}

/**
 * THE SAME DERIVATION FOR A REFERENCE THAT IS NOT A QUOTATION.
 *
 * The receipt's link to a superseded page-authored answer, a chosen feed row,
 * the cross-room trace's target: all of them name a message, none of them may
 * be quoted, and before round 6 all of them were caller-supplied strings that
 * reached a handler without ever meeting the register. The display path and the
 * product path are two paths (CONVENTIONS); this is the product path's lookup.
 */
export function useCitedRecord(citation: Citation, from: string): MessageRecord {
  const ledger = useMessageLedger(from);
  return resolveCitation(ledger, citation, from);
}
