import type {
  DeliveryOutcome,
  ExecutionProvider,
  ExecutionReport,
  SessionContext,
  SignalDelivery,
  Workspace,
} from './provider.js';

/**
 * The sandbox seam (#120) — DEFINED here, not required green.
 *
 * Delta explicitly punted a real sandbox ("unrestricted device access"), and a
 * real one is Atrium's differentiation: a per-session workspace that is a REAL
 * isolated machine (E2B / Daytona / ComputeSDK), not a worktree on the server's
 * own disk. That belongs behind a flag and behind a BUY decision, so what ships
 * here is the seam it will plug into and a stub that refuses to pretend.
 *
 * The shape is deliberately the SAME `ExecutionProvider` the shim and worktree
 * adapter satisfy — resolve an isolated workspace, run the harness, report
 * terminal + receipt. What a real client swaps in is `SandboxClient`: the two
 * calls a hosted sandbox actually offers (spin up an isolated workspace on a git
 * remote; exec a command in it and read its terminal). Wire E2B/Daytona/
 * ComputeSDK by implementing those two methods; nothing else in the system
 * changes, because the coordinator only knows the `ExecutionProvider` seam.
 *
 * Until a client is configured, `createSandboxProvider` returns a provider whose
 * every call throws `SandboxNotConfiguredError`. That is the honest state: the
 * flag can select `sandbox`, but selecting it without a client is a loud boot
 * failure (see `configure.ts` / `env.ts`), never a silent fall-through to the
 * server's own disk.
 */

/** Thrown when the sandbox provider is used without a real client wired in. */
export class SandboxNotConfiguredError extends Error {
  constructor() {
    super(
      'the sandbox execution provider has no client — BUY and wire an E2B/Daytona/ComputeSDK ' +
        'client (SandboxClient) before selecting EXECUTION_PROVIDER=sandbox; the shim is the tested default',
    );
    this.name = 'SandboxNotConfiguredError';
  }
}

/** A resolved sandbox workspace — a real isolated machine, not a local dir. */
export interface SandboxHandle {
  /** Opaque id of the running sandbox — the provider's `dir` is informational. */
  readonly id: string;
  /** The branch the sandbox commits its work onto in the git remote. */
  readonly branch: string;
  /** The git remote the sandbox pushes the artifact branch to. */
  readonly remote: string;
  /** Working path inside the sandbox (for logs; not a host path). */
  readonly workdir: string;
  /** Tear the sandbox down. */
  destroy(): Promise<void>;
}

/**
 * The two calls a hosted sandbox actually offers. Implement this over E2B,
 * Daytona or ComputeSDK; the provider below adapts it to the Atrium seam.
 */
export interface SandboxClient {
  readonly name: string;
  /** Spin up an isolated workspace for a session, on a git remote it controls. */
  createWorkspace(ctx: SessionContext): Promise<SandboxHandle>;
  /** Run the harness in the sandbox and report terminal + the pushed artifact. */
  runHarness(handle: SandboxHandle, ctx: SessionContext): Promise<ExecutionReport>;
  /**
   * Deliver an already-authorized signal into the running sandbox (#147):
   * `steer` queued to the harness's next turn boundary, `interrupt` terminating
   * the remote run. Optional — a client that predates delivery simply cannot
   * reach a running signal, and the provider reports `not-running` for it rather
   * than pretending. #138 (the real sandbox) implements it.
   */
  deliver?(handle: SandboxHandle, delivery: SignalDelivery): Promise<DeliveryOutcome>;
}

export interface SandboxProviderOptions {
  /** The real sandbox client. Absent, every call throws — the flag is inert. */
  client?: SandboxClient;
}

interface SandboxWorkspace extends Workspace {
  readonly handle: SandboxHandle;
}

/**
 * Build the sandbox provider. With no client it is the refusing stub; with one
 * it delegates resolve/run to the client, adapting `SandboxHandle` to the
 * `Workspace`/`ExecutionReport` seam the coordinator consumes.
 */
export function createSandboxProvider(options: SandboxProviderOptions = {}): ExecutionProvider {
  const { client } = options;

  // In-flight sandbox handles, so `cancelAll` can signal a running remote sandbox
  // to stop on shutdown (#120 round-7 F4). A handle is tracked from `resolve`
  // until its workspace is disposed; the unconfigured stub creates none, so its
  // `cancelAll` has nothing to do.
  const handles = new Map<string, SandboxHandle>();

  return {
    kind: 'sandbox',

    async resolve(ctx: SessionContext): Promise<Workspace> {
      if (!client) throw new SandboxNotConfiguredError();
      const handle = await client.createWorkspace(ctx);
      handles.set(ctx.sessionId, handle);
      const workspace: SandboxWorkspace = {
        sessionId: ctx.sessionId,
        dir: handle.workdir,
        branch: handle.branch,
        remote: handle.remote,
        handle,
        dispose: async () => {
          handles.delete(ctx.sessionId);
          await handle.destroy();
        },
      };
      return workspace;
    },

    async run(workspace: Workspace, ctx: SessionContext): Promise<ExecutionReport> {
      if (!client) throw new SandboxNotConfiguredError();
      return client.runHarness((workspace as SandboxWorkspace).handle, ctx);
    },

    async cancelAll(): Promise<void> {
      // Destroy every still-resolved sandbox — the remote-machine equivalent of
      // killing a local child (#120 round-7 F4). Best-effort and never throws: a
      // sandbox that already tore down is the desired end state.
      const live = [...handles.values()];
      handles.clear();
      await Promise.all(live.map((handle) => handle.destroy().catch(() => undefined)));
    },

    // DELIVER a signal into a running sandbox (#147). A resume is the daemon's wake,
    // never a mutation of a run in flight. Otherwise, delegate to the client's
    // optional `deliver`; a session with no live handle — or a client that does not
    // implement delivery — is `not-running`, the safe no-op. Delivery writes
    // nothing durable here either: an interrupt's receipt is the ordinary settle.
    async deliver(delivery: SignalDelivery): Promise<DeliveryOutcome> {
      if (delivery.kind === 'resume') return { kind: 'ignored', reason: 'resume-noop' };
      const handle = handles.get(delivery.sessionId);
      if (!handle || !client?.deliver) return { kind: 'ignored', reason: 'not-running' };
      return client.deliver(handle, delivery);
    },
  };
}
