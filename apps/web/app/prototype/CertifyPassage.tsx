'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * CERTIFY A PASSAGE (E8 / #197, P6F-3) — the human affordance that turns a
 * RANGE selection over a message body into a covenant certify gesture.
 *
 * The gesture, end to end: the human drag-selects a passage of the body rendered
 * here 1:1 (so what they select IS the span) → a floating ✓ control appears,
 * anchored to the selection → the human PRESSES AND HOLDS it (the reserved,
 * asymmetric-friction gesture every irreversible covenant act uses, `HoldToAct`)
 * → on completion the selection is mapped to `{ objectId, bodyPath, start, end }`
 * and handed to `certifyObjectSpanAction` (injected as {@link onCertify}).
 *
 * ## What this is NOT
 * The machine never certifies. Nothing here mints a ✓ on its own, and the outcome
 * glyph reflects ONLY the server's awaited answer ({@link CertifyOutcome.ok}) —
 * never a local optimistic flip. The ✓ ACT is a human's, and it is reserved: the
 * hold is the deliberate human act, the server (`certify-anchor.ts`) refuses a
 * non-human before it derives anything, and this surface reports the refusal
 * verbatim rather than dressing it as success. Certification MEANING is untouched;
 * this only says WHICH span the human's act is over — byte-for-byte the span the
 * covenant resolver re-reads ({@link spanFromSelection} → `CovenantDocReaderProd`).
 * ═════════════════════════════════════════════════════════════════════════ */

import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILE_TEXT_MAX, fileText } from '@/src/components/model';
import { type Glyph, glyphFor } from '@/src/components/model/glyph';
import { HoldToAct } from '@/src/components/primitives/HoldToAct';
import {
  BODY_ROOT_ATTR,
  type BodySegment,
  type BodySpan,
  bodyModelLength,
  bodyRenderDivergesFromRaw,
  EMBED_ATTR,
  type ObjectSpanRequest,
  objectSpanRequest,
  renderBodyModel,
  spanFromSelection,
} from './certify-span';
import styles from './prototype.module.css';
import type { ConversationDoc } from './yjs-conversation';

/**
 * The certify outcome, as `certifyObjectSpanAction` returns it — a structural
 * mirror of `CertifyAnchorOutcome` so this client surface never imports the
 * `server-only` module. `ok` is the server's awaited ack; `reason` is its own
 * machine refusal (`not_human` / `not_in_room` / `derive_failed` /
 * `already_certified`), surfaced to the operator, never swallowed as success.
 */
export type CertifyOutcome =
  | { readonly ok: true; readonly anchorId: string }
  | { readonly ok: false; readonly reason: string };

/** The refusals, in the operator's words — the server's own reason, humanised.
    `as const` keeps the literals, so {@link refusalCopy}'s return is a CLOSED union
    of sentences, not `string` — no caller text can reach the reader through it (the
    same discipline `glyphMeaning` keeps in `glyph.ts`). */
const REFUSAL_COPY = {
  not_human: 'the covenant refuses: a machine may draft a reading, never certify one',
  not_in_room: 'you are no longer a member of this room, so nothing was certified',
  derive_failed:
    'the live document could not be read for this span (the room’s conversation doc is not bound to this surface yet), so nothing was certified',
  already_certified:
    'a certified reading already stands for this object, and a certification is written once — this span was not certified over it',
} as const;
const GENERIC_REFUSAL = 'this span was not certified';

/* Printed copy is a CLOSED UNION OF LITERALS returned by a function declared in
   this file — the server's `reason` only SELECTS a sentence, it never becomes one,
   so no caller string reaches the reader through it. */
function refusalCopy(
  reason: string,
): (typeof REFUSAL_COPY)[keyof typeof REFUSAL_COPY] | typeof GENERIC_REFUSAL {
  return reason in REFUSAL_COPY
    ? REFUSAL_COPY[reason as keyof typeof REFUSAL_COPY]
    : GENERIC_REFUSAL;
}

