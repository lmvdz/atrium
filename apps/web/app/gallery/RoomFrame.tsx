'use client';

/* ---------------------------------------------------------------------------
 * RoomFrame — assembles the library into ONE FULL FRAME.
 *
 * The corpus rule the gallery exists to honour: never review a component in
 * isolation. Density, hairlines and the vertical rhythm only mean anything
 * against a whole screen, so every gallery entry is a complete rail | workspace
 * | lens frame with real content in all three surfaces.
 *
 * EVERY HANDLER THE LIBRARY EXPOSES IS FORWARDED. Round 2's gauntlet: this
 * component passed none of them, so `/` — the page whose job is to show the
 * library working — was a screen of controls that did nothing when clicked. The
 * props existed, so nobody was forced to fork anything; the demo was simply not
 * a demo. The gallery's six frames stay static on purpose (they are states, not
 * a session); `/` drives the same component through `RoomSession`.
 * ------------------------------------------------------------------------- */

import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Arming, Slot } from '../../src/components';
import {
  AppFrame,
  AttributionLedger,
  Composer,
  CrossRoomJump,
  initials,
  Pin,
  Rail,
  ReceiptView,
  RoomHead,
  StateLens,
  SurfaceIndicators,
  slot,
  surfaceIndicators,
  systemText,
  Timeline,
  WorkspaceMark,
  WorkspaceSpacer,
  WorkspaceTile,
  WorkspaceYou,
} from '../../src/components';
import frame from '../../src/components/frame/frame.module.css';
import type {
  AttentionClass,
  AttentionItem,
  ComposerBinding,
  ContextualReferenceAttention,
  CrossRoomJumpRecord,
  HumanSummary,
  Maybe,
  MessageRecord,
  ObjectiveRecord,
  ReceiptRecord,
  RoomHeadRecord,
  RoomSummary,
  StateObject,
  SurfaceId,
  TimelineEntry,
  TrailerSummary,
} from '../../src/components/model';
import { needsViewer } from '../../src/components/model';
import type { MessageAttachmentRecord } from '../../src/components/model/quotation';
import type { MessageReference, ReferenceTarget } from '../../src/lib/typed-references';
import { ThemeToggle } from '../theme-toggle';

/**
 * Every seam the library offers, in one place. Optional throughout: the
 * gallery's frames are stills and pass none of them; `/` passes all of them.
 */
