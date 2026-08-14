/* ---------------------------------------------------------------------------
 * ISSUE ONE ROOM COMMAND — the authenticated command path, from the control plane.
 *
 * The funding and settle acts (#146) are protocol COMMANDS (`set_plan_rlimit`,
 * `settle_plan`), not receipt writes. They must reach the server the same way
 * every other command does — over the authenticated WebSocket the app already
 * opens — because that is the ONE path where the human-only spend gate lives:
 * `commands.ts`'s `certificationClassOf` refuses a non-human `set_plan_rlimit`
 * BEFORE the append (#115/#118). A Server Action that wrote `plans.rlimit_slice`
 * directly would bypass that gate, the `plan_rlimit_set` event, and the append
 * lock's draw accounting — precisely the "a machine raises its own slice" the
 * covenant forbids. So funding does NOT mirror certify's Server Action; it goes
 * through the command socket, and the server's single enforcement path is what
 * makes "a machine can never reach set_plan_rlimit through the new action" true
 * by construction rather than by a second copy of the check here.
 *
 * ## Why a fresh short-lived socket, not the persistent realtime client
 *
 * The control route renders server-side and holds no live realtime client (it
 * reads a projection and revalidates on act). Funding and settling are rare,
 * deliberate operator acts, so this opens one authenticated socket per act,
 * sends the frame, waits for the server's `ack`/`nack` for exactly that
 * `commandId`, and closes — the same shape the e2e `sendCommand` helper uses and
 * the same wire envelope `realtime.ts` sends. The browser attaches the session
 * cookie on the upgrade, so the socket authenticates as the signed-in principal
 * with nothing to forge.
 * ------------------------------------------------------------------------- */

import { loadRuntimeConfig } from '@/src/lib/runtime-config';
import { resolveWsUrl } from '@/src/lib/ws-url';

/** The commands this transport carries — the plan-level acts of #146. */
export type RoomCommand =
  | {
      readonly name: 'set_plan_rlimit';
      readonly roomId: string;
      readonly planId: string;
      readonly slice: number;
    }
  | { readonly name: 'settle_plan'; readonly roomId: string; readonly planId: string };

export type RoomCommandOutcome =
  /** The server appended the command. `issues` is the business-check log — empty on a clean apply. */
  | { readonly ok: true; readonly issues: readonly string[] }
  /**
   * The server refused it, in its own words. `code` is the machine reason
   * (`invalid` for the human-only spend refusal and the open-child settle
   * refusal); `message` is the covenant's sentence, shown verbatim.
   */
  | { readonly ok: false; readonly code: string; readonly message: string }
  /** The socket never opened or never answered — a transport failure, not a refusal. */
  | { readonly ok: false; readonly code: 'unreachable'; readonly message: string };

/** How long to wait for the server's answer before calling the socket dead. */
const COMMAND_TIMEOUT_MS = 8000;

function newCommandId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ctl-${random}`;
}

/**
 * Send one command over a fresh authenticated socket and resolve its outcome.
 *
 * Only the `ack`/`nack` whose `commandId` matches this send resolves the
 * promise; `welcome`, `presence`, and any other room traffic on the socket are
 * ignored, exactly as the app's own client filters them. A socket that never
 * opens, drops before answering, or exceeds the timeout resolves `unreachable`
 * — a transport failure the caller reports as "could not reach the server",
 * distinct from a refusal the server actually made.
 */
export async function issueRoomCommand(command: RoomCommand): Promise<RoomCommandOutcome> {
  let url: string;
  try {
    url = resolveWsUrl(await loadRuntimeConfig());
  } catch {
    return { ok: false, code: 'unreachable', message: 'could not resolve the server address' };
  }

  return new Promise<RoomCommandOutcome>((resolve) => {
    const commandId = newCommandId();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve({ ok: false, code: 'unreachable', message: 'could not reach the server' });
      return;
    }

    let settled = false;
    const finish = (outcome: RoomCommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* closing a socket that never opened throws in some engines; harmless */
      }
      resolve(outcome);
    };

    const timer = setTimeout(
      () => finish({ ok: false, code: 'unreachable', message: 'the server did not answer' }),
      COMMAND_TIMEOUT_MS,
    );

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'command', commandId, command }));
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let frame: {
        type?: unknown;
        commandId?: unknown;
        code?: unknown;
        message?: unknown;
        issues?: unknown;
      };
      try {
        frame = JSON.parse(event.data) as typeof frame;
      } catch {
        return;
      }
      if (frame.commandId !== commandId) return;
      if (frame.type === 'ack') {
        const issues = Array.isArray(frame.issues) ? frame.issues.map(String) : [];
        finish({ ok: true, issues });
      } else if (frame.type === 'nack') {
        finish({
          ok: false,
          code: typeof frame.code === 'string' ? frame.code : 'invalid',
          message:
            typeof frame.message === 'string' && frame.message.length > 0
              ? frame.message
              : 'the server refused the command',
        });
      }
    };
    socket.onerror = () =>
      finish({ ok: false, code: 'unreachable', message: 'the connection failed' });
    socket.onclose = () =>
      finish({ ok: false, code: 'unreachable', message: 'the connection closed' });
  });
}
