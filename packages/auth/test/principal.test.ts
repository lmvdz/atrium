import { authModelOptions } from '@atrium/db';
import { describe, expect, it } from 'vitest';
import { parsePrincipalKind } from '../src/principal.js';

/**
 * What an identity says it is, and the two ways that answer can be wrong.
 *
 * The whole of #90's interlock rests on one sentence: `kind: 'human'` decides
 * every certification gate, and until agents existed it also just meant
 * "authenticated account". So the two failures that matter are not symmetric —
 * reading an agent as a person opens every gate, and reading a person as an
 * agent closes gates that should be open. Only the first is silent, which is why
 * the parser is an allowlist and its unknown case is `null` rather than a
 * default.
 */

describe('parsePrincipalKind', () => {
  it('accepts exactly the two kinds an identity can be', () => {
    expect(parsePrincipalKind('human')).toBe('human');
    expect(parsePrincipalKind('agent')).toBe('agent');
  });

  it('answers null for everything else, rather than falling back to human', () => {
    /**
     * Catches: `value === 'agent' ? 'agent' : 'human'`.
     *
     * That spelling passes both assertions above and answers "human" for a
     * missing column, a renamed field, a library upgrade that stopped returning
     * additional fields, a typo, and a non-string — five different failures, all
     * of them reported as "this machine is a person", none of them visible in a
     * log. `getAtriumSession` turns this `null` into no session at all, so an
     * unreadable kind ends the session instead of softening into the privileged
     * one.
     *
     * `model` and `system` are here on purpose: they are `actor_kind` values,
     * which describe an *event's* writer, and an identity can never be either.
     * A parser that accepted them would let the two enums bleed.
     */
    for (const value of [
      undefined,
      null,
      '',
      ' ',
      'Human',
      'AGENT',
      'model',
      'system',
      'robot',
      0,
      1,
      true,
      {},
      ['agent'],
    ]) {
      expect(parsePrincipalKind(value), `${JSON.stringify(value) ?? 'undefined'}`).toBeNull();
    }
  });
});

describe('the principal kind as Better Auth sees it', () => {
  it('is declared to the library, so it rides on the session rather than a second read', () => {
    // Every seam that has a session must be able to ask what sort of participant
    // it belongs to without going back to the database — `ws-auth.ts` resolves a
    // session on every upgrade AND on every revalidation pass, and a second query
    // per pass is a cost that gets optimised away by somebody who does not know
    // what it was for.
    expect(authModelOptions.user.additionalFields.principalKind.returned).toBe(true);
  });

  it('is never taken from a request body, on any route, mounted or not', () => {
    /**
     * The load-bearing line of the whole provisioning story, asserted rather than
     * described.
     *
     * `mounted.ts` publishes three Better Auth paths and sign-up is not one of
     * them, so today there is no HTTP route that could carry this field. That is
     * a fact about a list, and lists change. `input: false` is a fact about the
     * library's own field handling: it refuses to read the value from a request
     * body on every route it has, including the ones nobody has mounted yet.
     *
     * Catches: `input: true`, or dropping the key — either of which would make
     * "become an agent" (or "stop being one") something a signup payload could
     * ask for, on the day somebody widens the mounted list for an unrelated
     * reason.
     */
    expect(authModelOptions.user.additionalFields.principalKind.input).toBe(false);
  });

  it('defaults to the same value the column does, so signup and schema cannot disagree', () => {
    // Two places state what an ordinary signup produces — the library default and
    // the DDL default. They are the same string here; when they are not, an
    // interactive signup writes one thing and a direct insert writes another, and
    // the trigger that compares `actor_kind` to `principal_kind` starts refusing
    // appends for a reason nobody can find.
    expect(authModelOptions.user.additionalFields.principalKind.defaultValue).toBe('human');
  });
});