export interface RoomFrameHandlers {
  readonly attachments?: readonly {
    readonly id: string;
    readonly name: string;
    readonly contentType?: string;
    readonly previewUrl?: string;
  }[];
  /* THE THREE THIS RECORD DID NOT HAVE.

     Round 6's blind critic clicked all 53 visible controls on `/` and found 17
     inert: the four rail room chips, both objective disclosure triangles, and
     all ten state-object rows. `Rail` declares `onSelectRoom`; `StateLens`
     declares `onToggleObjective` and `onOpenReceipt`; `ObjectRow` declares
     `onOpenReceipt`. This record declared none of the three, under a comment
     reading "EVERY HANDLER THE LIBRARY EXPOSES IS FORWARDED".

     Round 2 found the same shape and the fix was applied to the handlers round 2
     named. A comment claiming exhaustiveness is not a count; `e2e/smoke.spec.ts`
     now asserts the denominator — every visible control either changes something
     or is named inert with a reason — so this record cannot fall behind the
     library again without something going red. */
  readonly onSelectRoom?: (roomId: string) => void;
  readonly onToggleObjective?: (objectiveId: string) => void;
  readonly onOpenReceipt?: (objectId: string) => void;
  /* THE RECEIPT'S OWN THREE SEAMS — declared here since round 6 and wired to
     nothing until round 7, because both consumers built `<ReceiptView>` by hand
     and handed it across a `Slot`. A component reached through an opaque value
     is invisible to JSX derivation (D3), so `ReceiptView`'s `onBack`, `onReopen`
     and `onJump` were required by nothing: deleting `onJump` from
     `RoomSession`'s copy killed the receipt's only outbound navigation with tsc
     at 0 and every suite green. The frame constructs the receipt now, so the
     receipt is an ordinary child with an ordinary prop table. */
  readonly onCloseReceipt?: () => void;
  readonly onReopen?: (receiptId: string) => void;
  readonly onRetypeToClaim?: (receiptId: string) => void;
  readonly onAcceptReceipt?: (receiptId: string, objectiveId: string | null) => void;
  readonly onAnswerReceipt?: (receiptId: string) => void;
  readonly onSupersedeReceipt?: (retiredObjectId: string, replacementObjectId: string) => void;
  readonly onJumpToMessage?: (messageId: string) => void;
  /* The trace bar's other two seams, found by the counting test above rather
     than by a person reading the file: `CrossRoomJump` declares `onBack` and
     `onDismiss`, this record declared neither, and the bar's "back to #room →"
     and "✕" did nothing. Round 6's fix was applied to the three handlers the
     receipt named; the enumeration found the two it did not. */
  readonly onJumpBack?: () => void;
  readonly onDismissJump?: () => void;
  /** the trailer's lead: what is wrong outside the pin */
  readonly onShowRest?: () => void;
  readonly onFocusSurface?: (surface: SurfaceId) => void;
  readonly onFilter?: (attentionClass: AttentionClass) => void;
  readonly onTogglePeek?: (entryId: string) => void;
  readonly onRowAction?: (entryId: string, actionId: string) => void;
  readonly onOpenTag?: (entryId: string) => void;
  readonly onOpenAttachment?: (messageId: string, attachment: MessageAttachmentRecord) => void;
  readonly onDownloadAttachment?: (messageId: string, attachment: MessageAttachmentRecord) => void;
  readonly attachmentPreviewUrl?: (
    messageId: string,
    attachment: MessageAttachmentRecord,
  ) => string | undefined;
  readonly loadAttachmentPreviewUrl?: (
    messageId: string,
    attachment: MessageAttachmentRecord,
  ) => Promise<string>;
  readonly onMarkSeen?: (entryId: string) => void;
  readonly onUnmarkSeen?: (entryId: string) => void;
  readonly onOpenAttention?: (itemId: string) => void;
  readonly onOpenReferences?: (attentionIds: readonly string[], messageId: string) => void;
  readonly onAct?: (itemId: string, actionId: string) => void;
  readonly onArm?: (itemId: string, arming: Arming) => void;
  readonly onJumpToSource?: (itemId: string, messageId: string) => void;
  readonly onPagePin?: (page: number, pageCount: number) => void;
  readonly onFoldPin?: (folded: boolean) => void;
  readonly composerValue?: string;
  readonly onComposerChange?: (draft: string) => void;
  /* The composer exposes four seams and this record used to forward two. No
     consumer was forced to fork — the props are on <Composer> — but the demo
     whose whole job is to show the library working showed a narrower library
     than the one that shipped. `onKeyDown` is the seam a consumer uses to take
     the Enter key over, and `textareaRef` is how it puts focus back after a
     send; a "here is everything the library offers" frame that omits them is
     wrong about the library. */
  readonly onComposerKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly composerRef?: Ref<HTMLTextAreaElement>;
  readonly onSend?: (draft: string, references: readonly MessageReference[]) => void;
  readonly onAttach?: (file: File) => void;
  readonly onRemoveAttachment?: (id: string) => void;
  readonly attachmentNote?: string;
  readonly onCancelBinding?: () => void;
}

export interface RoomFrameProps {
  /**
   * The record register this frame's citations resolve against — the same
   * messages the feed was built from. Required, and required to be complete: a
   * quotation whose message is not in here does not render, it throws. That is
   * the whole point of round 5's fix, so an optional prop with an empty default
   * would be the exemption that undoes it.
   */
  readonly messages: readonly MessageRecord[];
  readonly room: RoomHeadRecord;
  readonly rooms: readonly RoomSummary[];
  readonly humans: readonly HumanSummary[];
  readonly viewer: HumanSummary;
  readonly focused: SurfaceId;
  readonly attention: readonly AttentionItem[];
  readonly referenceAttention?: readonly ContextualReferenceAttention[];
  readonly openAttentionId?: string;
  readonly trailer: TrailerSummary;
  readonly lastCheck: string;
  readonly entries: readonly TimelineEntry[];
  /** which class is lifted, or null. Round 10, D3 — see `TimelineProps.filter`. */
  readonly filter: Maybe<AttentionClass>;
  readonly objectives: readonly ObjectiveRecord[];
  readonly objects: readonly StateObject[];
  readonly updatedAt: string;
  readonly binding: ComposerBinding;
  readonly composerNote?: string;
  readonly composerEnabled?: boolean;
  readonly jump?: CrossRoomJumpRecord;
  /**
   * The receipt to show in the lens, as a RECORD rather than as pre-built
   * content. A `Slot` here meant every consumer wrote its own `<ReceiptView>`
   * and its own three handlers, outside every enumeration this file has.
   */
  readonly receipt?: ReceiptRecord;
  readonly supersessionCandidates?: readonly StateObject[];
  readonly pendingReplacementId?: string;
  readonly acceptObjectives?: readonly { readonly id: string; readonly label: string }[];
  readonly referenceTargets?: readonly ReferenceTarget[];
  /** Product routes recover this space; historical gallery frames may still exhibit the old state. */
  readonly hideEmptyAttention?: boolean;
  readonly boxed?: boolean;
  readonly label?: string;
  readonly handlers?: RoomFrameHandlers;
}

