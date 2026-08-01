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
import type { Attribution, MessageLedger, MessageRecord, Quotation } from './quotation';
import { messageLedger, resolveQuotation } from './quotation';

const LedgerContext = createContext<MessageLedger | null>(null);

export interface AttributionLedgerProps {
  /**
   * The records this subtree may cite. Either the raw records (the usual case —
   * the same register the feed was built from) or a prebuilt ledger.
   */
  readonly messages: Iterable<MessageRecord> | MessageLedger;
  readonly children: ReactNode;
}

function asLedger(messages: Iterable<MessageRecord> | MessageLedger): MessageLedger {
  return 'recordFor' in messages ? messages : messageLedger(messages);
}

export function AttributionLedger({ messages, children }: AttributionLedgerProps) {
  const ledger = useMemo(() => asLedger(messages), [messages]);
  return <LedgerContext.Provider value={ledger}>{children}</LedgerContext.Provider>;
}

/**
 * The ledger this subtree resolves against, or a throw. `from` names the caller
 * so the message says which boundary refused rather than which hook did.
 */
export function useMessageLedger(from: string): MessageLedger {
  const ledger = useContext(LedgerContext);
  if (ledger === null) {
    throw new Error(
      `${from}: rendered outside an <AttributionLedger>, so there is no record to check the attribution against.\n` +
        '  A quotation cites a message; printing one without the record it cites is how a name ends up over words that are not that person’s.',
    );
  }
  return ledger;
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
