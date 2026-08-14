import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REAL-REPO EXECUTION MODE — the pure half (#141).
 *
 * The shape checks and path algebra that decide whether an upstream is legal,
 * and whether a path this server WRITES would land inside the repository a
 * session forks from. Deliberately dependency-free (no `child_process`, no
 * `Env`) so the same functions bind at the config layer (`env.ts`), the git
 * plumbing (`git.ts`), and the providers — one implementation, three layers,
 * rather than three that agree until one of them drifts.
 *
 * ## THE UPSTREAM IS NEVER WRITTEN
 *
 * The headline invariant of #141. This module contributes the two refusals that
 * are about the SHAPE of the configuration; `git.ts` contributes the two that
 * are about the OPERATION; the providers contribute the one that is about the
 * WIRING. Each refusal sentence below is deliberately distinct from every other
 * refusal in the seam — a test that greps for one must not accidentally satisfy
 * itself on another (`upstream-guards.test.ts` asserts that pairwise).
 */

/**
 * WHERE A REAL-REPO SESSION FORKS FROM — a location and an exact ref.
 *
 * `url` is an absolute local path or a remote URL; `ref` is the exact ref the
 * scratch trunk is seeded from. There is no default ref: the trunk a session
 * diffs against is not a thing to guess at.
 */
export interface UpstreamSeed {
  readonly url: string;
  readonly ref: string;
}

/**
 * The URL schemes an upstream may name, as an ALLOWLIST.
 *
 * Allowlist, not denylist, for the campaign's standing reason: the denylist's
 * gaps fail open and silent. The exotic transports git otherwise accepts —
 * `ext::<command>` (runs an arbitrary command as the transport!), `scp`-style
 * `host:path`, a bare relative path resolved against a cwd nobody pinned — are
 * excluded by not being on this list, rather than by being remembered.
 */
export const UPSTREAM_URL_SCHEMES = ['https://', 'http://', 'ssh://', 'git://', 'file://'] as const;

/** Is this a syntactically acceptable upstream location? */
export function isAcceptableUpstreamUrl(url: string): boolean {
  if (url.startsWith('-')) return false;
  if (isAbsolute(url)) return true;
  return UPSTREAM_URL_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/**
 * The LOCAL absolute path an upstream names, or `null` when it is remote.
 *
 * Only a local upstream can be overlapped by a directory this server writes, so
 * only a local upstream has an overlap question to answer. A `file://` URL is
 * resolved the same way a bare path is — otherwise the same directory would be
 * spelled two ways, one checked and one not.
 */
export function upstreamLocalPath(url: string): string | null {
  if (isAbsolute(url)) return resolve(url);
  if (url.startsWith('file://')) {
    try {
      return resolve(fileURLToPath(url));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Do these two local paths overlap — the same directory, or one INSIDE the
 * other?
 *
 * Equality alone is not the question. An artifact repo at
 * `<upstream>/.git/atrium-artifacts` is not equal to the upstream and would
 * still write inside it, which is exactly the write the invariant forbids. So
 * containment counts, in both directions, and the comparison is on RESOLVED
 * paths so `/repo` and `/repo/../repo` cannot be two different answers.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  if (left === right) return true;
  return left.startsWith(right + sep) || right.startsWith(left + sep);
}

/**
 * REFUSAL 1 — the ref must be a well-formed, option-free ref name.
 *
 * `git fetch <url> <ref>` puts the ref on an argv. A value like `--upload-pack=…`
 * is an OPTION, not a ref, and a value carrying `:` is a REFSPEC that writes a
 * local ref nobody asked for. The compliant form is allowlisted — letters,
 * digits, `._/-` — rather than the hostile forms being enumerated.
 */
export const UPSTREAM_REF_REFUSAL =
  'refusing an execution upstream ref that is not a well-formed, option-free git ref name ' +
  '(#141) — the compliant form is letters, digits and ._/- , so no argv element on the fetch ' +
  'path can be read as a flag or as a refspec';

/**
 * REFUSAL 2 — the location must be an absolute path or an allowlisted scheme.
 *
 * A leading `-` makes git read the location as a FLAG (`--upload-pack=/bin/sh`
 * is a remote-code primitive, and it is accepted where a repository was
 * expected). `ext::` names a command as the transport. A relative path resolves
 * against whatever cwd the process happens to hold. None of the three is an
 * upstream, and each is refused here before a fetch is ever spawned.
 */
export const UPSTREAM_URL_REFUSAL =
  'refusing an execution upstream location git would resolve as a flag, an ext:: transport, or ' +
  'a cwd-relative path (#141) — name an absolute directory or a ' +
  `${UPSTREAM_URL_SCHEMES.join(' / ')} URL`;

/**
 * Validate a seed at the boundary, before either half reaches an argv.
 *
 * Called by `createScratchRepo` — i.e. on the ONLY path that fetches — rather
 * than only at config load, so a caller that builds a seed by hand (a test, a
 * future daemon) gets the same refusal the operator would.
 */
export function assertUpstreamSeed(seed: UpstreamSeed): void {
  if (!isAcceptableUpstreamUrl(seed.url)) {
    throw new Error(`${UPSTREAM_URL_REFUSAL}; got: ${seed.url.slice(0, 120)}`);
  }
  if (!isWellFormedRef(seed.ref)) {
    throw new Error(`${UPSTREAM_REF_REFUSAL}; got: ${seed.ref.slice(0, 120)}`);
  }
}

/**
 * The compliant ref form, allowlisted. Additionally rejects the shapes git's own
 * `check-ref-format` rejects and that the character class alone would let
 * through: `..`, a leading or trailing `/`, an empty component, a `.lock`
 * suffix, and a leading `.` or `-` on any component.
 */
export function isWellFormedRef(ref: string): boolean {
  if (ref === '' || ref.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  if (ref.includes('..')) return false;
  if (ref.startsWith('/') || ref.endsWith('/')) return false;
  if (ref.endsWith('.lock') || ref.endsWith('.')) return false;
  return ref
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.startsWith('-'));
}
