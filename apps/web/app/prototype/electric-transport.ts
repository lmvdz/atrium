/* ═══════════════════════════════════════════════════════════════════════════
 * THE ELECTRIC TRANSPORT (#183) — the production implementation of the seam.
 *
 * This is the rented wire: `@electric-sql/y-electric`'s `ElectricProvider` over
 * Electric Durable Streams. It satisfies the SAME `ConversationTransport`
 * contract the in-memory hub does — join a `Y.Doc`, ship its updates to a durable
 * Postgres-backed stream, apply inbound updates back — so the surface code is
 * identical whether it runs against the in-process proof or the real stream.
 *
 * ## Why it is import-guarded (the #183 infra gap, stated plainly)
 *
 * Electric is a READ-PATH sync engine over Postgres LOGICAL REPLICATION. Making
 * this transport live needs infrastructure THIS SANDBOX CANNOT STAND UP:
 *
 *   1. An Electric sync service (the HTTP shape proxy) in front of Postgres, with
 *      `wal_level = logical` enabled on the database.
 *   2. Two durable tables the stream reads (y-electric's documented schema):
 *        CREATE TABLE ydoc_updates   (id uuid PK, room text, op bytea);
 *        CREATE TABLE ydoc_awareness (client_id text, room text, op bytea, ...);
 *   3. A tiny write API (`sendUrl`) that appends `op` bytea rows — Electric syncs
 *      reads, not writes, so the app owns the append endpoint. THAT ENDPOINT NOW
 *      EXISTS: `app/api/rooms/[room]/ydoc/route.ts` (#202), reached via
 *      `resolveElectricSendUrl(room)` — a same-origin PUT so the session cookie
 *      rides and the door can stamp the update to the authenticated writer.
 *
 * None of items 1–2 exist in-sandbox, so convergence is PROVEN against the
 * in-memory hub instead (test/yjs-conversation.test.ts), per the ticket's infra
 * guardrail: a working seam + a named infra gap beats a stalled lane. Wiring this
 * transport into a mounted client is a follow-up spike (E4) — stand up items 1–2,
 * build `config.shapeUrl`/`config.sendUrl` from `resolveElectricShapeUrl` /
 * `resolveElectricSendUrl(room)`, then hand the config below to
 * `useConversationModel(selection, electricConversationTransport(config))`.
 *
 * ## THE WRITE PATH'S TRUST, THREADED HERE (#202)
 *
 * `sendUrl` points at the authenticated door, and two things make the door able
 * to attribute the write:
 *
 *   * the PUT is SAME-ORIGIN (`resolveElectricSendUrl` refuses any other), so the
 *     session cookie rides — and `sendFetch` below sets `credentials:
 *     'same-origin'` explicitly rather than leaning on a fetch default that a
 *     future runtime could change;
 *   * the writer identity is derived at the DOOR from that session, never from
 *     this client. Nothing here names an author, and the door would ignore it if
 *     it did — the Yjs update's own `clientID` in the bytes is not the writer.
 *
 * Rate limiting is the door's job (in-process, per writer and per IP, reusing the
 * proxy-hops plumbing) — a client cannot rate-limit itself honestly. What this
 * client does is BACK OFF correctly: `documentRetryHandler` retries a transient
 * refusal (429, 5xx, a dropped connection) and GIVES UP on a permanent one
 * (401/403/400/413), so a member whose access was revoked mid-session stops
 * hammering a door that will only ever refuse them.
 *
 * IMPORTANT — the durable stream carries CONVERSATION CONTENT ONLY. The covenant
 * ledger stays the gated Postgres store, synced read-only (#181); a `✓` is never
 * a value in this Yjs doc and never travels on this wire.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { Row } from '@electric-sql/client';
import {
  ElectricProvider,
  parseToDecoder,
  type ResumeState,
  type SendErrorRetryHandler,
} from '@electric-sql/y-electric';
import { encodeStateVector, Doc as YDoc } from 'yjs';
import type { ConversationTransport } from './conversation-transport';

/**
 * Send the update with the session cookie attached (#202).
 *
 * y-electric's own `send()` does not set `credentials`; a same-origin PUT sends
 * cookies by default today, but the write door's whole authorization rests on the
 * cookie arriving, so it is stated rather than assumed — a future default of
 * `omit` would silently turn every write into an unauthenticated 401.
 */
const sendFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: 'same-origin' });

