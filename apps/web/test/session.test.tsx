/* ---------------------------------------------------------------------------
 * `/` SURVIVES BEING DRIVEN FASTER THAN IT RENDERS.
 *
 * ROUND 7, D5. Two sends in ONE TASK destroyed the page and took the user's
 * draft with it:
 *
 *   type "ship it", then btn.click(); btn.click()
 *   [pageerror] messageLedger: two different records both claim the id "local-1"
 *   body.innerText → "This page couldn't load | Reload to try again, or go back."
 *   [data-row="message"] → 0
 *
 * THREE DEFECTS IN ONE LINE OF STACK, and each is worth naming separately
 * because each has a different general form:
 *
 *   1. THE ID CAME OUT OF RENDERED STATE. `local-${sent.length + 1}` read a
 *      closure over `sent.length`, so two handlers running before a re-render
 *      minted one id twice. A live adapter, a fast double-press and every
 *      automated driver all produce that shape.
 *
 *   2. THE LEDGER COMPARED BY REFERENCE. `existing !== record` is identity, not
 *      disagreement, so two VALUE-IDENTICAL records for one id threw as loudly
 *      as a forgery — which makes idempotent re-delivery (a reconnect replay, an
 *      at-least-once feed) indistinguishable from an attack. "A throw, not
 *      last-write-wins" is the right rule; reference inequality is the wrong
 *      implementation of it.
 *
 *   3. THERE WAS NO ERROR BOUNDARY. Every guarantee in this library is enforced
 *      by a throw INSIDE RENDER, deliberately — and `app/` had no `error.tsx`
 *      and no `global-error.tsx`, so the throw took the whole tree. A model that
 *      refuses rather than degrades owes the reader somewhere to land.
 * ------------------------------------------------------------------------- */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RoomSession } from '../app/RoomSession';
import type { MessageRecord } from '../src/components/model';
import { messageLedger, recordFingerprint } from '../src/components/model';

afterEach(cleanup);

const LARS: MessageRecord = {
  id: 'local-1',
  at: '13:44',
  actor: 'lars',
  text: 'ship it',
  origin: 'typed',
};

describe('two records under one id', () => {
  /* CATCHES: the ledger going back to `existing !== record`. Two records that
     say the same thing are the same message delivered twice, which is what an
     at-least-once feed does on every reconnect. */
  it('a re-delivered record with the same facts is accepted, once', () => {
    const copy: MessageRecord = { ...LARS };
    expect(copy).not.toBe(LARS);
    expect(recordFingerprint(copy)).toBe(recordFingerprint(LARS));
    const ledger = messageLedger([LARS, copy]);
    expect(ledger.size).toBe(1);
    expect(ledger.recordFor('local-1')).toBe(LARS);
  });

  /* CATCHES: the fix going too far and becoming last-write-wins. A record that
     DISAGREES about anything a reader can see is still a throw — that is the
     whole reason the check exists, and it is what stops a second register
     renaming a message. */
  it('a record that disagrees about anything visible is still a throw', () => {
    for (const forged of [
      { ...LARS, actor: 'priya' },
      { ...LARS, text: 'drop users_legacy now' },
      { ...LARS, at: '09:04' },
      { ...LARS, room: 'identity-service' },
      { ...LARS, origin: 'chosen' as const },
    ]) {
      expect(() => messageLedger([LARS, forged]), JSON.stringify(forged)).toThrow(
        /two DIFFERENT records/,
      );
    }
  });
});