function selectionHint(objectId: string | null, span: BodySpan | null, bodyLength: number): string {
  if (objectId === null) return 'no covenant object is bound to this message on this surface';
  if (span === null) return 'select the exact words a certification should cover';
  return `${span.end - span.start} of ${bodyLength} characters selected`;
}

function tooLongNote(bodyLength: number): string {
  return `this message body is too long to certify a passage on this surface (${bodyLength} characters); span-certify a shorter reading`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The 1:1 body render — the surface a selection is measured over.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a body text run into index-faithful DOM through the VERBATIM-CONTENT door.
 *
 * Body text is live doc content, so it goes through `fileText` — the same door
 * `DraftComment` renders a doc slice through — which REPLACES the bidi / control
 * characters a raw render of untrusted content must never paint with U+FFFD (this is
 * a control-char substitution, NOT an NFC normalization — no code points are folded,
 * so the coordinates still align). That replacement is LENGTH-PRESERVING (one code
 * unit → one U+FFFD), so it does not disturb the byte-exact index the span mapping
 * depends on — but it means a rewritten char reads as `�` while the covenant would
 * certify the raw character, which {@link CertifyPassage} surfaces as a warning
 * ({@link bodyRenderDivergesFromRaw}). The one control char
 * `fileText` also rewrites is the newline; to keep a multi-line body reading as
 * multiple lines (and to keep each `\n` its own one-unit position), the run is
 * split on `\n` FIRST and the newline re-emitted as a literal between the door-fed
 * line pieces — a literal, so it is traced, and `white-space: pre-wrap` renders it.
 * The surface caps the body at `FILE_TEXT_MAX` ({@link CertifyPassage}), so no
 * single line ever hits `fileText`'s truncation and the render stays 1:1.
 */
function renderRun(text: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(<Fragment key={`l${i}`}>{fileText(lines[i] ?? '', 'certify body run')}</Fragment>);
    if (i < lines.length - 1) out.push(<Fragment key={`n${i}`}>{'\n'}</Fragment>);
  }
  return out;
}

/**
 * Render a body's {@link BodySegment} model into the index-faithful DOM the mapper
 * counts over. The root carries {@link BODY_ROOT_ATTR}; text runs are the verbatim
 * body content through the `fileText` door ({@link renderRun}); inline marks are
 * transparent wrappers (they add no units); an embed is a length-1 atom carrying
 * {@link EMBED_ATTR} (its label goes through the door too). `white-space: pre-wrap`
 * keeps newlines as real characters, one unit each — never a `<br>`, which would
 * drop from the count and skew the span.
 *
 * Exported so the mutation test renders the SAME DOM the human selects over —
 * there is one render, and the mapper is proven against it, not a stand-in.
 */
export function CertifyBody({ segments }: { segments: readonly BodySegment[] }) {
  return (
    <div className={styles.certifyBody} {...{ [BODY_ROOT_ATTR]: 'true' }}>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          seg.marks.length > 0 ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered segment list
            <span key={i} className={styles.certifyMark} data-marks={seg.marks.join(' ')}>
              {renderRun(seg.text)}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered segment list
            <span key={i}>{renderRun(seg.text)}</span>
          )
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered segment list
            key={i}
            className={styles.certifyEmbed}
            contentEditable={false}
            {...{ [EMBED_ATTR]: 'true' }}
          >
            ⟦{fileText(seg.label, 'certify embed label')}⟧
          </span>
        ),
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The affordance.
// ─────────────────────────────────────────────────────────────────────────────

