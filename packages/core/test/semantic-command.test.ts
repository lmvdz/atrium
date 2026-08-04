import { describe, expect, it } from 'vitest';
import { parseSemanticCommand } from '../src/semantic-command.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';

describe('semantic slash commands', () => {
  /** CATCHES: adding a composer command without a deterministic semantic mapping. */
  it.each([
    ['/goal Ship the replay app', 'objective', { title: 'Ship the replay app', status: 'open' }],
    [
      '/decision Use Postgres',
      'decision',
      { statement: 'Use Postgres', decidedBy: null, status: 'active' },
    ],
    [
      '/question Who reviews this?',
      'open_question',
      { question: 'Who reviews this?', status: 'open' },
    ],
    [
      '/commitment I will write the test',
      'commitment',
      { statement: 'I will write the test', owner: ACTOR, due: null, status: 'open' },
    ],
    [
      '/claim The gate is green',
      'claim',
      { statement: 'The gate is green', claimant: ACTOR, verification: 'unverified' },
    ],
  ] as const)('maps %s to a proposed %s payload', (body, type, payload) => {
    expect(parseSemanticCommand(body, ACTOR)).toMatchObject({ type, payload });
  });

  /** CATCHES: parsing only the first line and dropping authored semantic content. */
  it('preserves newlines inside the derived content', () => {
    expect(parseSemanticCommand('/goal First line\nSecond line', ACTOR)?.payload).toEqual({
      title: 'First line\nSecond line',
      status: 'open',
    });
  });

  /** CATCHES: treating unknown or empty slash text as a semantic state change. */
  it.each(['/goal', '/goal   ', '/Goal nope', '/plan nope', ' /goal nope'])(
    'leaves %j as an ordinary message',
    (body) => expect(parseSemanticCommand(body, ACTOR)).toBeNull(),
  );
});
