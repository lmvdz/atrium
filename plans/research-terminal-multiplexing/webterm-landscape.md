# Browser-based terminal multiplexing: state of the art (August 2026)

Context: scouted for a TypeScript/Next.js/Postgres/WebSocket product ("Atrium") evaluating what it takes to put multiplexed terminals in a web UI. Facts only.

## 1. Renderers

**xterm.js**
- Current stable: `@xterm/xterm` **6.0.0** (published ~Dec 22, 2024); a `6.1.0-beta.272` prerelease was live as of June 2026. Old unscoped `xterm`/`xterm-*` packages are deprecated in favor of the `@xterm/*` scope. ([Releases](https://github.com/xtermjs/xterm.js/releases), [GitHub](https://github.com/xtermjs/xterm.js))
- License: MIT (copyright 2017–2026). Zero-dependency core.
- Maintenance: actively developed (11k+ commits), used as VS Code's own terminal renderer.
- Rendering: DOM renderer is the built-in default. `@xterm/addon-webgl` (WebGL2 canvas context) is the recommended GPU-accelerated path and is what VS Code now defaults to. The separate `@xterm/addon-canvas` (2D canvas) renderer is **deprecated and does not work with v6** — v6 removed it as a breaking change, leaving only DOM or WebGL. Safari/iPadOS is still effectively stuck on the slower DOM renderer since WebGL2 support there has been historically weaker. ([addon-webgl README](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md), [cockpit-project issue on canvas deprecation](https://github.com/cockpit-project/cockpit/issues/22509), [DOM-default issue #3271](https://github.com/xtermjs/xterm.js/issues/3271))
- Unicode/CJK/emoji: core handles CJK, emoji, and IME input out of the box; `@xterm/addon-unicode11` updates character-width tables to the Unicode 11 spec; an experimental `@xterm/addon-unicode-graphemes` adds grapheme-cluster-aware width handling for complex emoji/combining sequences.
- Ligatures: opt-in via `@xterm/addon-ligatures`.
- Scrollback: configurable via the `scrollback` option (line count), but there is a hardcoded ~50MB internal buffer ceiling to prevent OOM — data beyond that is discarded regardless of the configured line count.
- Accessibility: has a built-in screen-reader mode and a minimum-contrast-ratio option.
- Flow control: xterm.js ships an official guide (`https://xtermjs.org/docs/guides/flowcontrol/`) describing an ack-based scheme for the server to pause/resume PTY reads based on how much data the client has actually processed — needed because without it, a fast-producing PTY can grow the terminal's internal write buffer unboundedly.

**Live alternatives to xterm.js**: there is no other renderer library with comparable adoption; the practical "alternatives" question in production is really xterm.js (DOM) vs xterm.js (WebGL) vs terminal-in-native-app (Warp, above). No credible from-scratch competitor (e.g., a WASM-rendered terminal emulator library) surfaced as production-adopted in this search pass — sshx, VS Code, Coder, Gitpod, JupyterLab, and ttyd/wetty/gotty's browser clients all render through xterm.js.

## 2. PTY layer for Node/TypeScript

**node-pty** (microsoft/node-pty)
- License: MIT (Christopher Jeffrey 2012–2015, Daniel Imms 2016, Microsoft 2018–).
- Latest releases are all `1.2.0-beta.*` (beta.14 as of ~late June 2026, with beta.10–13 through the preceding months) — the project has been shipping betas, not a tagged stable `1.2.0`, for some time. Commit history is active (1,391+ commits). ([Releases](https://github.com/microsoft/node-pty/releases))
- Requires Node.js 16+ or Electron 19+ per current docs; no explicit statement of Node 22/24 support found, and recent release notes are dominated by Windows ConPTY error-handling fixes (e.g., surfacing `CreateProcessW` failures as an `exit` event instead of an uncaught exception) rather than Node-version-support announcements.
- winpty support was fully removed; Windows requires ConPTY (Windows 10 1809+). Unix uses `forkpty(3)` bindings.
- **Known pain — native module + Docker/Alpine**: node-pty is a native (node-gyp-compiled) addon and does **not** ship official prebuilt binaries for musl libc (Alpine). The CI pipeline runs on Ubuntu 22.04 with no Alpine runner, so Alpine/musl users fall back to compiling from source at `docker build` time, which requires pulling in build-base/gcc/python in the image. This is a long-standing open issue (#852). Generic node-gyp-in-Alpine failures (missing build tools, glibc/musl struct mismatches e.g. around `termios`) are a recurring complaint across multiple related issues.
- **Prebuild-carrying fork**: `@homebridge/node-pty-prebuilt-multiarch` is a parallel fork maintained specifically to provide prebuilt ia32/amd64/arm/aarch64 binaries for macOS, Windows, and **both glibc and musl Linux** — it only prebuilds for Node.js 20+; older Node needs a source build fallback. A second fork, `@cocktailpeanut/node-pty-prebuilt-multiarch`, extends prebuilt coverage back to Node 16/Electron 16. These forks exist specifically because upstream node-pty doesn't cover musl.
- **Rust-backed alternatives**: `portable-pty` (a wezterm crate) is a cross-platform Rust PTY abstraction (unix `forkpty`-equivalent + Windows ConPTY) usable from Node via N-API bindings; projects like `get-pty-output` build on exactly that pattern (portable-pty + n-api-rs) to sidestep node-gyp entirely. `replit/ruspty` is another PTY-for-Node-via-Rust-FFI project from Replit. No mainstream WASM-compiled PTY implementation was found — PTYs are an OS syscall surface (`forkpty`/ConPTY), which is inherently hard to fully replicate in a WASM sandbox; WASM shows up in this space only on the client-rendering side (xterm.js itself is plain JS/DOM, not WASM).

## 3. Multiplexing strategies used in production

**(a) Server-side tmux/screen, browser attaches** — e.g. many self-hosted "web shell over tmux" setups and some Claude-Code-in-tmux workflows. Survives browser refresh and network drop by design (tmux server persists independent of any attached client); survives a *client* disconnect but not a *host machine* reboot; scrollback is owned by tmux itself (its own ring buffer, separate from xterm.js's); reattach is `tmux attach` again from a new WebSocket. Community guidance in 2026 explicitly recommends raising tmux's default scrollback (commonly cited default ~2,000 lines) to 50,000+ when the pane runs an agent like Claude Code, because agent output "destroys" visible scrollback across tmux, screen, browser terminals, and even VS Code's own terminal once output exceeds one viewport's worth in a burst.

**(b) Custom session manager owning N PTYs** — this is VS Code's model: a dedicated **Pty Host** process (separate Node.js process) owns the shell registry and all PTYs; the renderer/workbench talks to it over IPC, and xterm.js in the renderer is purely a display client. This decouples "heavy terminal output" from UI responsiveness. VS Code additionally has explicit **process reconnection** (restores terminal content on window reload) and **process revive** (restores terminal content and *relaunches* the process across a full VS Code restart) settings — i.e., the PTY's lifetime is explicitly decoupled from any one client connection.

**(c) One PTY per pane, client-side layout** — this is sshx's and Zellij's browser-facing model: the terminal *content* comes from a single real PTY/session per pane, but pane geometry, splits, and cursor overlays are a client-side (or relay-side) concern layered on top, not something the PTY itself knows about.

**(d) Container/exec-based (Kubernetes-style)** — `kubectl exec`-style terminals (Codespaces, cloud IDEs) attach into a running container's process via the container runtime's exec API rather than owning a raw host PTY directly; GitHub Codespaces explicitly supports disconnect/reconnect to an active codespace without affecting its running processes, but documents that **visible terminal contents are not preserved across a full codespace stop/restart, even though terminal history/state on disk is**.

Across all four: the PTY (or tmux/container-exec session) is the source of truth for "does the process survive"; scrollback ownership is either the PTY-adjacent server process (VS Code pty host, tmux) or the terminal library buffer client-side (xterm.js's own ring, capped ~50MB) — mixing the two (server keeps replay log + client also buffers) is how most tools implement reconnect-with-replay.

## 4. Named products

| Product | Known for | Maintenance (Aug 2026) |
|---|---|---|
| VS Code / code-server | Reference architecture: dedicated Pty Host process, xterm.js + WebGL renderer, process-reconnect/-revive settings | Active (Microsoft) |
| ttyd | Single C binary using libwebsockets, share one terminal/program over HTTP; historically the fastest/lightest option | Stalled — no new release since March 2024, only sporadic 2025 commits |
| Gotty (now community-maintained as `sorenisanerd/gotty`) | Original inspiration for ttyd; Go binary, TLS + basic auth | Original `yudai/gotty` inactive; `sorenisanerd` fork carries it forward |
| Wetty | Node.js, proxies to an existing SSH server rather than spawning local PTYs directly | Maintained, smaller-scale |
| Butterfly | Python/Tornado/websocket, xterm-compatible, X509 auth, multi-session | **Unmaintained** — last commit ~Sept 2018; several community forks exist |
| Jupyter terminado | Tornado-websocket backend specifically pairing with xterm.js for JupyterLab's terminal | Actively maintained under the Jupyter org |
| Coder / code-server | Cloud/self-hosted VS Code-in-browser; inherits VS Code's Pty Host architecture | Actively maintained (Coder Technologies) |
| Gitpod | Browser terminal backed by a "supervisor" process inside the workspace; new browser tab against the same URL opens a new terminal process in the same workspace | Actively maintained |
| GitHub Codespaces | Container/exec-based; disconnect/reconnect to a live codespace without killing processes; terminal *history* persists but visible *contents* don't survive a full codespace restart | Active (GitHub/Microsoft) |
| Warp | Desktop-native Rust terminal with "blocks"/command-grouping and built-in team collaboration features; no evidence found of a genuine browser-hosted surface — collaboration is between Warp desktop clients, not via a web page | Active, but not a "web terminal" in this survey's sense |
| Zellij | Rust terminal multiplexer with a **built-in web server** feature: serves live sessions over HTTPS at bookmarkable URLs (e.g. `http://host:8082/my-project`), supports read-only access tokens for observers, and `zellij attach https://host:8082/session` works from a remote terminal without SSH tunnels | Active |
| sshx | Rust relay + React/WebGL/xterm.js client; end-to-end encrypted (Argon2 + AES), multiplayer cursors, chat, "predictive echo" (Mosh-inspired) for perceived latency, stateless relay nodes that never hold session keys | Active |
| tterm | 2025/2026-era entrant folding AI workflows, git review, and browsing into one terminal product | New, mentioned in current listings |

## 5. Collaborative / shared terminals

- **sshx**: multiplayer by design — a shared URL gives every viewer live cursors, the ability to type, scroll, and open additional panes ("multiplayer VS Code or Google Docs, but a terminal"); "predictive echo" (à la Mosh) speculatively renders local keystrokes before server round-trip to hide latency; relay servers are stateless/encrypted so they can't read session content.
- **Zellij web server**: explicit **read-only access tokens** distinct from read/write tokens — an observer connecting with a read-only token cannot inject input, addressing the concurrent-input problem by access-control rather than merge logic.
- **tmate**: every session exposes *two* connection strings (read-write and a `ro-`-prefixed read-only one) over both SSH and HTTP; read-only viewers structurally cannot run commands, only watch and copy text.
- **VS Code Live Share**: host explicitly chooses read-only vs. read/write per shared terminal; only the host can *start* a shared terminal (guests can't spin up their own); an overall session can be forced read-only, which then restricts all terminals in it to read-only regardless of per-terminal settings.
- **Concurrent input / cursor conflict, generally**: none of the surveyed tools resolve concurrent typing with an OT/CRDT-style merge over terminal *content* — a raw PTY has no concept of "two cursors editing the same buffer." Instead every tool observed here sidesteps the conflict at the access-control layer (read-only tokens/permissions) rather than the data layer; the "collaboration" is genuinely last-writer-wins at the PTY's stdin, with UI-level cursor/selection overlays (sshx) layered on top purely for visual awareness, not merge semantics.

## 6. The hard parts, concretely

- **Flow control / backpressure**: a PTY producing output faster than the browser can render (e.g. `yes`, a build log, or an LLM agent streaming) will grow the server's WebSocket send buffer and/or xterm.js's client-side write buffer without bound unless throttled. The documented xterm.js-community pattern: track bytes pending in the client write buffer, send an explicit "pause" signal upstream (to stop PTY reads) at a high-water mark (~128KB cited), and "resume" at a low-water mark (~16KB cited). xterm.js's own official flow-control guide formalizes this ack-based scheme.
- **Resize/SIGWINCH races**: a resize event needs to reach the PTY (`ioctl(TIOCSWINSZ)` / ConPTY resize call) roughly in the order the client generated it; rapid resize storms (dragging a pane border) need debouncing before hitting the PTY layer, otherwise the shell/app can receive a burst of stale intermediate sizes.
- **Scrollback memory**: xterm.js caps its internal buffer near 50MB regardless of the configured scrollback line count — silently discarding older data past that; server-side session managers that *also* want durable scrollback (for reconnect-with-replay) must maintain their own separate ring buffer/log, independent of whatever the client happens to be holding.
- **Binary-safe framing over WebSocket**: terminal I/O is raw bytes (can contain any byte value, including control sequences that alias with framing bytes), so control/metadata messages (resize, pause/resume, session events) must be distinguished from raw PTY bytes without corrupting either — the documented convention is a leading sentinel/prefix byte (e.g., `0x00`) marking a message as control vs. data before it's handed to xterm.js.
- **Reconnect-with-replay**: requires a server-side buffer of "what happened since the client's last-acked byte/sequence" independent of the PTY's own scrollback, since a PTY has no built-in resend capability — VS Code's process-reconnect/-revive settings and tmux/Zellij's persistent-session model are two different concrete answers to "what replays on reattach."
- **Mobile/touch**: not covered in depth by primary sources found in this pass beyond general notes that on-screen keyboards, missing modifier keys (Ctrl/Esc/Tab), and touch-based text selection are recurring complaints against browser terminals; no authoritative 2025/2026 source with a definitive mobile UX pattern surfaced.
- **What breaks first at scale**: per the sources here, the first practical failure mode is unbounded buffer growth from a fast producer with no flow control (the documented reason xterm.js publishes an official flow-control guide), followed by native-module build failures in constrained runtime images (Alpine/musl) blocking deployment entirely rather than degrading gracefully.

## 7. Security

- **Standard exposure model, as documented across these tools**: authenticate before a WebSocket ever reaches a PTY (ttyd/Gotty: basic auth + TLS; tmate/sshx: unguessable per-session token/URL generated by a relay the session owns, not a shared static credential); treat "gives shell access" as equivalent in risk to SSH exposure, not a lesser website feature. VS Code Live Share additionally gates at a *session* level (read-only session mode overriding any individual terminal's read/write flag) and restricts *who can even start* a shared terminal (host-only), narrowing the blast radius of a compromised guest.
- **Why this is high-risk**: a web terminal is, functionally, remote code execution as a *feature* — any auth bypass or missing-auth misconfiguration is immediately a full RCE, not an information leak.
- **Documented incident**: ttyd shipped a real, historical vulnerability (NCC Group/Fox-IT technical advisory) allowing a remote, unauthenticated attacker to execute arbitrary shell commands by exploiting the WebSocket callback handling (`callback_tty`/`LWS_CALLBACK_RECEIVE`) to bypass ttyd's authentication checks entirely — reported and patched same-day, March 10, 2017. This is the concrete, named precedent for "an auth bypass in the WebSocket handshake/handler of a web-terminal tool is a full shell-access RCE," and is exactly the class of bug this class of product must guard against (origin checks, auth-before-PTY-attach, no trust in client-supplied session identifiers).
- **Origin/sandboxing notes**: none of the primary sources in this pass gave a single canonical "reference security checklist" document for this exact stack; the pattern that recurs across sshx (E2E encryption, stateless relays that never hold keys), tmate (per-session SSH token minted by a relay), and Zellij (distinct read/read-write tokens) is: per-session unguessable tokens issued by the trusted server component, never a static shared secret, combined with TLS/WSS and, where the tool supports it, a hard read-only mode as a distinct, separately-authenticated capability rather than a UI toggle.

---

### Sources
- [xtermjs/xterm.js (GitHub)](https://github.com/xtermjs/xterm.js)
- [xterm.js Releases](https://github.com/xtermjs/xterm.js/releases)
- [xterm.js addon-webgl README](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md)
- [xterm.js flow control guide](https://xtermjs.org/docs/guides/flowcontrol/)
- [Make DOM renderer default / move canvas to addon, issue #3271](https://github.com/xtermjs/xterm.js/issues/3271)
- [cockpit-project: addon-canvas deprecated, removed in v6, issue #22509](https://github.com/cockpit-project/cockpit/issues/22509)
- [microsoft/node-pty (GitHub)](https://github.com/microsoft/node-pty)
- [node-pty Releases](https://github.com/microsoft/node-pty/releases)
- [node-pty musl/Alpine prebuilt binaries, issue #852](https://github.com/microsoft/node-pty/issues/852)
- [homebridge/node-pty-prebuilt-multiarch](https://github.com/homebridge/node-pty-prebuilt-multiarch)
- [portable-pty (docs.rs)](https://docs.rs/portable-pty)
- [replit/ruspty](https://github.com/replit/ruspty)
- [ekzhang/sshx (GitHub)](https://github.com/ekzhang/sshx)
- [sshx.io](https://sshx.io/)
- [sshx architecture write-up](https://www.blog.brightcoding.dev/2025/09/13/sshx-a-secure-web-based-collaborative-terminal-for-effortless-session-sharing)
- [ttyd (GitHub)](https://github.com/tsl0922/ttyd)
- [ttyd remote shell command execution advisory — NCC Group](https://www.nccgroup.com/research/technical-advisory-remote-shell-commands-execution-in-ttyd/)
- [ttyd remote shell command execution advisory — Fox-IT](https://www.fox-it.com/nl-en/technical-advisory-remote-shell-commands-execution-in-ttyd/)
- [sorenisanerd/gotty (GitHub)](https://github.com/sorenisanerd/gotty)
- [paradoxxxzero/butterfly (GitHub)](https://github.com/paradoxxxzero/butterfly)
- [jupyter/terminado (GitHub)](https://github.com/jupyter/terminado)
- [terminado websocket docs](https://github.com/jupyter/terminado/blob/main/doc/websocket.rst)
- [Zellij Web Server — DeepWiki](https://deepwiki.com/zellij-org/zellij/5.3-web-server)
- [VS Code Terminal: PTY Host — DeepWiki](https://deepwiki.com/microsoft/vscode/9.4-pty-host-and-multi-server-support)
- [VS Code Terminal Advanced docs](https://code.visualstudio.com/docs/terminal/advanced)
- [Live Share: share a server or terminal — Microsoft Learn](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-server-visual-studio-code)
- [Gitpod Browser Terminal docs](https://www.gitpod.io/docs/references/ides-and-editors/browser-terminal)
- [gitpod-io/gitpod (GitHub)](https://github.com/gitpod-io/gitpod)
- [GitHub Codespaces lifecycle docs](https://docs.github.com/en/enterprise-cloud@latest/codespaces/about-codespaces/understanding-the-codespace-lifecycle)
- [tmate read-only sharing — LinuxHandbook](https://linuxhandbook.com/tmate/)
- [tmate — opensource.com](https://opensource.com/article/22/6/share-linux-terminal-tmate)
- [ttyd alternatives listing (sshx, gotty, upterm, tty-share)](https://alternativeto.net/software/ttyd)
