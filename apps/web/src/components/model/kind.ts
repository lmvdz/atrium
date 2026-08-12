/**
 * What a participant IS, read from the identity, not from the copy around it.
 *
 * This is the browser-safe twin of `@atrium/auth`'s `PrincipalKind`, kept in its
 * own low module because two model files need it and neither may depend on the
 * other: `records.ts` (the roster/participant view model) re-exports it, and
 * `quotation.ts` (the message/attribution model, which `records.ts` imports)
 * reads it to give a message its author's kind. A single union in one place is
 * the whole point — the round-1 gauntlet's lesson was that a kind list repeated
 * across surfaces is a list that disagrees with itself the next time it grows.
 *
 * `'human'` and `'agent'` mirror the two values `users.principal_kind` carries.
 * The view model keeps its own copy of the union rather than importing the
 * server package, so the component library stays free of a database dependency;
 * the single translation from the stored column happens where a row is read.
 *
 * `'unknown'` is the THIRD member, and it is the fail-closed one. It is not a
 * stored value — `users.principal_kind` is NOT NULL and carries only the first
 * two — it is what an UNREADABLE kind renders as: a renamed column, a library
 * upgrade that stops returning the field, an enum value added in a later
 * migration, a hand-built fixture that forgot to set one. The round-1 gauntlet
 * found that defaulting those to `'human'` was not a cosmetic miss confined to a
 * monogram: the same default fed the mention filter (`kind === 'human'`) and the
 * "N people" count, so an unreadable-kind MACHINE became a mention candidate and
 * a counted person — which AGENTS.md forbids. So the default is `'unknown'`,
 * which every surface renders as visibly-not-a-person and which the human-only
 * filters exclude by construction, because they allowlist `'human'` rather than
 * denylisting `'agent'`. A future enum value therefore shows up as `unknown` on
 * screen — prompting a fix — instead of silently as a person.
 *
 * This stays a **presented** discriminant, never an authority one: the
 * certification gates that must fail closed live server-side, in the reducer, on
 * the `Actor`, and on `getAtriumSession`. What changed is that the record fails
 * closed too, in its own register, rather than softening an unreadable machine
 * into a person.
 */
export type ParticipantKind = 'human' | 'agent' | 'unknown';

/** The two kinds an identity actually IS. `'unknown'` is never one of these — it
 *  is the fail-closed rendering of a value that is neither. */
const PARTICIPANT_KINDS: readonly string[] = ['human', 'agent'];

/**
 * Read a participant kind off a stored value, failing CLOSED to `'unknown'`.
 *
 * The browser-safe twin of `@atrium/auth`'s `parsePrincipalKind` — the view
 * layer is bundled for the client and may not import the auth package (it reaches
 * `node:fs` through Better Auth). An **allowlist**: anything that is not exactly
 * `'agent'` or `'human'` — a renamed column, a later enum value, an undefined
 * hand-built fixture — becomes `'unknown'`, NOT `'human'`. `parsePrincipalKind`
 * returns `null` for the same inputs and ends the session; this cannot end a
 * render, so it names the failure instead, and every renderer paints `'unknown'`
 * as neither a person nor an agent.
 */
export function participantKindOf(value: unknown): ParticipantKind {
  return typeof value === 'string' && PARTICIPANT_KINDS.includes(value)
    ? (value as ParticipantKind)
    : 'unknown';
}
