/* ---------------------------------------------------------------------------
 * THE CONVERSATION COLUMN IS MARRIED TO THE SHIPPED STACK — flip the input, the
 * render moves (#155).
 *
 * The prototype's hand-rolled `ChatMessage` plain-row, `RichText` regex and
 * `parseDiff` are DELETED; the conversation renders THROUGH the `ConversationModel`
 * seam into the shipped `TimelineRow`/`SystemRow`/`MessageBody` grammar, and the
 * artifact diff renders through the shipped `ReviewPane` `DiffView`. These prove
 * the binding is a derivation, not a coincidence:
 *
 *   * A PLAIN LINE IS A REAL RECORD THROUGH `TimelineRow`. The feed row cites a
 *     `MessageRecord` and the shipped row resolves it against the ledger.
 *   * FLIP A MESSAGE BODY — the rendered row moves. The words come off the record,
 *     not off a memoised string (the covenant's whole provenance apparatus).
 *   * THE SETTLEMENT `✓` IS DERIVED FROM A CERTIFICATION FIELD, never a literal
 *     glyph. Flip the field and the glyph moves ✓ → ~. This is the glyph-source
 *     covenant made concrete on this pane.
 *   * THE DIFF RENDERS STRUCTURED, THROUGH THE SHIPPED VIEW — no client `parseDiff`.
 * ------------------------------------------------------------------------- */

import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPane } from '../app/prototype/ArtifactPane';
import {
  conversationModel,
  echoItem,
  systemSettlementState,
} from '../app/prototype/conversation-model';
import { sessionArtifacts } from '../app/prototype/seams';
import type { Selection } from '../app/prototype/types';
import { glyphFor } from '../src/components/model/glyph';
import { AttributionLedger } from '../src/components/model/ledger';
import type { MessageRecord } from '../src/components/model/quotation';
import { systemStatement } from '../src/components/model/quotation';
import type { MessageEntry, SystemEntry } from '../src/components/model/records';
import { SystemRow } from '../src/components/timeline/SystemRow';
import { TimelineRow } from '../src/components/timeline/TimelineRow';

afterEach(cleanup);

const LIVE: Selection = { kind: 'session', id: 's-live' };
const SCOUT: Selection = { kind: 'session', id: 's-scout' };

/** Render one shipped message row inside its ledger, the way `ChatBlock` does. */
function renderRow(entry: MessageEntry, records: readonly MessageRecord[]) {
  return render(
    <AttributionLedger messages={records} room="billing-rewrite">
      <TimelineRow entry={entry} />
    </AttributionLedger>,
  );
}

describe('the conversation renders through the shipped stack', () => {
  it('a plain line is a real record rendered by TimelineRow (no ChatMsg[] mock row)', () => {
    const model = conversationModel(LIVE);
    const message = model.items.find((item) => item.kind === 'message');
    expect(message, 'the live thread has a plain human line bound to a record').toBeDefined();
    if (message?.kind !== 'message') throw new Error('unreachable');

    const { container } = renderRow(message.entry, model.records);
    // The shipped row, not the prototype's `.chatRow` — its provenance markers.
    const row = container.querySelector('[data-row="message"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-message-id')).toBe(message.id);
    // The words are on screen, through the shipped body.
    expect(container.textContent).toContain('streaming totals');
  });

  it('mentions ride the shipped body as a typed reference, not a regex over text', () => {
    // A constructed line so the assertion does not depend on fixture prose.
    const { record, item } = echoItem('ping @hexi about the totals', 0, 'billing-rewrite');
    if (item.kind !== 'message') throw new Error('unreachable');
    const { container } = renderRow(item.entry, [record]);
    // The shipped body marks a mention with `data-rich-mention`; the row resolved
    // through the ledger (a real citation) rather than a regex over display text.
    expect(container.querySelector('[data-rich-mention="true"]')).not.toBeNull();
    expect(container.textContent).toContain('@hexi');
  });

  it('FLIP A MESSAGE BODY — the rendered words move with the record', () => {
    const first = echoItem('the fold is pure', 0, 'billing-rewrite');
    if (first.item.kind !== 'message') throw new Error('unreachable');
    const a = renderRow(first.item.entry, [first.record]);
    expect(a.container.textContent).toContain('the fold is pure');
    cleanup();

    const second = echoItem('the fold is STATEFUL-XYZ', 0, 'billing-rewrite');
    if (second.item.kind !== 'message') throw new Error('unreachable');
    const b = renderRow(second.item.entry, [second.record]);
    expect(b.container.textContent).toContain('the fold is STATEFUL-XYZ');
    expect(b.container.textContent).not.toContain('the fold is pure');
  });
});

