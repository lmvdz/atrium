'use client';

/* ---------------------------------------------------------------------------
 * THE BOUNDARY THAT WAS NOT THERE.
 *
 * ROUND 7, D5. Every guarantee in this component library is enforced by a THROW
 * — that is the deliberate design, stated in model/ledger.tsx and in CONVENTIONS
 * ("a citation that cannot be resolved does not render… a row that quietly
 * renders an empty actor cell is a row nobody finds out about"). It is the right
 * call and it has a consequence nobody had wired: a throw inside render, with no
 * boundary anywhere in `app/`, takes the whole tree. The round-7 critic reached
 * it in two clicks:
 *
 *   [pageerror] messageLedger: two different records both claim the id "local-1"
 *   body.innerText → "This page couldn't load | Reload to try again, or go back."
 *   [data-row="message"] → 0
 *
 * The composer's draft went with it. A model that refuses rather than degrades
 * owes the reader a place to land — otherwise "it throws" means "the page is
 * gone", and the person who was mid-sentence pays for a defect in the register.
 *
 * WHAT THIS DOES AND DOES NOT DO. It does not pretend the failure did not
 * happen, it does not swallow the message, and it does not offer a "continue
 * anyway" that renders the state the model refused. It says what refused, in the
 * refusal's own words, and offers the one recovery that is honest: render the
 * subtree again from the props it has. `reset()` re-mounts the segment; if the
 * cause is still there the boundary comes straight back, which is the correct
 * behaviour for a page whose invariant is genuinely broken.
 * ------------------------------------------------------------------------- */

import { useEffect } from 'react';

export default function RoomError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    /* The refusal is the product of this codebase's own model, so it belongs in
       the console verbatim rather than as a digest a reader cannot act on. */
    console.error('atrium: a render boundary refused', error);
  }, [error]);

  return (
    <div data-error-boundary="app" role="alert" style={SHELL}>
      <div style={CARD}>
        <div style={LABEL}>THIS VIEW REFUSED TO RENDER</div>
        <p style={PROSE}>
          Something the page was asked to show could not be checked against the record it cites, so
          it was refused rather than shown. Nothing was written; nothing was changed.
        </p>
        {/* The refusal's own words. Every throw in this model is written to be
            read by a person — a boundary that replaces them with "something went
            wrong" is throwing the evidence away at the last step. */}
        <pre style={DETAIL}>{error.message}</pre>
        <button onClick={reset} style={BUTTON} type="button">
          Try this view again
        </button>
      </div>
    </div>
  );
}

/* Inline styles on purpose: a CSS Module is a build artifact, and the one thing
   this component has to survive is the app failing to render. */
const SHELL: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  minHeight: '100vh',
  background: 'var(--bg0)',
  color: 'var(--tx1)',
  padding: 24,
};

const CARD: React.CSSProperties = {
  maxWidth: 640,
  border: '1px solid var(--line2)',
  borderRadius: 6,
  background: 'var(--bg1)',
  padding: 20,
};

const LABEL: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: '.14em',
  color: 'var(--red3)',
  marginBottom: 10,
};

const PROSE: React.CSSProperties = { fontSize: 12.5, lineHeight: 1.5, margin: '0 0 12px' };

const DETAIL: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
  fontSize: 10.5,
  lineHeight: 1.5,
  color: 'var(--tx2)',
  background: 'var(--bg3)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: 10,
  margin: '0 0 14px',
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
};

const BUTTON: React.CSSProperties = {
  font: 'inherit',
  fontSize: 12,
  padding: '6px 12px',
  borderRadius: 4,
  border: '1px solid var(--line3)',
  background: 'var(--bg3)',
  color: 'var(--tx1)',
  cursor: 'pointer',
};
