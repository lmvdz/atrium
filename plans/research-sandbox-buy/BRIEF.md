# Research: the sandbox BUY — E2B vs Daytona vs ComputeSDK vs docker-first

Ticket: [#138](https://github.com/lmvdz/atrium/issues/138). Authority: [#120](https://github.com/lmvdz/atrium/issues/120)'s
resolution — BUY was decided, WHICH was not. This brief answers WHICH, against
what the `ExecutionProvider` seam actually needs.

## Provenance

Fetched 2026-08-14 (web dates as noted; the repo grounding is `git show` against
`build/execution-provider`, the branch carrying #120's implementation — not yet
merged to `main`).

- E2B pricing: https://e2b.dev/pricing (fetched 2026-08-14)
- E2B docs: https://docs.e2b.dev/ (fetched 2026-08-14)
- E2B self-host infra repo issue: https://github.com/e2b-dev/infra/issues/864 (via search, 2026-08-14)
- E2B self-host prerequisites: https://deepwiki.com/e2b-dev/infra/9.1-prerequisites-and-requirements (via search, 2026-08-14)
- E2B self-host cost writeup: https://www.agenticwire.news/article/e2b-self-hosted-guide (via search, 2026-08-14)
- Daytona pricing: https://www.daytona.io/pricing (fetched 2026-08-14)
- Daytona docs: https://www.daytona.io/docs (fetched 2026-08-14)
- ComputeSDK repo: https://github.com/computesdk/computesdk (fetched 2026-08-14)
- Cross-provider comparison (pricing/cold-start parity numbers): https://www.developersdigest.tech/blog/ai-agent-code-sandbox-comparison-2026 and related 2026 comparison posts, via WebSearch 2026-08-14 (aggregator content — cross-checked against the primary pricing pages above, not taken standalone)
- Isolation-technology landscape (gVisor/Firecracker/sysbox/Podman for agent sandboxing): https://northflank.com/blog/how-to-sandbox-ai-agents, https://amux.io/guides/ai-agent-sandboxing/, via WebSearch 2026-08-14

## Repo grounding — what the seam actually is

Read on `build/execution-provider` (unmerged; carries #120's built implementation):

- `apps/server/src/execution/provider.ts` — the `ExecutionProvider` interface:
  `resolve(ctx) → Workspace`, `run(workspace, ctx) → ExecutionReport`,
  `cancelAll()`. A `Workspace` is `{sessionId, dir, branch, remote, dispose()}`.
  An `ExecutionReport` is `{terminal: {ok, exitCode, detail}, receipt:
  {exitSummary, spendMicros, contextPct, artifact}}`. `artifact` is
  `{branch, commit, remote}` — never `main`, never merged; the land is a human
  `✓`, this seam only produces a branch a human can land.
- `apps/server/src/execution/worktree-provider.ts` — the ONE real adapter
  shipped today: spawns an arbitrary harness command (argv, never a shell
  string) in a git worktree on the **server's own disk**, in its own process
  group (for `cancelAll`/`SIGKILL` to reach the whole tree). Its own docblock
  states the refusal in a boxed comment: **"UNSAFE / DEV-ONLY — NOT A SECURITY
  BOUNDARY."** It stops the *obvious* escapes (env scrubbing, git retargeting)
  but "a hostile harness can still read/write the filesystem, open the
  network, and spend whatever the process user can." Gated behind
  `EXECUTION_ALLOW_UNSANDBOXED=1`, checked in three independent places
  (`env.ts` boot gate, `configure.ts` defense-in-depth, and the constructor
  itself — because the round-3 postmortem found the integration suite reached
  the factory on a path that never touched `Env` at all, an #89-class
  adjacent-path bypass). The harness env is a strict allowlist (`PATH`, `LANG`,
  `LC_ALL`, `LC_CTYPE`, `TERM`, `TZ`, plus a scrubbed `HOME`/`GIT_CONFIG_*`) —
  never raw `process.env`, so the harness cannot `printenv` the server's
  `DATABASE_URL`/`BETTER_AUTH_SECRET`/`AI_GATEWAY_API_KEY`/S3 keys.
- `apps/server/src/execution/sandbox.ts` — the BUY seam, defined but stub-only:
  `createSandboxProvider({ client })`. With no `client` every call throws
  `SandboxNotConfiguredError`. The interface it needs from a real provider is
  exactly two calls: `createWorkspace(ctx) → SandboxHandle` and
  `runHarness(handle, ctx) → ExecutionReport`, where `SandboxHandle` is
  `{id, branch, remote, workdir, destroy()}`. This is deliberately the entire
  contract a BUY has to satisfy — nothing else in the coordinator changes.
- `apps/server/src/execution/git.ts` — the shared git plumbing (`execFile`
  only, argv only, no shell) both the shim and the worktree adapter use: a
  per-session worktree on branch `atrium/session/<id>`, committed, and — this
  is the load-bearing requirement for any BUY — **pushed to a durable artifact
  repo** the provider controls (`pushArtifactBranch`), which is what
  `createArtifactVerifier` in `configure.ts` checks the settled receipt
  against (branch match + remote match + commit resolves at that ref, then
  pinned to a GC-root ref). **Any sandbox candidate must be able to run `git
  push` outbound to a remote Atrium controls** — this is not optional plumbing,
  it is the mechanism the whole verified-artifact guarantee is built on.
- `apps/server/src/env.ts` (`EXECUTION_*` block) — `EXECUTION_PROVIDER` is
  `'shim' | 'worktree' | 'sandbox'`, unset by default (execution disabled, the
  fail-closed default). `assertExecutionProviderSafe` refuses `worktree`
  without `EXECUTION_ALLOW_UNSANDBOXED=1` at boot — the same shape a sandbox
  flag will need (a loud, explicit opt-in, never a silent fallback).
- #120's own resolution text: *"a real sandbox is Atrium's differentiation... BUY the sandbox (E2B/Daytona/ComputeSDK)... Delta explicitly punted this (‘unrestricted device access’)."* Mastra ranked a sandboxed adapter #2 priority in its own comparable build. Delta (the prior-art project this campaign studies) punted the sandbox decision entirely — this ticket is Atrium closing that gap.

**Non-negotiables extracted from the above, for scoring below:**
1. **Per-session isolation is a security boundary** (#120 explicit) — not
   "isolated enough," genuinely walled off from the server's disk/secrets and
   from other sessions.
2. **Outbound `git push`** to a remote Atrium controls, from inside the
   sandbox, is required — the artifact flow has no other path to durability.
3. **Selective network egress** — enough for `git push` and package installs
   the harness needs, but the harness env allowlist pattern (deny by default,
   allow narrowly) is the established Atrium posture; a sandbox with no egress
   controls at all is a regression from the worktree adapter's env scrubbing,
   not an upgrade.
4. **Cold start** bounds session-open latency — a session opening is a
   user-facing action (`open_session` → this seam fires post-commit,
   fire-and-forget with respect to the ack, but a session that then sits
   "opening" for 10s reads as broken).
5. **Pricing must model against draws, not fixed capacity** — sessions are
   minutes-to-hours per #120/#118's draw model, so metered-per-second beats
   reserved-capacity/subscription-seat pricing.
6. **Local-dev/CI on a 4-core Linux box** — the box this campaign already runs
   on (`pnpm test:integration --maxWorkers=4`, #120's own gate) must be able to
   exercise the seam without a cloud account, or the acceptance test the
   ticket demands can't run in CI.

## Per-provider dissection

### E2B

- **Isolation model**: Firecracker microVMs — each sandbox boots its own
  kernel. This is real VM-grade isolation, not a shared-kernel container; it
  is the strongest isolation of the three vendor options on the isolation axis
  alone, matching Daytona's claim of "a dedicated kernel, filesystem, network
  stack."
- **Git/network posture**: SDK is Python/JS-first, sandbox exposes a normal
  Linux filesystem and shell, so `git push` from inside works as ordinary git
  — no documented first-class network-egress allowlist primitive was found in
  the fetched docs (the docs excerpt available did not detail egress
  restriction mechanics; this is a **gap to close before selecting**, not a
  disqualifier — E2B sandboxes do have general internet access by default,
  which needs to be paired with Atrium's own harness-env-style scrubbing
  inside the sandboxed process, same as the worktree adapter does today).
- **Cold start**: ~150ms class (per cross-provider comparison), a bit behind
  Daytona's ~90ms claim but well inside "sane" for a session-open path.
- **Pricing shape**: metered per-second — CPU $0.000014–$0.000112/s (1–8
  vCPU), RAM $0.0000045/GiB/s. This is the best-shaped pricing of the three
  vendor options against the draw model: a session that runs 20 minutes costs
  roughly 20 minutes, not a reserved slot. Free tier: $100 one-time credit, 1hr
  session cap, 20 concurrent sandboxes. Pro ($150/mo) raises the cap to 24hr
  sessions and 100 concurrent (1,100 on request).
- **Local/CI story**: `e2b-dev/infra` is Apache-2.0 and self-hostable, but the
  self-host path is a full Nomad+Consul orchestration stack on GCP (AWS beta),
  with a hard **quota floor of 2,500 GB SSD and 24 CPUs** before Terraform
  provisions anything, and a fetched-Firecracker-kernel dependency. That is
  categorically not a 4-core Linux box story — it is a second production
  system to operate. Estimated self-host infra floor is roughly $1,100/mo
  above the $150 Pro tier — it only pays for itself past roughly 10,000
  vCPU-hours/month of cloud usage. **For local dev/CI, E2B means the cloud
  account, not self-host** — free-tier credits could cover CI runs but that is
  an external network dependency in the test suite, which the repo's own
  pattern (deterministic shim as the tested default, `pnpm
  test:integration --maxWorkers=4` with no network) argues against.
- **Lock-in**: SDK-shaped (Python/JS clients, proprietary control plane even
  though the runtime is OSS); the self-host path exists on paper but is
  operationally heavy enough that most adopters are on the hosted control
  plane, which is where the lock-in actually lives (billing, sandbox
  templates, API surface).

### Daytona

- **Isolation model**: "full composable computers" — "complete isolation, a
  dedicated kernel, filesystem, network stack" per sandbox. Vendor-claimed
  parity with E2B on the isolation axis; no independent isolation-technology
  detail (Firecracker vs other microVM) surfaced in the fetched docs excerpt.
- **Git/network posture**: dedicated "Git Operations" doc section — git is a
  first-class, documented capability, ahead of E2B's docs on this specific
  point. "Network Limits" appears as a named system-tool feature, suggesting
  Daytona has an explicit egress-control primitive rather than "you get a
  normal Linux network stack and scrub it yourself" — this is the one vendor
  where selective egress looks designed-for rather than incidental, though the
  fetched excerpt didn't give the exact allowlist mechanics.
- **Cold start**: **~90ms claimed** — the fastest of the three vendor
  options, and the number Daytona's own marketing leads with ("spinning up in
  under 90ms from code to execution"). Best fit for keeping `open_session`
  latency low.
- **Pricing shape**: metered — vCPU-hour based (Windows sandboxes explicitly
  $0.0858/vCPU/h; general compute at rough price parity with E2B per
  cross-provider comparison, ~$0.0504/vCPU-hr) plus GiB-hour memory (5 GiB
  free per sandbox). Same shape class as E2B: per-second/per-hour metering
  fits the draw model, not a seat/subscription.
- **Local/CI story**: **Bring Your Own Compute (BYOC)** is a named,
  documented deployment mode — pointing Daytona's control plane at
  infrastructure Atrium already owns, which is a materially different
  proposition from E2B's "stand up Nomad+Consul yourself." This is the one
  vendor option with a plausible path to running against a 4-core Linux box,
  though the fetched docs excerpt did not give BYOC's own minimum hardware
  floor — that needs to be confirmed before this becomes a CI dependency, not
  assumed from the marketing page.
- **Lock-in**: same SDK-shaped lock-in class as E2B (Python/TS/Ruby/Go/Java
  SDKs, proprietary control plane); BYOC softens infra lock-in specifically
  but the control plane (billing, orchestration, sandbox API) is still
  Daytona's.

### ComputeSDK

- **What it is**: not a sandbox provider — a provider-agnostic TypeScript
  abstraction layer (MIT, ~256 stars, ~1,474 commits at fetch time) wrapping
  25+ backends including E2B, Daytona, Modal, Vercel, Cloudflare, CodeSandbox.
  API surface: `create()/getById()/list()/destroy()`, `runCommand()`,
  filesystem primitives (`writeFile/readFile/mkdir/readdir/exists/remove`).
- **Git/network posture**: **no git-operations primitive and no
  network-egress-control primitive surfaced anywhere in the repo** at fetch
  time. This is a real gap against non-negotiable #2 above (outbound git push)
  — ComputeSDK's abstraction covers exec+filesystem, not the artifact-push
  path Atrium's verifier depends on, so using it would mean shelling `git`
  through `runCommand()` anyway, which is exactly what direct SDK use already
  does, with an extra abstraction layer in between and none of its value
  (the common-denominator API) actually used for the one thing that matters
  here.
- **Cold start / pricing / isolation**: not ComputeSDK's own properties — it
  inherits whatever the underlying provider gives it, with the additional risk
  that an abstraction can silently expose only the lowest-common-denominator
  configuration surface (e.g. if egress controls aren't in ComputeSDK's schema,
  a team using it may never realize a given backend actually offers one).
- **Local/CI story**: none of its own — same as underlying provider.
- **Lock-in**: this is ComputeSDK's actual pitch — avoid vendor lock-in by
  coding to one API and swapping the backend later. That pitch is real but
  weak here specifically: the `ExecutionProvider` interface in
  `provider.ts` **already is** that abstraction layer, purpose-built for
  Atrium's exact three verbs (resolve/run/report) and its exact artifact
  contract. Routing a sandbox client through ComputeSDK would mean
  implementing `SandboxClient` against ComputeSDK's narrower common-denominator
  API instead of against the vendor SDK directly — an abstraction under an
  abstraction, buying no new optionality Atrium doesn't already have from its
  own seam, while adding a dependency (256-star project, unclear governance
  velocity) on the path to the thing #120 named the differentiator.

### docker-first (the local worktree provider + hardened containers, no vendor)

- **Isolation model**: today's shipped `worktree-provider.ts` is **shared-kernel,
  no containment** — its own docblock calls this out in bold, boxed prose:
  "NOT A SECURITY BOUNDARY." A genuine docker-first path means going further
  than what's shipped: gVisor (`runsc`, syscall interception, user-space
  kernel — "VM-level security with container-level overhead") or a microVM
  runtime (Firecracker directly, Kata Containers) run locally, without a
  vendor. 2026 field consensus (Northflank, amux.io writeups) is explicit that
  plain Docker/runc shared-kernel isolation is no longer considered adequate
  for untrusted agent-generated code — gVisor or a microVM is the honest floor
  even in a self-run/docker-first design, not "add Docker" alone.
- **Git/network posture**: full control — same `git.ts` plumbing already
  shipped works unmodified inside a gVisor-wrapped container; egress can be
  scoped with iptables/nftables per-container network namespace, which is more
  work to build than a vendor's "Network Limits" checkbox but has no ceiling
  on what can be expressed (this is the one option where the harness-env
  allowlist pattern already in `worktree-provider.ts` extends naturally to a
  network allowlist of the same shape).
- **Cold start**: gVisor containers start in the same ballpark as plain
  containers (low hundreds of ms to a few seconds depending on image size) —
  competitive with the vendor numbers, likely slower than Daytona's 90ms
  microVM claim but not by an order of magnitude, and it's the option where
  Atrium controls the number directly (image size, warm pool) rather than
  depending on a vendor's infra.
- **Pricing shape**: the server's own compute — no per-second sandbox
  metering at all, cost is whatever the host already costs. Best possible
  shape against the draw model in one sense (zero marginal sandbox cost) and
  worst in another (no automatic elasticity — Atrium's own box is the ceiling
  on concurrent sessions, which the vendor options solve by definition).
- **Local/CI story**: this **is** the 4-core Linux box story — it already
  runs there today as the unsandboxed worktree adapter, and gVisor packages
  install on the same box (`runsc` ships as a runc-compatible OCI runtime,
  works under a standard `docker run --runtime=runsc` or containerd shim, no
  cloud account, no network dependency for CI). This is the only option in
  the four where the acceptance test in #120 ("a session opened under a
  funded plan runs... produces a receipt + a real artifact... in a scratch
  git remote") can run in CI with zero external accounts.
- **Lock-in**: none — it's OCI/gVisor, portable to any Linux host including a
  future migration to a vendor if the operational cost stops being worth it.

## Comparison table

| axis | E2B | Daytona | ComputeSDK | docker-first (gVisor) |
|---|---|---|---|---|
| isolation | Firecracker microVM, real boundary | vendor-claimed microVM parity, real boundary | inherits backend | gVisor: strong, syscall-interception; plain Docker (today's shipped adapter): **not a boundary** |
| git push (artifact flow) | works via normal shell/git | first-class documented "Git Operations" | not modeled — must fall through to `runCommand()` | works unmodified, same `git.ts` |
| network egress control | not surfaced in docs; assume default-open, must scrub in-sandbox | named "Network Limits" primitive, details unconfirmed | not modeled | full control via netns/iptables, more build effort |
| cold start | ~150ms class | **~90ms**, fastest claimed | inherits backend | ~hundreds of ms, Atrium-controlled |
| pricing shape vs draw model | per-second metering, good fit | per-second/hour metering, good fit, price parity w/ E2B | inherits backend + adds nothing | zero marginal cost, no elasticity ceiling solved |
| local-dev/CI on 4-core box | cloud account or heavy Nomad+Consul self-host (24 CPU / 2.5TB SSD floor) | BYOC exists but floor unconfirmed | inherits backend, no story of its own | **native — already what's shipped today** |
| lock-in | SDK + control plane; OSS runtime, heavy self-host | SDK + control plane; BYOC softens infra lock-in | claims to reduce lock-in, but duplicates Atrium's own seam with a narrower API | none — OCI-portable |
| free/eval cost to validate | $100 one-time credit | $200 credit | N/A (routes to above) | $0, already running |

## Ranked recommendation

**1. docker-first (harden the shipped worktree adapter with gVisor) as v1,
BUY validated in parallel before it becomes load-bearing for untrusted
harnesses.**

**2. Daytona**, if/when a real vendor BUY is warranted — best cold-start, a
first-class git story, and BYOC is the one vendor path that doesn't force
abandoning the 4-core-box CI story outright.

**3. E2B**, as the fallback vendor pick — isolation and pricing shape are
comparable to Daytona, but self-hosting is a second production system
(Nomad+Consul, 24-CPU/2.5TB-SSD floor) and the docs didn't surface a network-
egress primitive as directly as Daytona's "Network Limits."

**4. ComputeSDK: refused.** It solves a problem Atrium's own
`ExecutionProvider`/`SandboxClient` seam already solves — swap-the-backend
optionality — while adding nothing on the two things that actually gate a
BUY here (git push, egress control aren't in its abstraction at all). Using
it would mean building `SandboxClient` against ComputeSDK's narrower API
instead of the vendor's real one, for a dependency with unclear governance
velocity, in exchange for a portability guarantee the codebase's own seam
already provides for free. There is no version of "buy ComputeSDK" that beats
"implement `SandboxClient` directly against whichever vendor wins."

### Refusals named — what each option would force us to accept

- **E2B** forces accepting either (a) a network dependency in CI/local dev
  (cloud account, even on free credits) that the repo's own pattern
  explicitly avoids elsewhere (`INTERPRET_PROVIDER=acceptance-deterministic`
  exists for exactly this reason — no-network Phase-2 acceptance), or (b)
  standing up a second orchestration platform (Nomad+Consul) at a cost floor
  ($1,100+/mo) that only pays for itself well past this project's current
  scale.
- **Daytona** forces accepting an unconfirmed BYOC hardware floor and a
  "Network Limits" primitive whose exact mechanics weren't verifiable from
  public docs at fetch time — the pricing/cold-start case is strong, but
  selecting it today would mean shipping on a vendor detail this brief
  couldn't independently confirm without a real account (out of scope: "do
  NOT sign up for anything").
- **ComputeSDK** forces accepting an abstraction with a narrower surface than
  the seam already in the repo, for a lock-in problem `provider.ts` already
  solves — it is pure overhead here, not a hedge.
- **docker-first** forces accepting that the concurrency ceiling is this
  server's own hardware (no vendor elasticity), that gVisor has to be
  operated by Atrium rather than a vendor's SRE team, and that the isolation
  guarantee is only as strong as the team's own configuration of it —
  `worktree-provider.ts`'s existing boxed warning is the standing reminder
  that "docker-first" must mean gVisor-or-better, not the container-only
  adapter already shipped, or the covenant's "session is a security boundary"
  claim (#120) is not actually true in production.

## docker-first-then-buy assessment

**Yes — the local worktree provider + gVisor is a legitimate v1**, with one
condition: it must not stay the shipped `worktree-provider.ts` as-is. That
adapter's own docblock already says, in the loudest prose in the file, that it
is not a security boundary and is gated behind an opt-in
(`EXECUTION_ALLOW_UNSANDBOXED=1`) specifically because it is unsafe for real
untrusted harness commands. "docker-first" as a legitimate v1 means:

1. Wrap the existing harness-spawn path (`runHarness` in
   `worktree-provider.ts`) in a `runsc`/gVisor OCI runtime instead of a bare
   process group — same argv-only, no-shell, allowlisted-env discipline
   already built, with an actual kernel boundary underneath it instead of
   process isolation alone.
2. Keep the `EXECUTION_ALLOW_UNSANDBOXED` framing, but re-anchor what it
   gates: today it gates "real command, no containment"; a gVisor-hardened
   worktree adapter changes what unsandboxed *means* and the flag's refusal
   message should be updated to reflect that a real, if lighter-weight,
   boundary now exists.
3. Treat `sandbox.ts`'s `SandboxClient` interface as the parallel BUY track,
   validated against Daytona (rank 2) on a real account — spun up by a human
   (issue explicitly reserves signup for Lars), not blocking v1.

This sequencing matches what #120's own resolution already said: the shim is
the tested default, worktree is "one real adapter... behind a flag," and
sandbox is "not yet wired" but has its contract defined. Nothing here is a
new architectural decision — it is executing the existing plan and closing
the isolation gap the branch's own docblock flags as the reason the
covenant's security-boundary guarantee doesn't yet hold in production. A
vendor BUY remains the right eventual move for elasticity (no local ceiling)
and to get out of operating gVisor configuration correctness ourselves, but
nothing about the artifact flow, the verifier, or the coordinator changes
when that BUY lands — `sandbox.ts` is already shaped to receive it.
