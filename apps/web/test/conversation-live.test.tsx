/* ---------------------------------------------------------------------------
 * #183 FIX ROUND — the LIVE conversation seam, driven through the real surface.
 *
 * These mount the actual `ChatBlock` / the real `useConversationModel` hook over
 * the in-memory hub (the sandbox convergence proof) and pin the seam defects the
 * gauntlet found the UI could not survive:
 *
 *   F4 — a line TYPED into client A's composer enters the converging doc: a second
 *        replica sees it, and a fresh client (a "reload") catches it up.
 *   F3 — a live client (transport present) is UNSEEDED: it catches up from the
 *        stream instead of re-inserting the fixture, so history is never doubled.
 *   F6 — a Strict-Mode remount (mount → cleanup → mount) never reuses a destroyed
 *        `Y.Doc`: the doc stays live and a peer's update still lands.
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatBlock } from '../app/prototype/ChatBlock';
import type { ConversationTransport } from '../app/prototype/conversation-transport';
import { InMemoryConversationHub } from '../app/prototype/conversation-transport';
import type { Selection } from '../app/prototype/types';
import { useConversationModel } from '../app/prototype/use-conversation-model';
import { ConversationDoc } from '../app/prototype/yjs-conversation';

afterEach(cleanup);

const LIVE: Selection = { kind: 'session', id: 's-live' };

function mountChat(transport: ConversationTransport) {
  return render(
    <ChatBlock
      selected={LIVE}
      echoes={[]}
      draftComment={null}
      onSay={() => {}}
      transport={transport}
    />,
  );
}

/** Type one line into a mounted ChatBlock's composer and submit it (Enter). */
function type(container: HTMLElement, text: string): void {
  const field = container.querySelector<HTMLTextAreaElement>('textarea[name="atrium-message"]');
  expect(field, 'the composer is mounted').toBeTruthy();
  fireEvent.change(field as HTMLTextAreaElement, { target: { value: text } });
  fireEvent.keyDown(field as HTMLTextAreaElement, { key: 'Enter' });
}

describe('F4 — a typed composer line enters the converging doc', () => {
  it('appears on a second replica AND survives a reload (a fresh client catches it up)', async () => {
    const hub = new InMemoryConversationHub(new ConversationDoc().doc);
    const line = 'ship the invoice totals ORACLE-XYZ';

    // Two live clients on one room, plus a bare reader replica.
    const a = mountChat(hub.transport());
    const b = mountChat(hub.transport());

    type(a.container, line);

    // The line the human typed into A shows up on B — it entered the doc and
    // converged, it is not a local-only echo.
    await waitFor(() => expect(b.container.textContent ?? '').toContain(line));

    // SURVIVES RELOAD: a brand-new client joining the same stream catches the
    // typed line up from durable state, so a reload would not drop it.
    const reloaded = new ConversationDoc();
    reloaded.connect(hub.transport());
    expect(reloaded.messages().some((m) => m.text === line)).toBe(true);
  });
});

/* A minimal probe over the real hook, for the source-mode and lifecycle proofs. */
function Probe({ transport }: { transport?: ConversationTransport }) {
  const { model } = useConversationModel(LIVE, transport);
  return <div data-testid="probe">{model.items.map((item) => item.id).join(',')}</div>;
}

describe('F3 — a live client is unseeded (catches up, never re-seeds the fixture)', () => {
  it('renders NOTHING against an empty stream — it did not seed the mock history', () => {
    const hub = new InMemoryConversationHub(new ConversationDoc().doc);
    const { getByTestId } = render(<Probe transport={hub.transport()} />);
    // With a transport, the doc is empty until the stream delivers — proof it did
    // not locally re-insert the fixture (which would duplicate against every peer).
    expect(getByTestId('probe').textContent).toBe('');
  });
});

describe('F6 — a Strict-Mode remount never reuses a destroyed Y.Doc', () => {
  it('the doc stays live through mount → cleanup → mount, and a peer update still lands', async () => {
    const hub = new InMemoryConversationHub(new ConversationDoc().doc);

    // StrictMode double-invokes mount/cleanup/mount. If the hook destroyed the
    // memoised doc in cleanup and reused it, the doc would be dead here.
    const { getByTestId } = render(
      <StrictMode>
        <Probe transport={hub.transport()} />
      </StrictMode>,
    );

    // A peer writes to the shared stream AFTER the remount dust settles.
    const peer = new ConversationDoc();
    peer.connect(hub.transport());
    peer.append({ id: 'peer-1', time: '10:00', kind: 'human', who: 'you', text: 'still alive?' });

    // The probe's doc received it — it was never destroyed-then-reused.
    await waitFor(() => expect(getByTestId('probe').textContent).toContain('peer-1'));
  });
});
