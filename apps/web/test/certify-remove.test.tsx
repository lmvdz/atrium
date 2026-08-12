/* ---------------------------------------------------------------------------
 * CERTIFY + REMOVE ON A `~` READING — the affordance and its gates (#110).
 *
 * The live route auto-accepts a model-drafted `claim`/`open_question` (#4/#8), so
 * it lands as a `~` reading with no proposal and no certify/reject button. This
 * proves the receipt now carries the two acts the covenant needs — a person
 * certifying a `~` claim to `✓ verified`, and a person removing an accepted `~`
 * reading — and that BOTH are gated the way #102 demands:
 *
 *   - a machine never certifies: an AGENT viewer sees neither affordance, because
 *     the gate is an allowlist (`kind === 'human'`), so the fail-closed `unknown`
 *     is out too;
 *   - a self-verifier is refused: when the reader is the claimant / stager /
 *     source-author, the certify button is DISABLED and says why, in the
 *     covenant's words — the server refuses the same act, and stays the authority.
 *
 * Rendered through the WHOLE FRAME, not the receipt in isolation, because the
 * viewer-kind gate is wired at the `RoomFrame`→`ReceiptView` seam (the corpus
 * rule this gallery exists to honour).
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { RoomFrame } from '../app/gallery/RoomFrame';
import { railFor } from '../app/gallery/rooms';
import type { EpistemicState, ParticipantSummary, ReceiptRecord } from '../src/components/model';

afterEach(cleanup);

const ROOMS = railFor(f.ROOM.name, f.ATTENTION);

const AGENT_VIEWER: ParticipantSummary = {
  id: 'atrium',
  kind: 'agent',
  name: 'atrium',
  presence: 'here',
  note: null,
  isViewer: true,
};

const CLAIM_STATE: EpistemicState = {
  kind: 'claim',
  verification: 'self_reported',
  owedToViewer: false,
  irreversible: false,
};

function claimReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: 'obj-claim',
    state: CLAIM_STATE,
    title: 'the migration ran clean on staging',
    status: ['CLAIM', 'self reported'],
    happened: [],
    provenance: [],
    corrections: [],
    retypeable: false,
    reopenable: false,
    reopenNote: 'the excerpts above come from the persisted room record',
    certifiable: true,
    removable: true,
    certifyRefusal: null,
    ...overrides,
  };
}

function frame(props: {
  viewer: ParticipantSummary;
  receipt: ReceiptRecord;
  onCertifyReceipt?: (id: string) => void;
  onRemoveReceipt?: (id: string) => void;
}) {
  return render(
    <RoomFrame
      attention={f.ATTENTION}
      binding={f.FREE}
      composerNote="note"
      entries={f.QUIET_TIMELINE}
      filter={null}
      focused="current-state"
      handlers={{
        onCertifyReceipt: props.onCertifyReceipt,
        onRemoveReceipt: props.onRemoveReceipt,
      }}
      participants={f.PARTICIPANTS}
      lastCheck="12:29"
      messages={f.RECORDS}
      objectives={f.OBJECTIVES}
      objects={f.OBJECTS}
      receipt={props.receipt}
      room={f.ROOM}
      rooms={ROOMS}
      trailer={f.TRAILER}
      updatedAt="13:41"
      viewer={props.viewer}
    />,
  );
}

describe('a human may certify a `~` claim and remove a `~` reading', () => {
  it('shows both affordances to a human, and each is a deliberate two-stage act', () => {
    const onCertifyReceipt = vi.fn();
    const onRemoveReceipt = vi.fn();
    const { container } = frame({
      viewer: f.VIEWER,
      receipt: claimReceipt(),
      onCertifyReceipt,
      onRemoveReceipt,
    });

    // the receipt is on screen for the accepted `~` claim
    expect(container.querySelector('[data-receipt-id="obj-claim"]')).not.toBeNull();

    // CERTIFY is offered, and it is not a one-click act: the trigger arms a
    // confirm, and only the confirm calls through.
    const certify = container.querySelector('[data-certify="ready"]');
    expect(certify, 'the human is not offered certify').not.toBeNull();
    fireEvent.click(certify as Element);
    expect(onCertifyReceipt, 'the trigger certified without a confirm').not.toHaveBeenCalled();
    const confirmCertify = container.querySelector('[data-confirm-certify="true"]');
    expect(confirmCertify, 'the certify trigger armed no confirmation').not.toBeNull();
    fireEvent.click(confirmCertify as Element);
    expect(onCertifyReceipt).toHaveBeenCalledWith('obj-claim');

    // REMOVE is the same shape — trigger, then confirm.
    const remove = container.querySelector('[data-remove="ready"]');
    expect(remove, 'the human is not offered remove').not.toBeNull();
    fireEvent.click(remove as Element);
    expect(onRemoveReceipt).not.toHaveBeenCalled();
    const confirmRemove = container.querySelector('[data-confirm-remove="true"]');
    expect(confirmRemove, 'the remove trigger armed no confirmation').not.toBeNull();
    fireEvent.click(confirmRemove as Element);
    expect(onRemoveReceipt).toHaveBeenCalledWith('obj-claim');
  });

  it('a self-verifier is refused honestly: certify is disabled and states why', () => {
    const onCertifyReceipt = vi.fn();
    const refusal = 'You are named as this claim’s claimant — certifying is a second pair of eyes.';
    const { container } = frame({
      viewer: f.VIEWER,
      receipt: claimReceipt({ certifyRefusal: refusal }),
      onCertifyReceipt,
    });

    // no ready trigger; a disabled one that names the refusal
    expect(container.querySelector('[data-certify="ready"]')).toBeNull();
    const refused = container.querySelector('[data-certify="refused"]') as HTMLButtonElement | null;
    expect(refused, 'the refused claim offered no disabled certify').not.toBeNull();
    expect(refused?.disabled).toBe(true);
    fireEvent.click(refused as Element);
    expect(onCertifyReceipt, 'a disabled certify still fired').not.toHaveBeenCalled();

    // and the reason is on the page, not just a tooltip
    const said = container.querySelector('[data-certify-refused="true"]');
    expect(said?.textContent).toContain('second pair of eyes');
  });

  it('an AGENT viewer is offered neither — the covenant, gated by an allowlist', () => {
    const { container } = frame({ viewer: AGENT_VIEWER, receipt: claimReceipt() });
    expect(container.querySelector('[data-receipt-id="obj-claim"]')).not.toBeNull();
    expect(container.querySelector('[data-certify="ready"]')).toBeNull();
    expect(container.querySelector('[data-certify="refused"]')).toBeNull();
    expect(container.querySelector('[data-remove="ready"]')).toBeNull();
  });

  it('a claim already `✓ verified` is not certifiable, but remains removable', () => {
    const { container } = frame({
      viewer: f.VIEWER,
      receipt: claimReceipt({
        certifiable: false,
        state: { ...CLAIM_STATE, verification: 'verified' },
      }),
      onRemoveReceipt: vi.fn(),
    });
    expect(container.querySelector('[data-certify="ready"]')).toBeNull();
    expect(container.querySelector('[data-remove="ready"]')).not.toBeNull();
  });
});
