# Real-repo execution mode (#141)

A session's artifact is a git branch. Until now that branch forked an **empty
trunk**: `createScratchRepo` initialised a repo, wrote a one-line
`README.atrium`, committed it, and every session's work was a diff against that.
Useful for proving the seam; useless for producing a change to a repository
anybody cares about.

Real-repo mode points the trunk at a real repository. Configure an upstream and
a ref, and the scratch trunk is **fetched** from it; worktrees fork *that*, and
the settled artifact branch — pushed to the durable artifact repo — is a genuine
diff against the ref you named, fetchable by a human for a manual merge.

## Configuring it

```
EXECUTION_PROVIDER=worktree            # or shim
EXECUTION_SCRATCH_DIR=/var/lib/atrium/execution
EXECUTION_ARTIFACT_DIR=/var/lib/atrium/artifacts
EXECUTION_HARNESS_COMMAND=["bash","-lc","..."]
EXECUTION_ALLOW_UNSANDBOXED=1          # worktree only, and it means it

EXECUTION_UPSTREAM_URL=/srv/repos/atrium
EXECUTION_UPSTREAM_REF=main
```

Both upstream variables are required together. The ref has **no default**: which
commit the work is a diff *against* is the one fact this mode exists to state,
and a silently-assumed `main` would let a misconfigured deployment produce
plausible, wrong diffs. Setting one without the other is a boot failure, as is
setting either against a provider that seeds no trunk (`sandbox`, or execution
disabled) — real-repo configuration that does nothing is the failure this ticket
was filed about, so it is named at boot rather than discovered later.

`EXECUTION_UPSTREAM_URL` must be an absolute local path or an `https://`,
`http://`, `ssh://`, `git://` or `file://` URL. That is an allowlist, and the
things it excludes are the point: `ext::<command>` names an arbitrary command as
git's transport, a leading `-` makes git read the value as a **flag**
(`--upload-pack=/bin/sh` is remote code execution where a repository was
expected), and a relative path resolves against whatever working directory the
process happens to hold.

## Fetching a human's branch back out

```
git fetch <EXECUTION_ARTIFACT_DIR> atrium/session/<session-id>
git diff <upstream-ref> FETCH_HEAD          # what the session did
git merge FETCH_HEAD                        # the human ✓, by hand
```

The receipt on `session_settled` carries `{branch, commit, remote}`; `remote` is
the artifact repo, which is deliberately never torn down. The scratch repo the
worktrees lived in is disposed at shutdown, and the branch survives it.

## THE UPSTREAM IS NEVER WRITTEN

The covenant already said the artifact is a branch and never a land. Real-repo
mode sharpens it: the repository being forked is somebody's actual repo, and
nothing in this process may write it. The provider does not push to the
upstream — **the human pulls from the artifact repo**.

The only operation this seam performs against the upstream is `git fetch`. No
`clone` (which would write an `origin` whose `pushurl` a later edit could aim
back), no `remote add`, and no ref in the upstream is ever named as a push
destination.

That is the claim. It is enforced at three layers, each with its own refusal
sentence and its own red-on-revert witness, because a guard present on one layer
and absent on the adjacent one is the failure class this campaign keeps meeting:

| Layer | Where | What it refuses |
| --- | --- | --- |
| Config | `env.ts` · `assertExecutionUpstreamSafe` | a half-set pair; an upstream under a provider that seeds no trunk; a location git would read as a flag, an `ext::` transport or a relative path; and — the load-bearing one — a `EXECUTION_SCRATCH_DIR` or `EXECUTION_ARTIFACT_DIR` that **overlaps** the upstream |
| Plumbing | `upstream.ts` · `assertUpstreamSeed` | a ref that is not a well-formed, option-free ref name, and a location on the same allowlist as above — checked on the only path that fetches, so a hand-built seed gets the operator's refusal |
| Plumbing | `git.ts` · `createArtifactRepo` | opening the durable artifact repo at or inside the upstream. `init --bare` plus two `config` writes would modify it — at **boot**, before any session exists |
| Plumbing | `git.ts` · `pushArtifactBranch` | pushing a session branch into a destination overlapping the upstream. Re-checked at the write because an `ArtifactRepo` is a plain object a caller can assemble without passing the boot gate |
| Provider | `shim.ts` · `worktree-provider.ts` | building an upstream-seeded provider with no durable artifact remote, or one that is the upstream. Without a durable remote the artifact `remote` falls back to the scratch repo, which teardown deletes — a receipt naming a remote nobody can fetch from |

"Overlap" is containment in both directions, on resolved paths: an artifact repo
at `<upstream>/.git/atrium` is not *equal* to the upstream and would still be
written inside it.

The witnesses live in `apps/server/test/execution/upstream-guards.test.ts`
(every refusal, plus a table asserting the sentences are pairwise disjoint — a
shared refusal string is how a witness ends up passing with its own guard
reverted) and `integration/server/execution-upstream.test.ts`, which runs a real
session whose harness deletes a known file and asserts the fetched branch's diff
against the upstream ref is exactly that deletion, the commit's parent is the
upstream commit, and the upstream is **byte-identical** — every file hashed
before and after — with its ref set unchanged.

## What this does not change

Not the sandbox story. The `worktree` provider still runs an arbitrary harness
on this server's own disk, is still opt-in, and is still not a security
boundary; real containment is the `sandbox.ts` BUY seam. Real-repo mode makes
the *artifact* real. It does not make the *isolation* real.

Not the covenant. Trunk still never moves, nothing is merged, and the artifact
is still a branch waiting for a human `✓`.

And not the empty-trunk seam. With no upstream configured, `createScratchRepo`
behaves exactly as it did: a synthetic `README.atrium` commit, and every #120
guarantee unchanged.
