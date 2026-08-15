import { WebSocket } from 'ws';
import {
  type AckFrame,
  type CatchupFrame,
  type CommandFrame,
  type LoopCommand,
  type NackFrame,
  parseServerFrame,
  type ServerFrame,
  type SubscribedFrame,
  type WireEvent,
} from './protocol.js';

/**
 * The daemon's only mouth and ears: a WebSocket to the same authenticated
 * command path the web app uses (#139, #148). It authenticates by presenting the
 * seed's agent session cookie (#142) as the `Cookie` upgrade header — exactly
 * what a browser does automatically and what the server's `authenticateUpgrade`
 * reads back through Better Auth. There is no other channel: no DB handle, no
 * server import, no HTTP side-door.
 *
 * What this class guarantees to its caller:
 *  - room events are delivered to the handler ONE AT A TIME, in strictly
 *    increasing, contiguous `roomSeq` order (the daemon's cursor is a `roomSeq`,
 *    and a conductor that saw seq 7 before seq 6 would journal nonsense);
 *  - a refused row (`issues` non-empty) is dropped before delivery — "a refused
 *    row is not an event that happened";
 *  - a command's ack/nack is matched to its `commandId` and returned, even while
 *    the event handler is mid-flight (acks are routed synchronously, so the
 *    handler may `await` a command without deadlocking against its own stream).
 */

export interface LoopClientOptions {
  url: string;
  /** The full `name=value` cookie line the seed wrote (#142). Presented as the
   *  `Cookie` upgrade header — the daemon treats it as an opaque credential. */
  cookie: string;
  /** Structured log sink. Defaults to the console (info/warn/error only). */
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: unknown) => void;
}

export type EventHandler = (event: WireEvent) => Promise<void> | void;

interface PendingCommand {
  resolve: (frame: AckFrame | NackFrame) => void;
  reject: (error: Error) => void;
}

export class LoopClient {
  private socket: WebSocket | undefined;
  private readonly url: string;
  private readonly cookie: string;
  private readonly log: NonNullable<LoopClientOptions['log']>;

  private ownUserId = '';
  private closed = false;

  private nextCommandId = 0;
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly welcomeWaiters: Array<() => void> = [];
  private readonly subscribeWaiters = new Map<string, (f: SubscribedFrame) => void>();
  private readonly catchupWaiters: Array<{
    roomId: string;
    from: number;
    resolve: (f: CatchupFrame) => void;
  }> = [];

  // ── ordered event delivery ────────────────────────────────────────────────
  private handler: EventHandler | undefined;
  private deliveredThrough = 0;
  private readonly pending = new Map<number, WireEvent>();
  private pumping = false;
  private catchingUp = false;

  constructor(options: LoopClientOptions) {
    this.url = options.url;
    this.cookie = options.cookie;
    this.log =
      options.log ??
      ((level, message, fields) => {
        console[level](message, fields ?? '');
      });
  }

  get userId(): string {
    return this.ownUserId;
  }