export interface CertifyPassageProps {
  /** The client conversation doc holding the live `Y.XmlText` bodies. */
  readonly doc: ConversationDoc;
  /** Which message's body this certifies a passage of. */
  readonly messageId: string;
  /**
   * The doc's convergence tick (`useConversationModel().version`) — bumps on every
   * CRDT convergence, local or remote. Threaded here so a body edit UNDER an open
   * panel recomputes the rendered segments AND invalidates any pending selection: a
   * span mapped against the previous body names coordinates the human never saw, and
   * must never reach the server (E8 finding #1). Without it the panel would show
   * stale text at stale offsets while the server minted an anchor from the CURRENT
   * body at those coordinates — certifying a passage the human never read.
   */
  readonly version: number;
  /**
   * The accepted covenant OBJECT the ✓ is over (a uuid). Decoupled from the body
   * path and the message id — `bodyPath` names WHERE the body is, `objectId` names
   * WHAT object the reading is of. `null` when the surface has no object bound for
   * this message yet: the passage renders and maps correctly, but the certify
   * control stays disabled (honestly inert — nothing to certify against).
   */
  readonly objectId: string | null;
  readonly workspaceSlug: string;
  readonly roomSlug: string;
  /** Who is pressing — required, because an arming with no actor records nothing. */
  readonly actor: string;
  /**
   * Drives the reserved certify ACT. Wired to `certifyObjectSpanAction`. Awaited;
   * the glyph reflects its answer and nothing else. Never called on render — only
   * inside the completed hold.
   */
  readonly onCertify: (request: ObjectSpanRequest) => Promise<CertifyOutcome>;
  /** Fires after any resolved certify attempt (test / caller observation). */
  readonly onResult?: (outcome: CertifyOutcome) => void;
}

type Status =
  | { readonly phase: 'idle' }
  | { readonly phase: 'pending' }
  | { readonly phase: 'done'; readonly outcome: CertifyOutcome };

/** The verified state a standing ✓ derives from (green tick) — never hand-set. */
const CERTIFIED_GLYPH: Glyph = glyphFor({
  kind: 'claim',
  verification: 'accepted',
  owedToViewer: false,
  irreversible: false,
});