describe('the session under a driver faster than a render', () => {
  function open() {
    render(<RoomSession />);
    return screen.getByRole('combobox');
  }

  /* CATCHES: the id going back to `sent.length + 1`. Both sends happen inside
     one `act`, so neither sees the other's state — exactly what
     `btn.click(); btn.click()` does in one task. */
  it('two sends in one task mint two ids and leave the page standing', () => {
    const composer = open();
    const before = document.querySelectorAll('[data-row="message"]').length;

    act(() => {
      fireEvent.change(composer, { target: { value: 'ship it' } });
    });
    const send = screen.getByRole('button', { name: 'Send' });
    act(() => {
      fireEvent.click(send);
      fireEvent.click(send);
    });

    const rows = [...document.querySelectorAll('[data-row="message"]')];
    expect(rows.length, 'the page lost its feed').toBeGreaterThan(before);
    const ids = rows.map((row) => row.getAttribute('data-message-id'));
    expect(new Set(ids).size, 'two rows cite the same message id').toBe(ids.length);
    /* And nothing anywhere on the page is the boundary's own copy. */
    expect(document.body.textContent ?? '').not.toContain('THIS VIEW REFUSED TO RENDER');
  });

  /* CATCHES: the send path minting an id from a value that moves with the
     render rather than with the act. Three sends, three ids, in three tasks. */
  it('every sent row cites a distinct record', () => {
    const composer = open();
    const send = screen.getByRole('button', { name: 'Send' });
    for (const text of ['one', 'two', 'three']) {
      act(() => {
        fireEvent.change(composer, { target: { value: text } });
      });
      act(() => {
        fireEvent.click(send);
      });
    }
    const ids = [...document.querySelectorAll('[data-row="message"]')].map((row) =>
      row.getAttribute('data-message-id'),
    );
    const local = ids.filter((id) => id?.startsWith('local-'));
    expect(local).toEqual(['local-1', 'local-2', 'local-3']);
  });
});

/* ---------------------------------------------------------------------------
 * A ROOM CHIP CHANGES THE ROOM, NOT THE HEADER.
 *
 * ROUND 7, D6. Round 6 wired the chip and wired it to a LABEL: clicking
 * `#design` made the head read `# design` while the eight feed rows, the four
 * owed items, the ten lens objects and the composer binding stayed byte-identical
 * to `#users-migration`'s — and the rail went on marking `#users-migration`
 * current. Two sources of truth about which room you are in, disagreeing on
 * screen, in the product whose entire doctrine is that.
 * ------------------------------------------------------------------------- */
