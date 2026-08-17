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
 *      reads, not writes, so the app owns the append endpoint
 *      (electric-sql/electric `examples/yjs/server`).
 *
 * None of that exists in-sandbox, so convergence is PROVEN against the in-memory
 * hub instead (test/yjs-conversation.test.ts), per the ticket's infra guardrail:
 * a working seam + a named infra gap beats a stalled lane. Wiring this transport
 * is a follow-up spike — stand up items 1–3, then hand the config below to
 * `useConversationModel(selection, electricConversationTransport(config))`.
 *
 * IMPORTANT — the durable stream carries CONVERSATION CONTENT ONLY. The covenant
 * ledger stays the gated Postgres store, synced read-only (#181); a `✓` is never
 * a value in this Yjs doc and never travels on this wire.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { Row } from '@electric-sql/client';
import { ElectricProvider, parseToDecoder, type ResumeState } from '@electric-sql/y-electric';
import { encodeStateVector, Doc as YDoc } from 'yjs';
import type { ConversationTransport } from './conversation-transport';

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
  /** The app's write endpoint that appends an `op` bytea row for this room. */
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
        },
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
