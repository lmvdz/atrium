import type { Id, Timestamp } from './common.js';

/**
 * Adapter seams (init.md, "Keep adapter seams without building integrations").
 * These are type-only ports: no implementation and no I/O lives in this
 * package. v1 ships `NativeConversationSource` and `HumanExecutionProvider` in
 * apps/server; Slack/QM/Coven adapters can arrive later without the domain
 * model moving. Adapters translate external systems into Atrium's model — they
 * never define it.
 */

export interface SourceEvent {
  externalId: string;
  roomId: Id;
  authorExternalId: string;
  body: string;
  createdAt: Timestamp;
  raw?: unknown;
}

export interface ConversationSource {
  ingest(input: { workspaceId: Id; cursor?: string }): Promise<{
    events: SourceEvent[];
    nextCursor?: string;
  }>;
}

export interface ExecutionRequest {
  objectId: Id;
  instruction: string;
}

export interface ExecutionHandle {
  id: string;
  provider: string;
}

export interface ExecutionEventPage {
  events: Array<{ at: Timestamp; kind: string; text: string }>;
  nextCursor?: string;
}

export interface ExecutionProvider {
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  readEvents(handle: ExecutionHandle, cursor?: string): Promise<ExecutionEventPage>;
  sendInput(handle: ExecutionHandle, message: string): Promise<void>;
  cancel(handle: ExecutionHandle): Promise<void>;
}