describe('switching rooms', () => {
  function chips() {
    return [...document.querySelectorAll('nav[aria-label="Rooms and people"] button')];
  }

  function snapshot() {
    return {
      head: document.querySelector('header h2')?.textContent ?? '',
      rows: [...document.querySelectorAll('[data-row="message"]')].map((r) =>
        r.getAttribute('data-message-id'),
      ),
      owed: [...document.querySelectorAll('[data-attention-id]')].map((n) =>
        n.getAttribute('data-attention-id'),
      ),
      objects: [...document.querySelectorAll('[data-object-id]')].map((n) =>
        n.getAttribute('data-object-id'),
      ),
      current: document
        .querySelector('nav[aria-label="Rooms and people"] [aria-current="true"]')
        ?.getAttribute('aria-label'),
    };
  }

  /* CATCHES the round-6 defect exactly: the head moving while nothing else
     does. Each of the four surfaces is compared separately, because "something
     changed" is satisfied by the header alone — which is the whole finding. */
  it('every surface follows the chip, not just the head', () => {
    render(<RoomSession />);
    const before = snapshot();
    expect(before.rows.length).toBeGreaterThan(4);
    expect(before.owed.length).toBeGreaterThan(2);

    /* #design: the room with nothing owed. */
    const design = chips().find((chip) => /#design/.test(chip.getAttribute('aria-label') ?? ''));
    expect(design, 'the rail renders no #design chip').toBeDefined();
    act(() => {
      fireEvent.click(design as Element);
    });

    const after = snapshot();
    expect(after.head, 'the head did not follow the chip').not.toBe(before.head);
    expect(after.rows, 'the FEED is byte-identical to the room you left').not.toEqual(before.rows);
    expect(after.owed, 'the PIN is byte-identical to the room you left').not.toEqual(before.owed);
    expect(after.objects, 'the LENS is byte-identical to the room you left').not.toEqual(
      before.objects,
    );
    /* AND THE RAIL AGREES WITH THE HEAD. Round 6's screen had the rail marking
       one room and the head naming another. */
    expect(after.current, 'the rail still marks the room you left').toMatch(/#design/);
    /* …and the terminal state is a result, not an absence. */
    expect(document.body.textContent).toMatch(/NOTHING NEEDS YOU IN THIS ROOM/i);
  });

  /* CATCHES: a room switch that leaves the previous room's receipt open, or its
     binding on the composer — state scoped to a room that outlived it. */
  it('what belonged to the room you left goes with it', () => {
    render(<RoomSession />);
    act(() => {
      fireEvent.click(document.querySelector('[data-object-id]') as Element);
    });
    expect(document.querySelector('[data-receipt-id]')).not.toBeNull();
    const platform = chips().find((chip) =>
      /#platform/.test(chip.getAttribute('aria-label') ?? ''),
    );
    act(() => {
      fireEvent.click(platform as Element);
    });
    expect(
      document.querySelector('[data-receipt-id]'),
      'a receipt for an object in another room is still open',
    ).toBeNull();
    expect(
      document.querySelector('[data-composer-box]')?.getAttribute('data-composer-box'),
      'the composer is still bound to an item in the room you left',
    ).toBe('free');
  });
});

describe('a throw inside render has somewhere to land', () => {
  function find(relative: string): string {
    let dir = process.cwd();
    for (let i = 0; i < 6; i += 1) {
      const candidate = resolve(dir, relative);
      if (existsSync(candidate)) return candidate;
      dir = dirname(dir);
    }
    throw new Error(`${relative} not found above ${process.cwd()}`);
  }

  /* CATCHES: the boundaries being deleted. Every guarantee in this library is a
     throw inside render; without a boundary that is not "it refuses", it is
     "the page is gone and the draft went with it". The App Router discovers
     these by FILENAME, so their existence is the whole wiring. */
  it('app/ declares both error boundaries', () => {
    expect(() => find('apps/web/app/error.tsx')).not.toThrow();
    expect(() => find('apps/web/app/global-error.tsx')).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * THE PRODUCT CHROME IS NOT A README — r8.
 *
 * `/` is the route this round calls the actual product, and its composer's
 * status line was seeded with "every control on this page is wired — click one
 * and this line reports what it did": an instruction to a REVIEWER, sitting in
 * the chrome a user reads. The r8 blind review's product judgment was otherwise
 * good — 4 of 63 long strings on `/` explain the interface's own counting — and
 * named this one as scaffolding to remove.
 *
 * A status line with nothing to report reports nothing. What makes that a
 * guarantee rather than a deletion is that the line still WORKS: a handler
 * writes to it and it appears.
 * ------------------------------------------------------------------------- */
describe('the status line reports what the page did, and nothing before it did anything', () => {
  /* CATCHES: the scaffolding coming back, at any wording. The bound is not "this
     sentence is absent" — that is a denylist of one string — it is that the line
     RENDERS NOTHING until a control fires. */
  it('nothing is under the composer until a control does something', () => {
    render(<RoomSession />);
    expect(
      document.querySelector('[data-composer-note]'),
      'the composer states something before the page has done anything',
    ).toBe(null);
  });

  /* BOTH DIRECTIONS: the line is not merely deleted. Every handler still writes
     to it, which is the property `/` exists to make checkable. */
  it('a control that fires writes what it did into the line', () => {
    render(<RoomSession />);
    const rows = screen.getAllByRole('button');
    /* IN THE RAIL, not merely carrying the rail's mark. This read `includes('#')`
       alone, and the frame's new fold control — whose entire visible text is `#`,
       because that is this app's rooms mark — matched it first. The test then
       pressed the fold, which opens a column rather than choosing a room, and
       reported the status line missing. The selector now says the thing it
       always meant: a chip inside the rooms nav. It still catches a room chip
       that stops writing what it did, which is the mutation it is here for. */
    const chip = rows.find(
      (button) => button.closest('nav') !== null && (button.textContent ?? '').includes('#'),
    );
    expect(chip, 'no room chip to press').toBeDefined();
    if (chip !== undefined) fireEvent.click(chip);
    const note = document.querySelector('[data-composer-note]');
    expect(note, 'a control fired and the status line stayed absent').not.toBe(null);
    expect((note?.textContent ?? '').length).toBeGreaterThan(0);
  });
});
