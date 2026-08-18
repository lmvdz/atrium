'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CLIENT-SIDE COVENANT RESOLVER (E-slice / #212) — the glyph authority for
 * the drivable demo, and NOTHING it does not have to be.
 *
 * This module is deliberately THIN. It owns no digest logic, no rendering, no
 * OK/DRIFT rule: those live in `@atrium/core` ({@link resolveCovenant} /
 * {@link certifyAnchor}) and in the production reader
 * ({@link CovenantDocReaderProd}). This file only WIRES them to the demo's client
 * `ConversationDoc` + a client-side anchor store, so the two-pane demo can:
 *
 *   - CERTIFY a span → capture a REAL {@link CovenantAnchor} (a real objectId + the
 *     signed content digest) via `certifyAnchor`, keyed by objectId, into a local
 *     store. This is a LOCAL DEMO ANCHOR, not a ledger act (the gated
 *     `certifyObjectSpanAction` / `certify-anchor.ts` write is reserved for Lars) —
 *     the UI + RUNBOOK say so.
 *   - RESOLVE each anchored span on every `doc.onChange` → `resolveCovenant` over
 *     the live doc, answering ✓ (`ok`) or ~ (`drift`), fail-closed. A content
 *     match is ✓; ANY drift, and ANY unverifiable state, is ~ — never a false ✓.
 *
 * ## Machine never certifies (rubric 2)
 * The ONLY certifier this module will mint is `{ kind: 'human' }`; `certifyAnchor`
 * refuses anything else at the core type. There is no code path — here or in the
 * demo — by which the agent-peer pane produces a ✓. It only edits the shared doc,
 * and every edit is re-resolved through the same fail-closed path.
 * ═════════════════════════════════════════════════════════════════════════ */

import {
  type CovenantAnchor,
  certifyAnchor,
  type CovenantStatus,
  type HumanCertifier,
  resolveCovenant,
} from '@atrium/core';
import { CovenantDocReaderProd } from '@/lib/covenant-reader';
import { conversationContentRoot, type ConversationDoc } from '../yjs-conversation';

/** The glyph a resolution renders as: a human `✓` or the machine-draft `~`. */
export const GLYPH_CERTIFIED = '✓';
export const GLYPH_DRIFT = '~';

/** A local demo anchor bundle: the core anchor PLUS the span coordinates the demo
 *  drives peer edits against (the anchor's own positions are opaque). Keyed by
 *  objectId in {@link ClientAnchorStore}. */
export interface DemoAnchor {
  readonly anchor: CovenantAnchor;
  /** The message whose body this `✓` is over. */
  readonly messageId: string;
  /** The certified half-open span `[start, end)` in the body's Yjs index space. */
  readonly start: number;
  readonly end: number;
}

/** The client anchor store — objectId → the local demo anchor. Held in React
 *  state at the demo page; there is no server, no ledger, and NO path by which a
 *  peer edit can add to it (only the human certify gesture writes here). */
export type ClientAnchorStore = ReadonlyMap<string, DemoAnchor>;

/** The span a certify gesture resolved to, plus the object it is over. */
export interface CertifyClientInput {
  readonly objectId: string;
  readonly roomId: string;
  /** The acting human's id — the ONLY kind of certifier this demo mints. */
  readonly userId: string;
  readonly messageId: string;
  /** `[blockIndex, childIndex]` from `ConversationDoc.bodyPath` — never hand-built. */
  readonly bodyPath: number[];
  readonly start: number;
  readonly end: number;
}

/**
 * Capture a REAL covenant anchor for a freshly-certified span, using the SAME
 * derive-and-sign primitive the production path uses ({@link certifyAnchor}) over
 * the SAME production reader ({@link CovenantDocReaderProd}), pointed at the demo
 * doc's conversation content share. Returns `null` when the span cannot be
 * faithfully captured (the reader fails closed) — the caller then certifies
 * nothing, never a false anchor.
 *
 * The digest is computed by the core from the live rendered fragment; this
 * function supplies no content and cannot forge one.
 */
export function certifyClientAnchor(
  doc: ConversationDoc,
  input: CertifyClientInput,
): DemoAnchor | null {
  const reader = new CovenantDocReaderProd(
    doc.doc,
    { path: input.bodyPath, start: input.start, end: input.end },
    { resolveRoot: conversationContentRoot },
  );
  const certifier: HumanCertifier = { kind: 'human', userId: input.userId };
  const anchor = certifyAnchor(reader, {
    objectId: input.objectId,
    roomId: input.roomId,
    certifier,
    certifiedAt: new Date().toISOString(),
  });
  if (anchor === null) return null;
  return { anchor, messageId: input.messageId, start: input.start, end: input.end };
}

/**
 * Re-resolve one anchor against the live doc, answering ✓ (`ok`) or ~ (`drift`),
 * fail-closed. Delegates the whole verdict to `resolveCovenant` — a content-digest
 * match is `ok`; any drift, any unverifiable/GC'd/forged state, and any throw is
 * `drift`. There is no OK-by-default anywhere on this path.
 */
export function resolveClientAnchor(doc: ConversationDoc, anchor: CovenantAnchor): CovenantStatus {
  const reader = new CovenantDocReaderProd(doc.doc, undefined, {
    resolveRoot: conversationContentRoot,
  });
  return resolveCovenant(reader, anchor).covenantStatus;
}

/** The glyph for a resolution — `✓` only for `ok`, `~` for everything else. */
export function glyphForStatus(status: CovenantStatus): string {
  return status === 'ok' ? GLYPH_CERTIFIED : GLYPH_DRIFT;
}