/**
 * Every frame renders inside its own attribution ledger. There is no path from
 * a `RoomFrame` to a rendered quotation that does not go through it, which is
 * what makes "the actor is looked up, never carried" a property of the frame
 * rather than of whoever remembered to wire it.
 */
export function RoomFrame(props: RoomFrameProps) {
  return (
    /* The register AND the vantage. "Is this message's source somewhere else?"
       needs the record and the room on screen, and round 8 answered it at three
       render boundaries that had only ever been handed the record. */
    <AttributionLedger messages={props.messages} room={props.room.name}>
      <Frame {...props} />
    </AttributionLedger>
  );
}

const DEFAULT_STATE_SHARE = 60;
const SNAP_EDGE = 4;

/**
 * Current State and Conversation are independent surfaces. Keeping their
 * sizing in one component prevents either child from borrowing the other's
 * height and makes the boundary operable by pointer and keyboard.
 */
function WorkspaceSplit({
  statePane,
  conversationPane,
}: {
  statePane: Slot;
  conversationPane: Slot;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [stateShare, setStateShare] = useState(DEFAULT_STATE_SHARE);
  const snapped = (value: number) => {
    if (value <= SNAP_EDGE) return 0;
    if (value >= 100 - SNAP_EDGE) return 100;
    return Math.round(Math.max(0, Math.min(100, value)));
  };
  const resizeFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const bounds = root.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.height === 0) return;
    setStateShare(snapped(((event.clientY - bounds.top) / bounds.height) * 100));
  };
  const rows =
    stateShare === 0
      ? '0px 9px minmax(0, 1fr)'
      : stateShare === 100
        ? 'minmax(0, 1fr) 9px 0px'
        : `minmax(0, ${stateShare}fr) 9px minmax(0, ${100 - stateShare}fr)`;
  return (
    <div
      className={frame.workspaceSplit}
      data-conversation-collapsed={stateShare === 100 ? 'true' : undefined}
      data-state-collapsed={stateShare === 0 ? 'true' : undefined}
      data-workspace-split="true"
      ref={root}
      style={{ gridTemplateRows: rows } as CSSProperties}
    >
      <section aria-label="Current state pane" className={frame.splitState}>
        {statePane.node}
      </section>
      <hr
        aria-label="Resize current state and conversation panes"
        aria-orientation="horizontal"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={stateShare}
        aria-valuetext={`Current state ${stateShare}%; conversation ${100 - stateShare}%`}
        className={frame.workspaceSeparator}
        onDoubleClick={() => setStateShare(DEFAULT_STATE_SHARE)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') setStateShare((value) => snapped(value - 5));
          else if (event.key === 'ArrowDown') setStateShare((value) => snapped(value + 5));
          else if (event.key === 'Home') setStateShare(0);
          else if (event.key === 'End') setStateShare(100);
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          resizeFromPointer(event);
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        tabIndex={0}
        title="drag to resize · Home hides state · End hides conversation · double-click resets"
      />
      <section aria-label="Conversation pane" className={frame.splitConversation}>
        {conversationPane.node}
      </section>
    </div>
  );
}