/**
 * Retry a TRANSIENT refusal, give up on a PERMANENT one (#202).
 *
 * 429 (rate limited) and 5xx (server hiccup) and a network error (no response)
 * are transient — retry. 401/403/400/413 are the door's final word: not signed
 * in, not a member, malformed, too large. Retrying those pins the append path for
 * a client that will only ever be refused; a revoked member should stop, not
 * spin. Returning `false` lets the provider disconnect rather than loop.
 */
const documentRetryHandler: SendErrorRetryHandler = async ({ response }) => {
  if (!response) return true; // network error — transient
  if (response.status === 429) return true; // rate limited — back off and retry
  if (response.status >= 500) return true; // server hiccup — transient
  return false; // 4xx (401/403/400/413) — the door's final word
};

/**
 * The state vector of an EMPTY doc — "the stream has nothing of mine yet". Handed
 * to the provider as the resume baseline when the caller gives none, so
 * `Y.encodeStateAsUpdate(doc, thisVector)` is the doc's WHOLE current state and
 * the provider uploads it on connect (#183 F5). Without it the provider seeds no
 * `pendingChanges` and only ever ships updates made AFTER construction, so a
 * client that edited offline/pre-connect never gets those edits onto the stream.
 * Computed once — an empty vector is a constant.
 */
const EMPTY_STATE_VECTOR: Uint8Array = encodeStateVector(new YDoc());

/**
 * The decoder type `parseToDecoder` yields for a `bytea` column — derived from
 * the helper itself so we never hand-import lib0's internal type. A document-
 * update row is a durable `ydoc_updates` row whose `op` column carries the Yjs
 * update as that decoder.
 */
type UpdateDecoder = ReturnType<typeof parseToDecoder.bytea>;
type DocUpdateRow = Row<UpdateDecoder> & { readonly op: UpdateDecoder };

/**
 * What the Electric transport needs to reach a room's durable stream. Every
 * field is infrastructure the follow-up spike provisions (see the file header);
 * nothing here is derivable in-sandbox, which is why the transport is a factory
 * over a config rather than a module-load side effect.
 */
export interface ElectricTransportConfig {
  /** The room whose conversation stream this doc joins (the `room` column). */
  readonly room: string;
  /** The Electric HTTP shape-proxy URL for reading `ydoc_updates`. */
  readonly shapeUrl: string;
  /**
   * The app's write door for this room (#202) — `resolveElectricSendUrl(room)`,
   * a same-origin `/api/rooms/{room}/ydoc`. The transport PUTs each update here
   * with the session cookie; the door authenticates, authorizes membership, and
   * stamps the update to the authenticated writer.
   */
  readonly sendUrl: string;
  /** Optional resume state, so a reconnect does not retransmit the whole doc. */
  readonly resumeState?: ResumeState;
}

/**
 * The production `ConversationTransport`, backed by Electric Durable Streams.
 * Constructing it does nothing; `connect(doc)` opens the provider and returns a
 * disposer that tears it down. Only ever call this with real infrastructure in
 * `config` — see the file header for what that infrastructure is.
 */
export function electricConversationTransport(
  config: ElectricTransportConfig,
): ConversationTransport {
  return {
    connect(doc: YDoc): () => void {
      const provider = new ElectricProvider<DocUpdateRow>({
        doc,
        documentUpdates: {
          shape: {
            url: config.shapeUrl,
            params: {
              table: 'ydoc_updates',
              // One room's stream — the durable filter Electric pushes down. The
              // room is a POSITIONAL parameter (`$1`), never interpolated into the
              // SQL string (#183 secondary): Electric binds it server-side, so a
              // room slug carrying a quote or `OR 1=1` can never break out of the
              // predicate. `where` + `params` is the parameterised form the client
              // documents (index.d.ts: `where: "id = $1", params: { "1": … }`).
              where: 'room = $1',
              params: { '1': config.room },
            },
            parser: parseToDecoder,
          },
          sendUrl: config.sendUrl,
          // y-electric's documented column: the update bytea lives in `op`.
          getUpdateFromRow: (row) => row.op,
          // Back off on a transient refusal, give up on a permanent one (#202).
          sendErrorRetryHandler: documentRetryHandler,
        },
        // Carry the session cookie on every write, so the door can attribute it.
        fetchClient: sendFetch,
        // Upload the doc's pre-connect state by default (#183 F5): a caller-supplied
        // resumeState wins (a real reconnect resumes from its own baseline), but
        // when none is given we baseline against an EMPTY vector so the provider
        // seeds `pendingChanges` with the doc's whole current state and ships it.
        resumeState: config.resumeState ?? { stableStateVector: EMPTY_STATE_VECTOR },
      });
      return () => provider.destroy();
    },
  };
}
