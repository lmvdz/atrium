/* ---------------------------------------------------------------------------
 * EVERY HANDLER A CHILD ACCEPTS IS REACHABLE FROM <Timeline>.
 *
 * Round 1: `ROW_ACTIONS` was a module constant whose entries had no `onSelect`,
 * so 24 row buttons per frame were decorative; `onOpenTag`, `onMarkSeen` and
 * `onUnmarkSeen` existed on the children and were never forwarded. That is the
 * literal "forces #25 to fork a component" case — a consumer who wanted a
 * working reply button had no prop to pass.
 * ------------------------------------------------------------------------- */

import type { RenderResult } from '@testing-library/react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { Timeline } from '../src/components';
import { renderWith } from './harness';

afterEach(cleanup);

/* The feed resolves every row's actor against the record register it was built
   from; a row rendered outside one throws rather than degrading. */
const render = (ui: ReactElement): RenderResult => renderWith(f.RECORDS, ui);

const ENTRIES = f.timeline({ seen: false, filter: null, routineOpen: false });
const SEEN_ENTRIES = f.timeline({ seen: true, filter: null, routineOpen: false });

describe('the feed forwards what its children accept', () => {
  /* CATCHES: row actions rendered from a constant with no handler. A button
     that does nothing is worse than no button: it says the affordance exists. */
  it('a row action reaches the caller with the row and the action', () => {
    const calls: [string, string][] = [];
    render(
      <Timeline entries={ENTRIES} filtered={false} onRowAction={(a, b) => calls.push([a, b])} />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'reply' })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole('button', { name: 'quote' })[0] as HTMLElement);
    expect(calls.length).toBe(2);
    expect(calls[0]?.[1]).toBe('reply');
    expect(calls[1]?.[1]).toBe('quote');
    expect(calls[0]?.[0]).toBe(calls[1]?.[0]);
    // and the row it names is a real row in the feed
    expect(ENTRIES.some((e) => e.id === calls[0]?.[0])).toBe(true);
  });

  /* CATCHES: dropping `onOpenTag` on the way through. Every row tag is a
     button; before this it was a button with no handler on every single row. */
  it('a row tag reaches onOpenTag', () => {
    const opened: string[] = [];
    render(<Timeline entries={ENTRIES} filtered={false} onOpenTag={(id) => opened.push(id)} />);
    const tag = document.querySelector('[data-row-tag]') as HTMLElement | null;
    expect(tag).not.toBeNull();
    fireEvent.click(tag as HTMLElement);
    expect(opened).toEqual([tag?.getAttribute('data-row-tag')]);
  });

  /* CATCHES: mark/unmark being unreachable. The divider's whole promise is that
     marking a group seen mutes it rather than deleting it — which a consumer
     cannot demonstrate if the handler never arrives. */
  it('mark seen and unmark seen both reach the caller', () => {
    const marked: string[] = [];
    const { unmount } = render(
      <Timeline
        entries={ENTRIES}
        filtered={false}
        onMarkSeen={(id) => marked.push(`mark:${id}`)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'mark this group seen' }));
    unmount();

    render(
      <Timeline
        entries={SEEN_ENTRIES}
        filtered={false}
        onUnmarkSeen={(id) => marked.push(`unmark:${id}`)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'unmark' }));
    expect(marked).toEqual(['mark:syl', 'unmark:syl']);
  });

  /* CATCHES: a regression in the two handlers that DID work, while the four
     that did not were being wired. */
  it('filter and peek still reach the caller', () => {
    const calls: string[] = [];
    render(
      <Timeline
        entries={ENTRIES}
        filtered={false}
        onFilter={(c) => calls.push(`filter:${c}`)}
        onTogglePeek={(id) => calls.push(`peek:${id}`)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '4 NEED YOU' }));
    fireEvent.click(screen.getByRole('button', { name: /8 routine/ }));
    expect(calls).toEqual(['filter:need', 'peek:routine-group']);
  });

  /* CATCHES: hard-coding the row action set, which is the other half of the
     fork pressure — #25 wanting a different set had no way to say so. */
  it('the row action set can be replaced without forking the component', () => {
    render(
      <Timeline entries={ENTRIES} filtered={false} rowActions={[{ id: 'pin', label: 'pin it' }]} />,
    );
    expect(screen.getAllByRole('button', { name: 'pin it' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'reply' })).toBeNull();
  });
});