function Frame(props: RoomFrameProps) {
  const on = props.handlers ?? {};
  return (
    <AppFrame
      boxed={props.boxed ?? true}
      label={props.label ?? 'atrium'}
      lens={slot(<CallDock humans={props.humans} key="dock" roomName={props.room.name} />)}
      rail={slot(
        <Rail
          key="rail"
          humans={props.humans}
          onSelectRoom={on.onSelectRoom}
          rooms={props.rooms}
          workspaceName="atrium"
          workspaceSub={`${props.rooms.length} ${props.rooms.length === 1 ? 'room' : 'rooms'} · ${props.humans.length} ${props.humans.length === 1 ? 'human' : 'humans'}`}
        />,
      )}
      /* Every element handed across a slot boundary carries a key. React's dev
         build validates slot content as a child list, and an unkeyed element
         created in one component and rendered inside another trips the "unique
         key" warning even when the slot only ever holds one thing. */
      strip={slot([
        <WorkspaceMark key="mark" />,
        <WorkspaceTile code="AT" key="tile" title="Atrium — this workspace" />,
        <WorkspaceSpacer key="spacer" />,
        <ThemeToggle key="theme" />,
        /* Derived from the viewer, not typed in beside them. "LV" was hardcoded
           here while the viewer's name came from `props.viewer`, so a frame
           rendered for anybody else printed lars's monogram over their tile —
           the same species as every other free string this ticket has removed,
           at the smallest possible scale. `initials()` already existed and was
           already used by the rail and the room head. */
        <WorkspaceYou
          initials={initials(props.viewer.name)}
          key="you"
          title={`${systemText(props.viewer.name, 'RoomFrame viewer')} — you`}
        />,
      ])}
      workspace={slot([
        <Fragment key="workspace">
          <RoomHead
            room={props.room}
            settled={
              props.objects.filter((object) =>
                ['verified', 'accepted'].includes(object.state.verification),
              ).length
            }
            surfaces={slot(
              <SurfaceIndicators
                key="surfaces"
                focused={props.focused}
                onFocus={on.onFocusSurface}
                /* NOT `props.attention.length` — round 10, D5. The pin's array
                   holds acted-on items now (they stop needing you rather than
                   leaving), so the OWED count is `needsViewer` over it, which is
                   the same predicate `foldPin`, the rail and the lens count. A
                   length is the one reading of that array that stopped being
                   true the moment an act became a state change. */
                surfaces={surfaceIndicators(
                  props.attention.filter((item) => needsViewer(item.state)).length,
                  props.objects.length,
                )}
              />,
            )}
            working={
              props.objects.filter(
                (object) => !['verified', 'accepted'].includes(object.state.verification),
              ).length
            }
          />
          {props.jump === undefined ? (
            <div />
          ) : (
            <CrossRoomJump
              jump={props.jump}
              onBack={on.onJumpBack}
              onDismiss={on.onDismissJump}
              onReveal={on.onJumpToMessage}
            />
          )}
          <WorkspaceSplit
            statePane={slot(
              <Fragment key="state-pane">
                <div aria-hidden="true" className={frame.treeColumns}>
                  <span>SESSION</span>
                  <span>STATE</span>
                  <span>LATEST</span>
                  <span>LENS</span>
                  <span>SPEND</span>
                  <span>AGE</span>
                </div>
                {props.hideEmptyAttention &&
                !props.attention.some((item) => needsViewer(item.state)) ? null : (
                  <Pin
                    items={props.attention}
                    lastCheck={props.lastCheck}
                    onAct={on.onAct}
                    onArm={on.onArm}
                    onFold={on.onFoldPin}
                    onJumpToSource={on.onJumpToSource}
                    onOpen={on.onOpenAttention}
                    onPage={on.onPagePin}
                    onShowRest={on.onShowRest}
                    openId={props.openAttentionId}
                    trailer={props.trailer}
                    viewer={props.viewer.name}
                  />
                )}
                <StateLens
                  objectives={props.objectives}
                  objects={props.objects}
                  onOpenReceipt={on.onOpenReceipt}
                  onOpenReferences={on.onOpenReferences}
                  onToggleObjective={on.onToggleObjective}
                  referenceAttention={props.referenceAttention}
                  receipt={
                    props.receipt === undefined
                      ? undefined
                      : slot(
                          <ReceiptView
                            acceptObjectives={props.acceptObjectives}
                            key={props.receipt.id}
                            onAccept={on.onAcceptReceipt}
                            onAnswer={on.onAnswerReceipt}
                            onBack={on.onCloseReceipt}
                            onJump={on.onJumpToMessage}
                            onReopen={on.onReopen}
                            onRetypeToClaim={on.onRetypeToClaim}
                            onSupersede={on.onSupersedeReceipt}
                            pendingReplacementId={props.pendingReplacementId}
                            receipt={props.receipt}
                            supersessionCandidates={props.supersessionCandidates}
                          />,
                        )
                  }
                  roomName={props.room.name}
                  updatedAt={props.updatedAt}
                />
              </Fragment>,
            )}
            conversationPane={slot(
              <Fragment key="conversation-pane">
                <Timeline
                  attachmentPreviewUrl={on.attachmentPreviewUrl}
                  loadAttachmentPreviewUrl={on.loadAttachmentPreviewUrl}
                  entries={props.entries}
                  filter={props.filter}
                  onFilter={on.onFilter}
                  onMarkSeen={on.onMarkSeen}
                  onOpenAttachment={on.onOpenAttachment}
                  onDownloadAttachment={on.onDownloadAttachment}
                  onOpenTag={on.onOpenTag}
                  onRowAction={on.onRowAction}
                  onTogglePeek={on.onTogglePeek}
                  onUnmarkSeen={on.onUnmarkSeen}
                />
                <Composer
                  attachmentNote={on.attachmentNote}
                  attachments={on.attachments}
                  binding={props.binding}
                  disabled={props.composerEnabled === false}
                  footNote={props.composerNote}
                  referenceTargets={props.referenceTargets}
                  onAttach={on.onAttach}
                  onCancelBinding={on.onCancelBinding}
                  onChange={on.onComposerChange}
                  onKeyDown={on.onComposerKeyDown}
                  onRemoveAttachment={on.onRemoveAttachment}
                  onSend={on.onSend}
                  roomName={props.room.name}
                  textareaRef={on.composerRef}
                  value={on.composerValue}
                />
              </Fragment>,
            )}
          />
        </Fragment>,
      ])}
    />
  );
}

