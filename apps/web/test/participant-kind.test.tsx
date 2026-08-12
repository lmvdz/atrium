/* ---------------------------------------------------------------------------
 * THE PARTICIPANT KIND, ON EVERY SURFACE THAT NAMES ONE, INCLUDING THE ONE THAT
 * FAILS CLOSED.
 *
 * `agent-participant.spec.ts` drives the real agent through Postgres end to end,
 * but `users.principal_kind` is a two-value ENUM ('human','agent'), so the DB
 * cannot store the third rendering — `'unknown'` — at all. That value is the
 * fail-closed one: it is what `participantKindOf` returns for anything it cannot
 * read (a later enum member, a fixture that forgot a kind, a corrupted column),
 * and the round-1 gauntlet's finding 1 was that defaulting those to `'human'`
 * did not merely mis-paint a monogram — it fed the mention filter and the "N
 * people" count, so an unreadable-kind MACHINE became a mention candidate and a
 * counted person, which AGENTS.md forbids.
 *
 * These are the deterministic, no-database proofs of the three renderings and
 * the fail-closed guarantees. The four things the round-1 receipt's four findings
 * turn on:
 *
 *   1. an unknown-kind member renders VISIBLY NOT A PERSON and is neither a
 *      mention candidate nor a counted person;
 *   2. the viewer's OWN monogram moves with `viewer.kind`;
 *   3. the room head's member chips derive from the SINGLE participant source,
 *      so flipping a participant moves the head with no parallel copy to update;
 *   4. the roster count names the unknown kind separately, never folded into
 *      people.
 * ------------------------------------------------------------------------- */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { RoomFrame } from '../app/gallery/RoomFrame';
import { railFor } from '../app/gallery/rooms';
import {
  type ParticipantSummary,
  participantKindOf,
  participantTally,
} from '../src/components/model';
import { mentionCandidateTargets } from '../src/lib/typed-references';

afterEach(cleanup);

const ROOMS = railFor(f.ROOM.name, f.ATTENTION);

function participant(over: Partial<ParticipantSummary> & { id: string }): ParticipantSummary {
  return {
    kind: 'human',
    name: over.id,
    presence: 'here',
    note: null,
    isViewer: false,
    ...over,
  };
}

/** Render a whole frame with a chosen roster and viewer, so the roster, the room
 *  head, the call strip and the "you" tile are all on screen from ONE source. */
function frame(participants: readonly ParticipantSummary[], viewer: ParticipantSummary) {
  return render(
    <RoomFrame
      attention={f.ATTENTION}
      binding={f.FREE}
      composerNote="note"
      entries={f.QUIET_TIMELINE}
      filter={null}
      focused="conversation"
      lastCheck="12:29"
      messages={f.RECORDS}
      objectives={f.OBJECTIVES}
      objects={f.OBJECTS}
      participants={participants}
      room={f.ROOM}
      rooms={ROOMS}
      trailer={f.TRAILER}
      updatedAt="13:41"
      viewer={viewer}
    />,
  );
}

describe('participantKindOf fails closed to unknown, never open to human', () => {
  it('reads the two real kinds off their labels', () => {
    expect(participantKindOf('human')).toBe('human');
    expect(participantKindOf('agent')).toBe('agent');
  });

  /* THE CRUX (round-1 finding 1). Every value that is not exactly one of the two
     labels is `'unknown'` — NOT `'human'`. A denylist here ("anything but agent
     is a person") is the fail-open the gauntlet found; this is the allowlist. */
  it.each([undefined, null, '', 'Human', 'AGENT', 'robot', 'model', 'system', 42, {}])(
    'renders %p — a value it cannot read — as unknown, not human',
    (value) => {
      expect(participantKindOf(value)).toBe('unknown');
    },
  );
});

describe('participantTally counts the unknown kind on its own, never as a person', () => {
  it('names people, agents and unknown separately', () => {
    const roster = [
      participant({ id: 'a', kind: 'human' }),
      participant({ id: 'b', kind: 'human' }),
      participant({ id: 'c', kind: 'agent' }),
      participant({ id: 'd', kind: 'unknown' }),
    ];
    expect(participantTally(roster)).toBe('2 people · 1 agent · 1 unknown');
  });

  it('never folds an unknown into the people count', () => {
    // The fail-open shape: `length - agents` would have counted this unknown as a
    // person. `people` is the count of `kind === 'human'`, so it does not.
    const roster = [
      participant({ id: 'a', kind: 'human' }),
      participant({ id: 'b', kind: 'unknown' }),
    ];
    expect(participantTally(roster)).toBe('1 person · 1 unknown');
  });

  it('reads a lone unknown as unknown, with no phantom "0 people"', () => {
    expect(participantTally([participant({ id: 'x', kind: 'unknown' })])).toBe('1 unknown');
  });

  it('still reads an all-human room as a plain people count', () => {
    const roster = [
      participant({ id: 'a', kind: 'human' }),
      participant({ id: 'b', kind: 'human' }),
    ];
    expect(participantTally(roster)).toBe('2 people');
  });
});

