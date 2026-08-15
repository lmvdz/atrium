/* ---------------------------------------------------------------------------
 * #156 — THE PERIPHERAL DISPLAY BINDS REAL TRACED DATA, AND A FIXTURE CHANGE
 * MOVES THE RENDERED STATE.
 *
 * The peripheral panes (ProviderMark, the faces row, the thread head, the
 * status strip) used to derive their content from mock strings. They now
 * project real record shapes — `ParticipantSummary`, `RoomHeadRecord` — with a
 * real presence field, and the covenant's flip-the-input rule is the assertion
 * that the binding is live and not painted: change a participant's presence in
 * the fixture and the rendered face's `data-presence` moves with it.
 * ------------------------------------------------------------------------- */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParticipantSummary } from '@/src/components/model/records';
import { Faces } from '../app/prototype/ChatChrome';
import type { MockAgent, SessionStatus, StreamState } from '../app/prototype/mock';
import { ProviderMark } from '../app/prototype/ProviderMark';
import {
  participantsFor,
  projectParticipants,
  statusStripFor,
  threadHeadFor,
} from '../app/prototype/seams';

/** A frozen stream, so the projection is exercised without a React hook. */
const STREAM: StreamState = {
  phase: 'planning',
  lines: [],
  added: 7,
  removed: 2,
  files: 1,
  elapsedMs: 0,
  spendMicros: 0,
  concern: null,
};

afterEach(cleanup);

/** A one-agent tree whose single session carries the status under test. */
function agentFixture(status: SessionStatus): MockAgent {
  return {
    id: 'a-nova',
    name: 'nova',
    model: 'opus-5',
    host: 'mac-01',
    room: 'demo',
    plans: [
      {
        id: 'p-nova',
        title: 'demo plan',
        status: 'open',
        drawsUsed: 0,
        drawsCeiling: null,
        budgetMicros: null,
        spentMicros: 0,
        sessions: [
          {
            id: 's-nova',
            model: 'opus-5',
            branch: 'feat/x',
            harness: 'claude-code',
            status,
            ctxPct: null,
            spendMicros: 0,
            ageMin: 1,
            certified: false,
          },
        ],
      },
    ],
  };
}

function roster(status: SessionStatus) {
  return projectParticipants({
    agents: [agentFixture(status)],
    spokenNames: ['nova'],
    collaborator: { name: 'dane', presence: 'here' },
  });
}

describe('#156 the faces row binds real presence and flips with the fixture', () => {
  it('projects a ParticipantSummary per member, kind-aware, with the viewer marked', () => {
    const people = roster('running');
    const viewer = people.find((p) => p.isViewer);
    expect(viewer?.name).toBe('you');
    expect(viewer?.kind).toBe('human');
    const nova = people.find((p) => p.id === 'a-nova');
    expect(nova?.kind).toBe('agent');
    // dane, the live collaborator, is present as a human
    expect(people.some((p) => p.name === 'dane' && p.kind === 'human')).toBe(true);
  });

  it('an unresolved speaker is the fail-closed `unknown` kind, never a person', () => {
    const people = projectParticipants({
      agents: [],
      spokenNames: ['ghost'],
      collaborator: { name: 'dane', presence: 'here' },
    });
    const ghost = people.find((p) => p.name === 'ghost');
    expect(ghost?.kind).toBe('unknown');
    expect(ghost?.presence).toBe('away');
  });

  it('FLIP THE INPUT: a session status change moves the rendered face presence', () => {
    const agentFace = (people: readonly ParticipantSummary[]) => {
      const { container } = render(<Faces people={people} />);
      const face = container.querySelector('[data-participant-kind="agent"]');
      expect(face, 'the agent face renders').not.toBeNull();
      return face?.getAttribute('data-presence');
    };

    const whenRunning = agentFace(roster('running'));
    cleanup();
    const whenSettled = agentFace(roster('settled'));

    expect(whenRunning).toBe('here');
    expect(whenSettled).toBe('idle');
    // the rendered state actually MOVED — the binding is live, not painted
    expect(whenRunning).not.toBe(whenSettled);
  });

  it('the face renders the shipped monogram and states its kind', () => {
    const { container } = render(<Faces people={roster('running')} />);
    const face = container.querySelector('[data-participant-kind="agent"]');
    expect(face?.textContent).toBe('NO'); // initials('nova')
    expect(face?.getAttribute('aria-label')).toContain('agent');
  });
});

describe('#156 ProviderMark renders the lab icon from the real model string', () => {
  it.each([
    ['opus-5', 'anthropic'],
    ['sonnet-5', 'anthropic'],
    ['gpt-5.6-sol', 'openai'],
    ['grok-4.6', 'xai'],
    ['mystery-7', 'other'],
  ])('%s → %s', (model, provider) => {
    const { container } = render(<ProviderMark model={model} />);
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(provider);
  });
});

describe('#156 the thread head and status strip are real projections', () => {
  it('threadHeadFor returns a RoomHeadRecord with kind-carrying members', () => {
    const head = threadHeadFor({ kind: 'session', id: 's-live' });
    expect(typeof head.name).toBe('string');
    expect(typeof head.topic).toBe('string');
    expect(head.members.length).toBeGreaterThan(0);
    // every member carries a kind, the way frame/RoomHead paints its faces
    expect(head.members.every((m) => m.kind === 'human' || m.kind === 'agent')).toBe(true);
    expect(head.members.some((m) => m.kind === 'human')).toBe(true);
  });

  it('participantsFor binds the live thread to real ParticipantSummary rows', () => {
    const people = participantsFor({ kind: 'session', id: 's-live' });
    expect(people.some((p) => p.isViewer)).toBe(true);
    expect(people.some((p) => p.kind === 'agent')).toBe(true);
  });

  it('statusStripFor assembles branch/base/model/host from the session', () => {
    const strip = statusStripFor({ kind: 'session', id: 's-live' }, STREAM);
    expect(strip.branch).toBe('streaming-invoice-totals');
    expect(strip.base).toBe('main');
    expect(strip.model).toBe('opus-5');
    expect(strip.host).toBe('mac-studio-01');
    expect(strip.running).toBe(true);
  });
});
