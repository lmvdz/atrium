/* ═══════════════════════════════════════════════════════════════════════════
 * CERTIFY A PASSAGE — the component, end to end (E8 / #197, P6F-3 r2).
 *
 * `certify-span.test.ts` proves the pure mapping; this proves the COMPONENT wires
 * it safely: a body convergence invalidates a pending selection, the fidelity
 * warning mounts only when the render diverges from the raw bytes, and — the r2
 * blocker — a hold begun before an edit never certifies the stale span, while a
 * fresh selection after the edit still does.
 * ═════════════════════════════════════════════════════════════════════════ */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CertifyPassage, type CertifyOutcome } from '../app/prototype/CertifyPassage';
import type { ObjectSpanRequest } from '../app/prototype/certify-span';
import { BODY_ROOT_ATTR } from '../app/prototype/certify-span';
import type { ChatMsg } from '../app/prototype/types';
import { ConversationDoc } from '../app/prototype/yjs-conversation';

/* The hold is an elapsed-time gate driven by `performance.now()` over a rAF chain;
   fake all of it so a full press is deterministic (see hold-to-act.test.tsx). */
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const OBJECT_ID = '00000000-0000-4000-8000-000000000000';

function seededDoc(...messages: ChatMsg[]): ConversationDoc {
  return new ConversationDoc().seed(messages);
}
function msg(id: string, text: string): ChatMsg {
  return { id, time: '12:00', kind: 'human', who: 'you', text };
}

/** The first descendant text node of the rendered certify-body root. */
function firstBodyTextNode(): Text {
  const root = document.querySelector(`[${BODY_ROOT_ATTR}]`);
  if (!root) throw new Error('certify body root not rendered');
  const walk = (n: Node): Text | null => {
    if (n.nodeType === 3) return n as Text;
    for (let i = 0; i < n.childNodes.length; i++) {
      const child = n.childNodes[i];
      const hit = child ? walk(child) : null;
      if (hit) return hit;
    }
    return null;
  };
  const node = walk(root);
  if (!node) throw new Error('certify body has no text node');
  return node;
}

/** Put a real DOM selection over `[from, to)` of the body's first text node, then
    fire the mouseup the surface listens on — the exact path a human drag produces. */
function selectChars(from: number, to: number) {
  const node = firstBodyTextNode();
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  act(() => {
    sel.removeAllRanges();
    sel.addRange(range);
    // The surface syncs on mouseup (and on selectionchange); fire the mouseup on the
    // body root's parent, the element that carries the handler.
    const root = document.querySelector(`[${BODY_ROOT_ATTR}]`) as HTMLElement;
    fireEvent.mouseUp(root.parentElement ?? root);
  });
}

function renderPane(doc: ConversationDoc, version: number, onCertify: CertifyPassageCertify) {
  return render(
    <CertifyPassage
      actor="lars"
      doc={doc}
      messageId="m1"
      objectId={OBJECT_ID}
      onCertify={onCertify}
      roomSlug="room"
      version={version}
      workspaceSlug="ws"
    />,
  );
}
type CertifyPassageCertify = (request: ObjectSpanRequest) => Promise<CertifyOutcome>;

describe('the fidelity warning mounts only when the render diverges from the raw bytes', () => {
  /* CATCHES: a body carrying a bidi/control char (painted `�`) certifying silently,
     with no note that what is shown is not byte-for-byte what is covered. */
  it('a bidi char trips the warning; a plain body does not', () => {
    const rlo = String.fromCharCode(0x202e);
    renderPane(seededDoc(msg('m1', `a${rlo}b`)), 1, async () => ({ ok: true, anchorId: 'x' }));
    expect(screen.queryByTestId('certify-fidelity-warning')).not.toBeNull();

    cleanup();
    renderPane(seededDoc(msg('m1', 'plain body')), 1, async () => ({ ok: true, anchorId: 'x' }));
    expect(screen.queryByTestId('certify-fidelity-warning')).toBeNull();
  });
});

describe('a body convergence clears the pending selection', () => {
  /* CATCHES: a `version` bump leaving the previously-selected span live, so the ✓
     stays armable over coordinates the human may no longer be looking at. */
  it('a version bump clears the span and re-disables the ✓', () => {
    const doc = seededDoc(msg('m1', 'hello world'));
    const { rerender } = renderPane(doc, 1, async () => ({ ok: true, anchorId: 'x' }));

    selectChars(0, 5); // "hello"
    expect(screen.getByText('5 of 11 characters selected')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Certify this passage/ }) as HTMLButtonElement).disabled,
    ).toBe(false);

    // A convergence lands (local or remote edit) — the pane is told via `version`.
    rerender(
      <CertifyPassage
        actor="lars"
        doc={doc}
        messageId="m1"
        objectId={OBJECT_ID}
        onCertify={async () => ({ ok: true, anchorId: 'x' })}
        roomSlug="room"
        version={2}
        workspaceSlug="ws"
      />,
    );

    // The span is gone: the hint returns to the empty prompt and the ✓ is disabled.
    expect(screen.getByText('select the exact words a certification should cover')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Certify this passage/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('a hold in flight when the body converges never certifies the stale span (E8 r2)', () => {
  /* CATCHES the converged blocker: a hold begun before an edit runs its rAF chain to
     completion over the pre-edit span and certifies coordinates the human never saw.
     A fresh selection AFTER the edit must still certify — the fix invalidates, it
     does not brick the surface. */
  it('mid-hold convergence abandons the hold; a fresh selection after it certifies', () => {
    const doc = seededDoc(msg('m1', 'hello world'));
    const onCertify = vi.fn<CertifyPassageCertify>(async () => ({ ok: true, anchorId: 'a1' }));
    const { rerender } = renderPane(doc, 1, onCertify);

    selectChars(0, 5); // "hello" — a valid span against version 1
    const hold = screen.getByRole('button', { name: /Certify this passage/ });
    fireEvent.pointerDown(hold);
    advance(1000); // mid-hold, before the 2s gate

    // The body edit lands mid-hold: insert before the selection so the old coords now
    // name a DIFFERENT passage, and bump `version` (the convergence tick).
    act(() => {
      const body = doc.body('m1');
      if (!body) throw new Error('no body');
      body.insert(0, 'XX '); // "hello world" → "XX hello world"
    });
    rerender(
      <CertifyPassage
        actor="lars"
        doc={doc}
        messageId="m1"
        objectId={OBJECT_ID}
        onCertify={onCertify}
        roomSlug="room"
        version={2}
        workspaceSlug="ws"
      />,
    );
    advance(5000); // long past the gate — a stale frame would have certified here

    expect(onCertify).not.toHaveBeenCalled();

    // A FRESH selection against the edited body still certifies — "world" now at 9..14.
    selectChars(9, 14);
    const holdAfter = screen.getByRole('button', { name: /Certify this passage/ });
    expect((holdAfter as HTMLButtonElement).disabled).toBe(false);
    fireEvent.pointerDown(holdAfter);
    advance(2100);

    expect(onCertify).toHaveBeenCalledTimes(1);
    const req = onCertify.mock.calls[0]?.[0];
    expect(req).toMatchObject({ objectId: OBJECT_ID, start: 9, end: 14 });
  });
});