describe('the REAL composer allowlist names people and agents, never unknown', () => {
  /* Round-2 rewrite. The old test here re-implemented the filter LOCALLY
     (`roster.filter((p) => p.kind === 'human')`) and asserted against its own
     copy — a tautology that stayed green whatever the composer actually did, and
     could never catch a change to the real rule. It calls the SHIPPING allowlist
     now: `mentionCandidateTargets` is the single definition the live composer
     (LiveRoomSession.tsx) builds its `referenceTargets` from.

     CATCHES: deleting `|| participant.kind === 'agent'` from the allowlist (an
     agent stops being a candidate — first assertion fails), or widening it to
     admit `'unknown'`/a denylist shape (the fail-closed member becomes a
     candidate — second assertion fails). */
  const roster = [
    participant({ id: 'a', kind: 'human', name: 'Ada' }),
    participant({ id: 'b', kind: 'agent', name: 'Bot' }),
    participant({ id: 'c', kind: 'unknown', name: 'Mystery' }),
  ];

  it('offers the person AND the agent as mention candidates', () => {
    expect(mentionCandidateTargets(roster)).toEqual([
      { kind: 'human', id: 'a', label: 'Ada' },
      { kind: 'agent', id: 'b', label: 'Bot' },
    ]);
  });

  it('never offers an unknown-kind member — the allowlist fails closed', () => {
    const ids = mentionCandidateTargets(roster).map((target) => target.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('c');
  });
});

describe('an unknown-kind member renders visibly-not-a-person on every surface', () => {
  it('the roster row marks the kind, leads its meta with the word, and is not a person', () => {
    const roster = [
      participant({ id: 'lars', kind: 'human', isViewer: true, name: 'lars' }),
      participant({ id: 'mystery', kind: 'unknown', name: 'mystery' }),
    ];
    const { container } = frame(roster, roster[0] as ParticipantSummary);

    const row = container.querySelector('nav [data-participant-kind="unknown"]');
    expect(row, 'the roster has no unknown-kind row').not.toBeNull();
    // the word is on the row, where a screen reader and the audit both read it —
    // a shape alone is not a name.
    expect(row?.textContent).toContain('unknown');
    // and it is NOT tagged as a person anywhere in that row
    expect(row?.getAttribute('data-participant-kind')).toBe('unknown');
  });

  it('the room-head monogram carries the unknown kind and titles it', () => {
    const roster = [
      participant({ id: 'lars', kind: 'human', isViewer: true, name: 'lars' }),
      participant({ id: 'mystery', kind: 'unknown', name: 'mystery' }),
    ];
    const { container } = frame(roster, roster[0] as ParticipantSummary);

    const chip = container.querySelector('header [data-participant-kind="unknown"]');
    expect(chip, 'the room head has no unknown-kind chip').not.toBeNull();
    expect(chip?.getAttribute('title')).toContain('unknown');
  });
});

describe("the viewer's own monogram moves with viewer.kind (round-1 finding 2)", () => {
  function youTile(viewer: ParticipantSummary) {
    const { container } = frame([viewer], viewer);
    // the strip's "you" tile — the one carrying the viewer's initials
    return container.querySelector('aside [data-participant-kind]');
  }

  it('reads human for a person viewer', () => {
    expect(
      youTile(participant({ id: 'lars', kind: 'human', isViewer: true }))?.getAttribute(
        'data-participant-kind',
      ),
    ).toBe('human');
  });

  it('reads agent for an agent viewer — the tile is no longer always a person', () => {
    expect(
      youTile(participant({ id: 'bot', kind: 'agent', isViewer: true }))?.getAttribute(
        'data-participant-kind',
      ),
    ).toBe('agent');
  });

  it('reads unknown for an unreadable-kind viewer', () => {
    expect(
      youTile(participant({ id: 'x', kind: 'unknown', isViewer: true }))?.getAttribute(
        'data-participant-kind',
      ),
    ).toBe('unknown');
  });
});

describe('the room head derives from the ONE participant source (round-1 finding 3)', () => {
  /* There is no `room.members` prop to pass — `RoomFrameProps.room` is
     `Omit<RoomHeadRecord, 'members'>`, so a second member register is
     unrepresentable. Flip a participant's kind and the head's chip moves, with
     nothing else edited. */
  it('moves the head chip when the participant behind it flips kind', () => {
    const asAgent = [
      participant({ id: 'lars', kind: 'human', isViewer: true, name: 'lars' }),
      participant({ id: 'atrium', kind: 'agent', name: 'atrium' }),
    ];
    const first = frame(asAgent, asAgent[0] as ParticipantSummary);
    expect(
      first.container.querySelectorAll('header [data-participant-kind="agent"]'),
      'the head did not render the agent participant as an agent',
    ).toHaveLength(1);
    cleanup();

    const asHuman = [
      participant({ id: 'lars', kind: 'human', isViewer: true, name: 'lars' }),
      participant({ id: 'atrium', kind: 'human', name: 'atrium' }),
    ];
    const second = frame(asHuman, asHuman[0] as ParticipantSummary);
    expect(
      second.container.querySelectorAll('header [data-participant-kind="agent"]'),
      'the head kept an agent chip after the only agent became a person',
    ).toHaveLength(0);
    expect(
      second.container.querySelectorAll('header [data-participant-kind="human"]'),
      'the head did not follow the participant source to two people',
    ).toHaveLength(2);
  });
});
