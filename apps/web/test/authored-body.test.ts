import { describe, expect, it } from 'vitest';
import { authoredBody } from '../lib/authored-body.js';

describe('authored body boundary', () => {
  it('rejects blank input without trimming meaningful authored whitespace', () => {
    /** Mutation: call trim() on the value persisted as a person's speech. */
    expect(authoredBody('  indented code  \n')).toBe('  indented code  \n');
    expect(authoredBody(' \n\t ')).toBeNull();
  });
});
