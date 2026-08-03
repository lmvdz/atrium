import { describe, expect, it } from 'vitest';
import { multiplayerManifest } from '../e2e/support/multiplayer-manifest';

const users = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

describe('the #27 multiplayer manifest', () => {
  /**
   * Mutation: add/remove a row, let the absentee author during the missed
   * interval, or move either boundary by one. The browser proof's expected 120
   * missed messages would no longer describe the transcript it actually sent.
   */
  it('is exactly 200 rows with a 120-message author-free absence', () => {
    const manifest = multiplayerManifest('manifest', users);
    expect(manifest.messages.map((message) => message.seq)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    const missed = manifest.messages.filter(
      (message) => message.seq > manifest.absence.after && message.seq <= manifest.absence.through,
    );
    expect(missed).toHaveLength(120);
    expect(missed.some((message) => message.author === manifest.absentee)).toBe(false);
    expect(
      manifest.messages.filter((message) => message.author === manifest.absentee),
    ).toHaveLength(16);
  });

  /**
   * Mutation: turn a semantic fixture into incidental prose or place the
   * third-party commitment beyond the owner's 25-message history. The worker
   * could pass with no proof of one of #27's required object kinds.
   */
  it('pins the semantic and reconnect events to their evidence windows', () => {
    const manifest = multiplayerManifest('manifest', users);
    expect(
      manifest.messages
        .filter((message) => message.semantic !== null)
        .map(({ seq, semantic }) => [seq, semantic]),
    ).toEqual([
      [5, 'objective'],
      [25, 'objective'],
      [41, 'commitment'],
      [60, 'decision'],
      [75, 'open_question'],
      [90, 'claim'],
      [110, 'decision'],
      [130, 'claim'],
    ]);
    expect(manifest.messages[40]?.body).toContain(users[4]);
    expect(
      manifest.messages.filter((message) => message.attachment).map((message) => message.seq),
    ).toEqual([145]);
    /**
     * Mutation: leave the human-gated children unassociated, or pretend a
     * machine-accepted claim/question can be retroactively filed. The former
     * stops exercising both objectives; the latter asserts authority the
     * immutable accepted-object record deliberately does not grant.
     */
    expect(
      manifest.messages
        .filter((message) => message.semantic !== null && message.semantic !== 'objective')
        .map((message) => message.objective),
    ).toEqual([0, 0, null, null, 1, null]);
    expect(manifest.disconnect).toEqual({ after: 170, through: 180 });
    expect(
      manifest.messages
        .slice(manifest.disconnect.after, manifest.disconnect.through)
        .some((message) => message.author === manifest.disconnected),
    ).toBe(false);
  });
});
