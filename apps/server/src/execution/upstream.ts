import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
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

/** The same allowlist as protocols, which is what a parsed URL actually reports. */
const UPSTREAM_URL_PROTOCOLS: ReadonlySet<string> = new Set(
  UPSTREAM_URL_SCHEMES.map((scheme) => scheme.replace('//', '')),
);

/** The protocols that are meaningless without a host to reach. */
const AUTHORITY_REQUIRED: ReadonlySet<string> = new Set(['https:', 'http:', 'ssh:', 'git:']);

/**
 * A host that is plausibly a host — and, load-bearing, is NOT an argv flag.
 *
 * `new URL('ssh://-oProxyCommand=curl|sh/repo')` parses: `ssh:` is a non-special
 * scheme, so its authority is an *opaque host* and `=` is legal in one. The
 * prefix check this replaced accepted that string outright, and `-o…` reaching
 * git's ssh transport is a command-execution primitive. So the host is
 * allowlisted to a hostname/IP shape, and a leading `-` is refused twice over.
 */
function isPlausibleHost(host: string): boolean {
  if (host === '') return false;
  if (host.startsWith('[') && host.endsWith(']')) return /^\[[0-9A-Fa-f:.]+\]$/.test(host);
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(host);
}

/**
 * Is this a syntactically acceptable upstream location?
 *
 * PARSED, not prefix-matched (#141 r2). The prefix check this replaced answered
 * `startsWith('ssh://')`, which is true of `ssh://-oProxyCommand=…` and of the
 * hostless `https://`; and it answered *false* for `HTTPS://host/repo`, which is
 * the same URL git itself accepts — schemes are case-insensitive. Both halves of
 * that are wrong in the same way: a string prefix is not a URL.
 *
 * The allowlist is unchanged in spirit — an absolute local path, or one of
 * `UPSTREAM_URL_SCHEMES` — but it is now checked against the parse:
 *
 *  - the protocol must be on the allowlist (case-folded by the parser, so
 *    `HTTPS://` and `https://` are the one thing they always were);
 *  - `https`/`http`/`ssh`/`git` must carry a real authority, so bare `https://`
 *    and flag-shaped hosts are refused rather than handed to git;
 *  - `file://` must carry a path and may carry NO query or fragment — `?`/`#`
 *    are not path characters, and a `file://` URL wearing one is a value whose
 *    two readers (this module and git) would disagree about.
 */