describe('a settlement glyph is DERIVED from certification state, never a literal', () => {
  it('the scout thread renders a settled ✓ on the certified system line', () => {
    const model = conversationModel(SCOUT);
    const certified = model.items.find(
      (item) => item.kind === 'system' && glyphFor(item.entry.state) === '✓',
    );
    expect(certified, 'the certified settlement line derives a ✓').toBeDefined();
    if (certified?.kind !== 'system') throw new Error('unreachable');

    const { container } = render(<SystemRow entry={certified.entry} />);
    // The tick is the DERIVED glyph (a `[data-glyph]` span), not a character in
    // the statement text — the statement body carries no glyph of its own.
    expect(container.querySelector('[data-glyph="✓"]')).not.toBeNull();
    const body = container.querySelector('[data-voice="system"]');
    expect(body?.textContent).toContain('certified by you');
    expect(body?.textContent).not.toContain('✓');
  });

  it('FLIP THE CERTIFIED FIELD — the glyph moves ✓ → ~', () => {
    // The derivation the artifact footer and the system row both read.
    expect(glyphFor(systemSettlementState(true))).toBe('✓');
    expect(glyphFor(systemSettlementState(false))).toBe('~');

    const base: Omit<SystemEntry, 'state'> = {
      type: 'system',
      id: 'flip',
      at: '13:41',
      statement: systemStatement('settled'),
    };
    const certified = render(<SystemRow entry={{ ...base, state: systemSettlementState(true) }} />);
    expect(certified.container.querySelector('[data-glyph="✓"]')).not.toBeNull();
    cleanup();
    const draft = render(<SystemRow entry={{ ...base, state: systemSettlementState(false) }} />);
    expect(draft.container.querySelector('[data-glyph="✓"]')).toBeNull();
    expect(draft.container.querySelector('[data-glyph="~"]')).not.toBeNull();
  });
});

describe('the artifact diff renders through the shipped DiffView (no client parseDiff)', () => {
  function renderPane(activeId: string) {
    return render(
      <ArtifactPane
        artifacts={sessionArtifacts()}
        activeId={activeId}
        onSelectArtifact={vi.fn()}
        comments={[]}
        onComment={vi.fn()}
        onDraft={vi.fn()}
      />,
    );
  }

  it('renders the server-structured hunks, not a parsed string', () => {
    const { container } = renderPane('pr-invoice');
    expect(container.querySelector('[data-diff-structured]')).not.toBeNull();
    expect(
      container.querySelector('[data-diff-file-path="src/billing/invoice.ts"]'),
    ).not.toBeNull();
    // the off-scope auth file is present as a normal file (the "concern" is #159's job)
    expect(container.querySelector('[data-diff-file-path="src/auth/session.ts"]')).not.toBeNull();
    // a removed line renders through the forgery-proof gutter
    const del = container.querySelector('[data-diff-line="del"]');
    expect(del).not.toBeNull();
    expect(within(del as HTMLElement).getByText('let total = 0')).toBeTruthy();
    // the file-count summary is the structure's own, not a re-count
    expect(container.querySelector('[data-diff-file-count]')?.textContent).toContain('3 files');
  });

  it("the diff artifact's mark is a derived ~ (uncertified draft), not a literal", () => {
    const { container } = renderPane('pr-invoice');
    // the footer glyph is the shipped <Glyph>, derived from `certified: false`
    expect(container.querySelector('[data-glyph="~"]')).not.toBeNull();
  });
});
