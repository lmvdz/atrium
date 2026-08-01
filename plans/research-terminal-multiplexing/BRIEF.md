# Research brief — terminal multiplexing in Atrium's UI

## Provenance

- **Date**: 2026-08-01
- **Question**: can terminal multiplexing be introduced into Atrium's web UI, and what would it actually take?
- **Targets**: github.com/herdrdev/herdr (HEAD `219e0be3`, Rust, Apache-2.0, ~23.3k stars) plus the browser-terminal landscape as of August 2026.
- **Method**: two parallel read-only scouts — `herdr-arch.md` (source-level dissection at a pinned SHA) and `webterm-landscape.md` (current tooling, cited with URLs and dates). Nothing was written to herdr: no issues, comments, forks, branches or PRs.
- **Destination chosen by Lars**: intel plus a recorded decision. Build tickets stay in the fog until Phase 4; nothing competes with the standing Phase-2 goal.
- **Confidence**: HIGH on herdr (pinned SHA, source read). HIGH on the tooling landscape (each claim carries a source URL). The cost estimates below are mine and are the softest part of this document.

## The first finding reframes the question

**herdr is not a web terminal.** It is a native TUI: no HTTP or WebSocket server, no xterm.js, no browser client anywhere in the tree; its "remote" mode is SSH, not browser remoting. It cannot be adopted, embedded, or pointed at a browser.

What it is good for is **decisions already paid for by someone shipping a serious multiplexer**:

1. **Vendor a real VT engine; do not write one.** herdr uses Ghostty's `libghostty-vt` through FFI rather than implementing terminal emulation. The browser analogue is xterm.js — the same decision, made the same way.
2. **Vendor and patch a PTY layer; do not write one.** herdr vendors `portable-pty` (the wezterm crate) with local patches.
3. **Coalesce and diff, do not stream bytes.** herdr collapses PTY-output signals into one render tick and diffs the resulting screen before sending. This is a materially different answer to backpressure than xterm.js's ack-based flow control, and it is the one most relevant to an agent-output workload where a burst is the normal case rather than the exception.
4. **Frame caps are explicit and sized**, and **resize is an explicit sized control message** rather than an ambient event.
5. **The one reusable seam**: `herdr terminal session observe|control` — a subprocess that emits and accepts newline-delimited JSON carrying base64 ANSI frames over stdio. That is a shape a Node/WebSocket layer could speak to, and it is also exactly the shape Atrium would otherwise have to invent.

## What the stack would actually be

- **Renderer**: `@xterm/xterm` **6.0.0**, MIT, zero-dependency core, the renderer behind VS Code, Coder, Gitpod, JupyterLab, sshx and every browser terminal worth naming. Note two v6 facts: the **canvas addon is deprecated and does not work with v6** (DOM or `@xterm/addon-webgl` only, so Safari/iPadOS falls back to the slower DOM path), and there is a **hardcoded ~50MB buffer ceiling** that silently discards scrollback regardless of the configured line count.
- **PTY**: `node-pty` is MIT and is what VS Code uses, but it is shipping `1.2.0-beta.*` rather than a tagged stable, and **it publishes no musl prebuilts** ([issue #852](https://github.com/microsoft/node-pty/issues/852)) — Alpine compiles from source. Alternatives: `@homebridge/node-pty-prebuilt-multiarch` (prebuilds including musl, Node 20+), `portable-pty` via N-API, `replit/ruspty`. **No mainstream WASM PTY exists and cannot** — a PTY is an OS syscall surface.
- **Multiplexing model**, four options with different durability: run real tmux server-side and attach (survives refresh and disconnect, not host reboot; tmux owns scrollback); a custom session manager owning N PTYs (VS Code's Pty Host, with explicit *process reconnect* and *process revive*); one PTY per pane with client-side layout (sshx, Zellij); or container `exec` (Codespaces — reconnects without killing processes, but visible contents do not survive a full restart).

## The finding that matters most for Atrium

**Nobody merges concurrent terminal input.** sshx, tmate, Zellij and VS Code Live Share all sidestep it identically: **access control, not data-layer merge** — read-only tokens, a `ro-` connection string, per-terminal read/write permission. sshx's multiplayer cursors are visual awareness only. A raw PTY has no concept of two cursors editing one buffer, and no surveyed tool attempts OT or CRDT over one.

That is not a limitation Atrium can design around; it is a property of the substrate. And it lands precisely on doctrine Atrium already holds. The design corpus's own object model says *"the terminal stays the break-glass exception"* and *"steering a session = say it in the agent channel; the loop routes down"* — i.e. the shared surface is the conversation, and the terminal is a single-driver escape hatch. The industry's answer and Atrium's existing answer are the same answer, reached independently: **many observers, one driver, and the handoff is an explicit act.**

## Security: this is RCE as a feature

A browser-facing terminal is SSH-equivalent risk, not an ordinary web feature — any auth bypass is immediately full shell access rather than an information leak. The precedent is concrete: **ttyd shipped an unauthenticated RCE** via its WebSocket callback handling (NCC Group / Fox-IT, March 2017). The standard model across sshx, tmate and Zellij is per-session unguessable tokens minted by the trusted server, TLS/WSS throughout, and read-only as a *separately authenticated capability* rather than a UI toggle.

Atrium's auth boundary has taken ten gauntlet rounds to reach its current state, and #26 is still open. Attaching an RCE-grade surface to it today would be attaching the highest-consequence feature in the product to its least-settled boundary.

## Verdict

**Technically feasible with a known, boring stack — and correctly out of scope for v1.** Three reasons, in order of weight:

1. **The seam does not exist yet.** `init.md` defines `ExecutionProvider` as the port terminals would attach to, and there is no implementation and no consumer. Building a terminal before the execution model exists means designing the execution model implicitly, from the UI inward — the exact inversion `init.md` warns against.
2. **It lands on the least-settled boundary.** See above.
3. **It collides with a deployment we only just made real.** #40 got the stack serving for the first time this session; `node-pty` has no musl prebuilds, so introducing it either forces a base-image decision or a Rust-backed PTY with its own toolchain burden. That is a real cost paid against a Phase-2 goal.

**What to carry forward when Phase 4 arrives** (now recorded in the map's fog):
- xterm.js 6 + WebGL addon, with the DOM fallback acknowledged for Safari and the ~50MB ceiling treated as a *server-side ring buffer requirement*, not a client setting.
- A PTY choice made against the shipped base image, not against the developer laptop — `@homebridge/node-pty-prebuilt-multiarch` or a Rust-backed layer if the image stays musl.
- **herdr's coalesce-and-diff render tick** rather than byte streaming, because agent output is bursty by nature; xterm.js's ack-based flow control as the fallback contract.
- **Many observers, one driver, explicit handoff**, with read-only as an authenticated capability — matching both the industry consensus and the corpus's break-glass rule.
- Resize as an explicit sized control message; frame caps explicit and sized.
- A session model that states plainly what survives a refresh, a disconnect, and a restart — the four strategies differ exactly there, and the answer belongs in the ticket rather than in the code.

Everything here is borrow-the-pattern. There is no dependency to adopt from herdr: wrong language, wrong runtime, wrong surface — and its one usable seam is a stdio JSON protocol Atrium would be reimplementing anyway.