export function isAcceptableUpstreamUrl(url: string): boolean {
  if (url.startsWith('-')) return false;
  if (isAbsolute(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!UPSTREAM_URL_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.username.startsWith('-') || parsed.password.startsWith('-')) return false;
  if (AUTHORITY_REQUIRED.has(parsed.protocol)) return isPlausibleHost(parsed.hostname);
  // `file:` — an authority is optional AND git-irrelevant: git localises EVERY
  // `file:` URL by DROPPING the authority (`file://anyhost/p` is `/p` to git), so
  // the host never decides local-vs-remote — `upstreamLocalPath` treats every
  // accepted `file:` URL as the local path it names. A PATH is required and a
  // query/fragment is refused (two readers, `file://` and git, would disagree on
  // one). The host, when present, is still shape-checked so a malformed authority
  // is refused loudly rather than silently ignored.
  if (parsed.search !== '' || parsed.hash !== '') return false;
  if (parsed.pathname === '' || parsed.pathname === '/') return false;
  return parsed.hostname === '' || isPlausibleHost(parsed.hostname);
}

/**
 * REFUSAL 6 — a `file://` URL nobody can canonicalise is REFUSED, never read as
 * "not local" (#141 r2).
 *
 * The defect this closes: `upstreamLocalPath` used to `try { fileURLToPath(url) }
 * catch { return null }`, and `fileURLToPath` throws `ERR_INVALID_FILE_URL_HOST`
 * on any `file://` URL with a non-empty host. So `file://127.0.0.1/srv/atrium`
 * returned `null` — read by every caller as "the upstream is remote, there is no
 * overlap question" — while git happily resolved it to the local directory
 * `/srv/atrium`. All four overlap guards no-opped on a spelling of the very path
 * they exist to protect. A swallowed parse failure is not an absence of danger;
 * it is an absence of knowledge, and the two must not share a return value.
 */
export const UPSTREAM_UNPARSEABLE_URL_REFUSAL =
  'refusing an execution upstream file:// URL this server cannot canonicalise to a directory ' +
  '(#141) — an unreadable location is not evidence that it is remote, and treating it as remote ' +
  'is what silently disables every overlap check';

/**
 * The LOCAL absolute path an upstream names, or `null` when it is genuinely
 * REMOTE. Throws `UPSTREAM_UNPARSEABLE_URL_REFUSAL` when it is neither.
 *
 * ## `file:` IS ALWAYS LOCAL — the host is git-irrelevant (#141 r3)
 *
 * The round-2 fix carried a fatal remnant: it kept a "remote `file://` host"
 * category, resolving only `localhost`/`127.0.0.1`/`[::1]` to a path and
 * returning `null` ("remote") for any OTHER host. But git does not honour a
 * `file:` authority AT ALL — it DROPS it and localises the path, for every host.
 * Verified, executed: `git fetch -- file://build-box.example.com/srv/atrium main`
 * runs `git-upload-pack '/srv/atrium'` and fetches the LOCAL directory. So a
 * non-loopback `file://` host skipped every overlap check (this returned "remote")
 * while git wrote locally under the upstream — the exact class of silent bypass
 * REFUSAL 6 exists to kill, reintroduced one host-allowlist narrower. There is no
 * "remote `file://`": every `file:` URL is the local path it names, authority
 * dropped exactly as git drops it.
 *
 * Three outcomes, because there are three states and the old two-state return
 * merged the dangerous one into the safe one:
 *
 *  - **local** — an absolute path, or ANY `file:` URL. The authority (a hostname,
 *    an IPv4/IPv6 literal, `localhost`, or nothing) is dropped before the path is
 *    read, because git drops it; `file://anyhost/p`, `file://localhost/p` and
 *    `file:///p` are one directory, `/p`.
 *  - **remote** (`null`) — every non-`file:` scheme (`https`/`http`/`ssh`/`git`):
 *    a network location with no local directory here to overlap.
 *  - **unparseable** (throw) — a `file:` URL git localises but this server cannot
 *    canonicalise to a directory (a `%2F`-encoded separator, a query/fragment).
 *    Fail closed: unreadable is not remote.
 */
export function upstreamLocalPath(url: string): string | null {
  if (isAbsolute(url)) return resolve(url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all and not an absolute path — `isAcceptableUpstreamUrl`
    // refuses this shape; from here it is simply not a local directory.
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  // git DROPS a `file:` authority and localises the path regardless of host, so
  // the host tells us nothing about local-vs-remote — every `file:` URL is local.
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${UPSTREAM_UNPARSEABLE_URL_REFUSAL}: ${url.slice(0, 120)}`);
  }
  const hostless = new URL(url);
  hostless.host = '';
  try {
    const path = fileURLToPath(hostless);
    if (path === '') throw new Error('empty path');
    return resolve(path);
  } catch {
    throw new Error(`${UPSTREAM_UNPARSEABLE_URL_REFUSAL}: ${url.slice(0, 120)}`);
  }
}

/**
 * The longest EXISTING prefix of `path`, dereferenced, with the not-yet-existing
 * tail re-appended.
 *
 * `resolve()` is pure lexical algebra: it collapses `..` and normalises
 * separators and knows nothing about the filesystem. A symlink is precisely a
 * path whose lexical spelling and real location differ, so an artifact dir that
 * is a symlink INTO the upstream resolves to something that does not look like
 * the upstream at all — and then `init --bare` writes through it. The directory
 * usually does not exist yet at check time (the server is about to create it),
 * which is why this walks up to the deepest component that DOES exist: a
 * symlinked parent is the same hazard one level up.
 */
function canonicalize(path: string): string {
  const start = resolve(path);
  const tail: string[] = [];
  let current = start;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without finding anything that exists — there
      // is nothing to dereference, so the lexical answer is the only answer.
      if (parent === current) return start;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** Same directory, or one inside the other — purely lexically. */
function lexicalOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return left.startsWith(right + sep) || right.startsWith(left + sep);
}

/**
 * Do these two local paths overlap — the same directory, or one INSIDE the
 * other?
 *
 * Equality alone is not the question. An artifact repo at
 * `<upstream>/.git/atrium-artifacts` is not equal to the upstream and would
 * still write inside it, which is exactly the write the invariant forbids. So
 * containment counts, in both directions.
 *
 * And LEXICAL containment alone is not the question either (#141 r2). The check
 * is run three ways and any one of them saying "overlap" is an overlap, because
 * this guard's only acceptable failure direction is a false refusal:
 *
 *  1. **resolved** — `/repo` and `/repo/../repo` are one directory.
 *  2. **dereferenced** — `canonicalize` above. A symlinked scratch or artifact
 *     dir pointing into the upstream is the same write with a different name.
 *  3. **case-folded** — on a case-insensitive filesystem (macOS's default, NTFS)
 *     `/Repos/Atrium` and `/repos/atrium` are ONE directory, and neither of the
 *     first two comparisons notices. Folding costs a false refusal on a
 *     case-SENSITIVE host holding two dirs that differ only in case; that is a
 *     configuration an operator can rename their way out of, and the other
 *     direction is a silent write to somebody's repository.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  const realLeft = canonicalize(a);
  const realRight = canonicalize(b);
  return (
    lexicalOverlap(left, right) ||
    lexicalOverlap(realLeft, realRight) ||
    lexicalOverlap(left.toLowerCase(), right.toLowerCase()) ||
    lexicalOverlap(realLeft.toLowerCase(), realRight.toLowerCase())
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CONFIGURED EXECUTION UPSTREAM (#141 r7) — the process-wide fact a mint reads.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The construction-time invariant needs ONE thing the per-call arguments cannot
 * honestly supply: "what is the upstream THIS PROCESS was configured against?"
 *
 * The r5/r6 lesson is that a guard is only as honest as the field it reads, and a
 * CALLER writes the fields it passes. Finding A (both critics, executed) is exactly
 * that reaching the mint: `createArtifactRepo(upstreamDir)` — with the `upstream`
 * argument simply LEFT OFF — mints a genuinely-branded ArtifactRepo pointed at the
 * upstream whose `upstreamPath` is `null`, and every downstream write then trusts
 * the brand. Threading a caller-supplied "configured upstream" would reintroduce the
 * same lie one argument over (`createScratchRepo(upstreamDir, undefined)` claims
 * "no upstream"). So the fact is NOT a parameter: it is recorded ONCE, at the trust
 * boundary that actually knows it (`configure.ts`'s `createExecutionProvider`, from
 * the same `EXECUTION_UPSTREAM_URL` the boot gate reads), and the factories read
 * THIS — a value no factory caller can write.
 *
 * `null` means "no local upstream configured in this process" — the classic
 * empty-trunk seam, or a genuinely remote upstream with no local directory to
 * overlap. In that state the mint guard is a no-op, exactly as it was before #141:
 * there is nothing to overlap. When it is a path, NO factory may brand+return a
 * handle whose directory overlaps it, seed passed or not.
 */
let configuredUpstreamLocalPathValue: string | null = null;

/**
 * Record the configured execution upstream for this process, from its URL (the
 * same value `assertExecutionUpstreamSafe` validated at boot). `undefined` or a
 * remote URL records `null` (nothing local to overlap). Called by the provider
 * trust boundary BEFORE it mints any repo handle; idempotent and last-writer-wins,
 * which is correct for a process that configures exactly one execution provider.
 */
export function setConfiguredExecutionUpstream(upstreamUrl: string | undefined): void {
  configuredUpstreamLocalPathValue =
    upstreamUrl === undefined ? null : upstreamLocalPath(upstreamUrl);
}

/**
 * The configured upstream local path this `dir` overlaps, or `null` when it is
 * safe (no configured upstream, a remote one, or no overlap). `pathsOverlap`
 * canonicalises both sides, so a symlinked `dir` is caught by realpath, not only
 * lexically. This is the one question the construction-time mint guard asks.
 */
export function configuredUpstreamMintOverlap(dir: string): string | null {
  if (configuredUpstreamLocalPathValue === null) return null;
  return pathsOverlap(dir, configuredUpstreamLocalPathValue)
    ? configuredUpstreamLocalPathValue
    : null;
}

/** Clear the recorded configured upstream — TEST-ONLY, so a suite can isolate the mint guard. */
export function resetConfiguredExecutionUpstreamForTest(): void {
  configuredUpstreamLocalPathValue = null;
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
  `${UPSTREAM_URL_SCHEMES.join(' / ')} URL with a real authority where the scheme needs one`;

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