function CallDock({ humans, roomName }: { humans: readonly HumanSummary[]; roomName: string }) {
  const [tab, setTab] = useState<'call' | 'files'>('call');
  const [muted, setMuted] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [live, setLive] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <section aria-label="Call pane" className={frame.callDock}>
      <div className={frame.callTabs}>
        <button aria-pressed={tab === 'call'} onClick={() => setTab('call')} type="button">
          <span aria-hidden="true" className={frame.callGlyph}>
            ((•))
          </span>{' '}
          call
        </button>
        <button aria-pressed={tab === 'files'} onClick={() => setTab('files')} type="button">
          files
        </button>
        <span aria-hidden="true" className={frame.foldPane}>
          »
        </span>
      </div>
      {tab === 'files' ? (
        <div className={frame.filesPane}>
          <span>SHARED IN #{systemText(roomName, 'CallDock room')}</span>
          <p>No files have been shared in this room.</p>
        </div>
      ) : (
        <>
          <div className={frame.callStatus}>
            <span aria-hidden="true" className={`${frame.callDot} ${live ? 'atr-pulse' : ''}`} />
            <strong>{live ? `LIVE ${time}` : `ENDED · ${time}`}</strong>
            <span className={frame.callControls}>
              <button
                aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                aria-pressed={muted}
                onClick={() => setMuted((value) => !value)}
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 24 24" width="13">
                  <path
                    d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                  <path
                    d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="2"
                  />
                  {muted ? (
                    <path
                      d="m2 2 20 20"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="2"
                    />
                  ) : null}
                </svg>
              </button>
              <button
                aria-label={sharing ? 'Stop sharing screen' : 'Share screen'}
                aria-pressed={sharing}
                onClick={() => setSharing((value) => !value)}
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 24 24" width="13">
                  <rect
                    height="14"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="2"
                    width="20"
                    x="2"
                    y="3"
                  />
                  <path
                    d="M8 21h8M12 17v4"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="2"
                  />
                </svg>
              </button>
              <button
                aria-label="Hang up"
                className={frame.hangUp}
                disabled={!live}
                onClick={() => {
                  setLive(false);
                  setSharing(false);
                }}
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 24 24" width="13">
                  <path
                    d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91M22 2 2 22"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                </svg>
              </button>
            </span>
          </div>
          <div className={frame.callPeople}>
            {humans.map((human, index) => (
              <span
                aria-label={`${systemText(human.name, 'CallDock human')} · ${human.presence}`}
                className={`${frame.callAvatar} ${live && index === 0 ? frame.speaking : ''}`}
                data-live-presence={human.presence}
                key={human.id}
                role="img"
                title={systemText(human.name, 'CallDock human')}
              >
                {initials(systemText(human.name, 'CallDock human'))}
              </span>
            ))}
            <span className={`${frame.callAvatar} ${frame.atriumAvatar}`}>A</span>
            <span>
              {live
                ? `${humans.length + 1} on the call · atrium is the voice agent`
                : 'call ended · transcript saved to room history'}
            </span>
          </div>
          {sharing ? (
            <div className={frame.shareNotice}>
              <span className="atr-pulse" /> You are sharing your screen
            </div>
          ) : null}
          <div className={frame.callTranscript}>
            <div>
              <small>atrium · system</small>
              <p>{live ? 'Call is live. Spoken turns will appear here.' : 'Call ended.'}</p>
            </div>
            {live ? (
              <div className={frame.speakingLine}>
                <small>atrium · listening</small>
                <span>
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