  connect(): Promise<void> {
    const socket = new WebSocket(this.url, { headers: { cookie: this.cookie } });
    this.socket = socket;
    socket.on('message', (raw: Buffer) => this.onFrame(raw.toString()));
    socket.on('error', (error: Error) => this.log('warn', 'ws socket error', error.message));
    return new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        this.welcomeWaiters.push(resolve);
      });
      socket.once('error', reject);
      socket.once('close', () => {
        if (!this.closed) this.failAll(new Error('socket closed'));
      });
    });
  }

  private onFrame(raw: string): void {
    let frame: ServerFrame | { type: 'unknown' };
    try {
      frame = parseServerFrame(raw);
    } catch (error) {
      this.log('warn', 'dropping unreadable frame', (error as Error).message);
      return;
    }
    switch (frame.type) {
      case 'welcome': {
        this.ownUserId = frame.userId;
        for (const w of this.welcomeWaiters.splice(0)) w();
        return;
      }
      case 'subscribed': {
        const waiter = this.subscribeWaiters.get(frame.roomId);
        if (waiter) {
          this.subscribeWaiters.delete(frame.roomId);
          waiter(frame);
        }
        return;
      }
      case 'ack':
      case 'nack': {
        const pending = this.pendingCommands.get(frame.commandId);
        if (pending) {
          this.pendingCommands.delete(frame.commandId);
          pending.resolve(frame);
        }
        return;
      }
      case 'catchup': {
        const index = this.catchupWaiters.findIndex(
          (w) => w.roomId === frame.roomId && w.from === frame.from,
        );
        if (index >= 0) {
          const [waiter] = this.catchupWaiters.splice(index, 1);
          waiter?.resolve(frame);
        }
        for (const entry of frame.entries) this.enqueue(entry);
        return;
      }
      case 'event': {
        this.enqueue(frame.entry);
        return;
      }
      case 'head': {
        this.onHead(frame.roomId, frame.head);
        return;
      }
      default:
        return; // pong/presence/typing/seen/projection_changed/error/unknown
    }
  }

  /**
   * The reconciler's "this room is at `head`" — the recovery signal for an event
   * frame that never arrived, and the way out-of-band appends (another writer,
   * the execution coordinator's own settle) reach a subscriber. Acknowledge what
   * we contiguously hold so the server stops repeating it, and `since` the gap.
   */
  private onHead(roomId: string, head: number): void {
    try {
      this.send({ type: 'ack_head', roomId, roomSeq: this.deliveredThrough });
    } catch {
      return; // socket closing
    }
    if (head > this.deliveredThrough && !this.catchingUp) {
      this.catchingUp = true;
      void this.backfill(roomId, this.deliveredThrough).finally(() => {
        this.catchingUp = false;
      });
    }
  }

  /** Register the single serialized room-event handler and where to resume. */
  setEventHandler(handler: EventHandler, resumeAfterRoomSeq: number): void {
    this.handler = handler;
    this.deliveredThrough = resumeAfterRoomSeq;
  }

  private enqueue(entry: WireEvent): void {
    // A refused row never happened — drop it before it can reach the conductor
    // or move a cursor (protocol.ts / ws-server.ts).
    if (entry.issues.length > 0) return;
    if (entry.roomSeq <= this.deliveredThrough) return;
    if (this.pending.has(entry.roomSeq)) return;
    this.pending.set(entry.roomSeq, entry);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.handler) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.pending.get(this.deliveredThrough + 1);
        if (!next) break;
        this.pending.delete(next.roomSeq);
        await this.handler(next);
        this.deliveredThrough = next.roomSeq;
      }
    } finally {
      this.pumping = false;
    }
  }

  async subscribe(roomId: string): Promise<SubscribedFrame> {
    const frame = await new Promise<SubscribedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.subscribeWaiters.delete(roomId);
        reject(new Error(`timed out subscribing to ${roomId}`));
      }, 15_000);
      this.subscribeWaiters.set(roomId, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      this.send({ type: 'subscribe', roomId });
    });
    return frame;
  }

  since(roomId: string, roomSeq: number, limit?: number): Promise<CatchupFrame> {
    return new Promise<CatchupFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.catchupWaiters.findIndex((w) => w.roomId === roomId && w.from === roomSeq);
        if (i >= 0) this.catchupWaiters.splice(i, 1);
        reject(new Error(`timed out on since(${roomId}, ${roomSeq})`));
      }, 15_000);
      this.catchupWaiters.push({
        roomId,
        from: roomSeq,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
      this.send(
        limit === undefined
          ? { type: 'since', roomId, roomSeq }
          : { type: 'since', roomId, roomSeq, limit },
      );
    });
  }

  /**
   * Backfill everything the room already holds past `fromRoomSeq`, then let live
   * frames carry the rest. `since` is looped while the server says it truncated
   * (`more`), so a long backlog is drained in order rather than in one frame.
   */
  async backfill(roomId: string, fromRoomSeq: number): Promise<void> {
    let from = fromRoomSeq;
    for (;;) {
      const catchup = await this.since(roomId, from);
      if (!catchup.more) break;
      from = catchup.to;
    }
  }

  command(command: LoopCommand): Promise<AckFrame | NackFrame> {
    this.nextCommandId += 1;
    const commandId = `loop-${this.nextCommandId}`;
    const frame: CommandFrame = { type: 'command', commandId, command };
    return new Promise<AckFrame | NackFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error(`timed out on command ${command.name} (${commandId})`));
      }, 20_000);
      this.pendingCommands.set(commandId, {
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject,
      });
      this.send(frame);
    });
  }

  private send(frame: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('cannot send on a socket that is not open');
    }
    socket.send(JSON.stringify(frame));
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pendingCommands) pending.reject(error);
    this.pendingCommands.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    if (!socket) return;
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
  }
}