export function CertifyPassage({
  doc,
  messageId,
  version,
  objectId,
  workspaceSlug,
  roomSlug,
  actor,
  onCertify,
  onResult,
}: CertifyPassageProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState<BodySpan | null>(null);
  const [status, setStatus] = useState<Status>({ phase: 'idle' });

  /* The doc `version` the current `span` was MEASURED against. A span is a set of
     coordinates into ONE body revision; the moment the body converges (version bumps)
     those coordinates may name a different passage — or nothing the human read. This
     stamp lets `request` null a stale span DURING RENDER (below) — post-commit
     defense-in-depth. It does NOT by itself close the rAF-before-commit window; the
     fire-time convergence guard in `complete()` (liveConvergeRef vs spanConvergeRef,
     bumped synchronously in Yjs onChange) is what refuses a stale span regardless of
     scheduler/commit ordering. */
  const spanVersionRef = useRef(version);

  /* A SYNCHRONOUS convergence counter — the commit-order-independent partner to the
     React `version` prop (E8 r3). `version` is React state: it lands only after React
     commits the re-render a convergence schedules, and a `requestAnimationFrame` hold
     frame can fire `complete` BEFORE that commit, reading a stale disabled/request. So
     the certify staleness guard cannot be built on `version` alone. This ref is bumped
     inside the Yjs `onChange` (`observeDeep`, which fires synchronously within the
     converging transaction), so it is fresh the instant the doc changes — before any
     frame or commit. `spanConvergeRef` stamps its value when a span is measured; the
     `HoldToAct` guard aborts a completing hold if it has advanced since (see below). */
  const liveConvergeRef = useRef(0);
  const spanConvergeRef = useRef(0);
  useEffect(() => {
    // Bump BEFORE React's own `version` state update runs, and outside its commit.
    const off = doc.onChange(() => {
      liveConvergeRef.current += 1;
    });
    return off;
  }, [doc]);

  // The body's live rich-text, projected to the index-faithful render model.
  // RECOMPUTED ON `version` (E8 finding #1): a body edit under an open panel — local
  // or remote — bumps `version`, so the rendered segments (and the offsets a
  // selection is measured against) always reflect the CURRENT body. The server
  // mints the anchor from the current body too; if this surface lagged, it would
  // show stale text at stale offsets and certify coordinates the human never saw.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the convergence trigger; body identity is captured by (doc, messageId)
  const segments = useMemo<BodySegment[]>(() => {
    const body = doc.body(messageId);
    return body ? renderBodyModel(body) : [];
  }, [doc, messageId, version]);
  const bodyLength = bodyModelLength(segments);
  const divergesFromRaw = useMemo(() => bodyRenderDivergesFromRaw(segments), [segments]);

  // INVALIDATE A PENDING SELECTION — AND A COMPLETED ACT-RECEIPT — WHEN THE BODY
  // CHANGES (E8 finding #1, extended for #212). A span captured against the previous
  // body indexes coordinates that no longer describe what the human read; it must
  // never complete a certify. On any convergence we clear the pending span (disabling
  // the ✓) AND collapse the browser selection, so the human re-selects against the
  // recomputed body rather than certifying at stale coords.
  //
  // A COMPLETED `done` status is stale for the identical reason (#212): the ✓ receipt
  // "a human certification now stands over this span" describes the body at the
  // version it was certified at; once the body converges past that version the
  // sentence no longer describes current state, and a standing green ✓ in the panel
  // becomes a user-reachable lie over drifted content (the resolver-driven feed
  // `CovenantGlyph` correctly flips ✓→~, but this panel receipt did not). So a
  // completed status is reset to idle on convergence: the panel's confirmation is an
  // ACT-RECEIPT, not a standing covenant indicator — the standing truth comes ONLY
  // from the resolver-driven feed glyph. The reset is unconditional on convergence
  // (not gated on whether the edit touched this span): a receipt must not outlive the
  // state it described, full stop. The first render's run is a no-op (span is already
  // null and status is already idle).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire only on a body convergence, keyed by `version`
  useEffect(() => {
    setSpan(null);
    setStatus({ phase: 'idle' });
    const sel = bodyRef.current?.ownerDocument?.defaultView?.getSelection();
    sel?.removeAllRanges();
  }, [version]);

  // Recompute the selected span from the live DOM selection. Fires on mouseup and
  // on the document's selectionchange, so a keyboard (shift-arrow) selection is
  // captured too — never an inferred or synthesised range.
  const syncSelection = useCallback(() => {
    const root = bodyRef.current;
    if (!root) return;
    // Stamp the span with the version it was measured against, so a later convergence
    // can tell this span is stale (see the `request` memo). Written before the state
    // update so the render that observes the new span also sees the matching stamp.
    spanVersionRef.current = version;
    // Stamp the SYNCHRONOUS convergence count too, so the fire-time hold guard can
    // detect a convergence that happened after this span was measured even before
    // React commits the matching `version` re-render (E8 r3).
    spanConvergeRef.current = liveConvergeRef.current;
    setSpan(spanFromSelection(root));
  }, [version]);

  useEffect(() => {
    const docNode = bodyRef.current?.ownerDocument;
    if (!docNode) return;
    docNode.addEventListener('selectionchange', syncSelection);
    return () => docNode.removeEventListener('selectionchange', syncSelection);
  }, [syncSelection]);

  // The certify request, recomputed on `version` (E8 finding #1 / r2 / r3). A span is
  // coordinates into ONE body revision; on any convergence the pending span is STALE —
  // it names a passage the human may never have read — so `request` goes null the
  // instant the stamped version no longer matches the current one. This nulling happens
  // DURING RENDER, so `canCertify` is false and the ✓ is disabled once React commits
  // the convergence re-render. That commit is NOT guaranteed to beat an in-flight hold
  // frame, though: a queued `requestAnimationFrame` can fire `complete` before React
  // commits, reading a stale `disabled`. So this render-time nulling (and the
  // `disabled` it drives) is defense-in-depth; what actually closes the race regardless
  // of commit ordering is the `guard` handed to `HoldToAct` below, backed by
  // `liveConvergeRef` — a counter bumped synchronously inside the doc's convergence,
  // before any frame or commit.
  const request: ObjectSpanRequest | null = useMemo(() => {
    if (span === null) return null;
    if (spanVersionRef.current !== version) return null;
    return objectSpanRequest({
      workspaceSlug,
      roomSlug,
      objectId: objectId ?? '',
      bodyPath: doc.bodyPath(messageId),
      span,
    });
  }, [span, objectId, workspaceSlug, roomSlug, doc, messageId, version]);

  /* The verbatim body goes through the `fileText` door, which truncates past
     `FILE_TEXT_MAX`. A truncated body would render fewer characters than the live
     `Y.XmlText` holds, so a selection past the cut would map to the wrong span. So
     a body longer than the cap is NOT certifiable on this surface — it fails closed
     (an honest note, no selectable body) rather than mapping an inexact span. */
  const tooLong = bodyLength > FILE_TEXT_MAX;
  const canCertify =
    objectId !== null && request !== null && status.phase !== 'pending' && !tooLong;

  const runCertify = useCallback(async () => {
    if (objectId === null || request === null) return;
    setStatus({ phase: 'pending' });
    let outcome: CertifyOutcome;
    try {
      outcome = await onCertify(request);
    } catch {
      // A thrown action (network / server error) is a refusal, never a ✓.
      outcome = { ok: false, reason: 'derive_failed' };
    }
    setStatus({ phase: 'done', outcome });
    onResult?.(outcome);
  }, [objectId, request, onCertify, onResult]);

  const outcome = status.phase === 'done' ? status.outcome : null;

  return (
    <div className={styles.certifyPanel} data-testid="certify-passage">
      <div className={styles.certifyHead}>
        <span className={styles.certifyTitle}>certify a passage</span>
        <span className={styles.certifyHint}>{selectionHint(objectId, span, bodyLength)}</span>
      </div>

      {/* FIDELITY WARNING (E8 finding #4). This body carries a bidi/control char the
          verbatim door paints as `�` — so what you see is NOT byte-for-byte what a
          certification would cover (the anchor is minted from the raw content). Not a
          refusal: the raw content is legitimate to certify and the span index is
          still exact; the warning simply keeps the human's eye and the covenant's
          bytes honest with each other. */}
      {!tooLong && divergesFromRaw ? (
        <div className={styles.certifyWarn} role="note" data-testid="certify-fidelity-warning">
          this passage contains characters shown as “�” for safety; certifying covers the raw
          content, not the displayed form
        </div>
      ) : null}

      {/* THE 1:1 BODY — what you select is the span. A body longer than the door's
          cap fails closed (an honest note) rather than rendering a truncated,
          mis-mappable surface. */}
      {tooLong ? (
        <div className={styles.certifyBody} data-testid="certify-too-long">
          {tooLongNote(bodyLength)}
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: the body is a selection surface
        <div ref={bodyRef} onMouseUp={syncSelection} onKeyUp={syncSelection}>
          <CertifyBody segments={segments} />
        </div>
      )}

      {/* THE RESERVED ✓ GESTURE — a press-and-hold, the human's deliberate act.
          Disabled until a real span is selected AND an object is bound, so a hold
          can never fire over nothing. It is never auto-triggered. */}
      <div className={styles.certifyControls}>
        <HoldToAct
          actionId={`certify-span-${messageId}`}
          actor={actor}
          label="Certify this passage"
          describe="record a human certification over exactly the selected span of this message"
          disabled={!canCertify}
          guard={() => liveConvergeRef.current === spanConvergeRef.current}
          resetOnComplete
          onAct={() => {
            void runCertify();
          }}
          className={styles.certifyHold}
        />
        {outcome?.ok ? (
          <span className={styles.certifyOk} data-testid="certify-outcome" role="status">
            <span className={styles.certifyGlyph} aria-hidden data-glyph={CERTIFIED_GLYPH}>
              {CERTIFIED_GLYPH}
            </span>{' '}
            certified — a human certification now stands over this span
          </span>
        ) : outcome ? (
          <span className={styles.certifyRefused} data-testid="certify-outcome" role="status">
            {refusalCopy(outcome.reason)}
          </span>
        ) : status.phase === 'pending' ? (
          <span className={styles.certifyPending} role="status">
            asking the server…
          </span>
        ) : null}
      </div>
    </div>
  );
}
