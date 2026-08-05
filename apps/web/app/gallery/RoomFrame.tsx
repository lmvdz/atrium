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

import type { KeyboardEvent, Ref } from 'react';
import { Fragment } from 'react';
import type { Arming } from '../../src/components';
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
import { ThemeToggle } from '../theme-toggle';

/**
 * Every seam the library offers, in one place. Optional throughout: the
 * gallery's frames are stills and pass none of them; `/` passes all of them.
 */
export interface RoomFrameHandlers {
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
  readonly onMarkSeen?: (entryId: string) => void;
  readonly onUnmarkSeen?: (entryId: string) => void;
  readonly onOpenAttention?: (itemId: string) => void;
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
  readonly onSend?: (draft: string) => void;
  readonly onAttach?: (file: File) => void;
  readonly onMention?: (userId: string | null) => void;
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
  readonly mentionTargets?: readonly { readonly id: string; readonly label: string }[];
  readonly mentionTargetId?: string | null;
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

function Frame(props: RoomFrameProps) {
  const on = props.handlers ?? {};
  return (
    <AppFrame
      boxed={props.boxed ?? true}
      label={props.label ?? 'atrium'}
      lens={slot(
        <section aria-label="Room activity dock" className={frame.conversationDock} key="dock">
          <div className={frame.dockHead}>
            <span className="atr-lbl">CONVERSATION</span>
            <span className="atr-meta">#{systemText(props.room.name, 'RoomFrame dock room')}</span>
          </div>
          <Timeline
            compact
            entries={props.entries}
            filter={props.filter}
            onFilter={on.onFilter}
            onMarkSeen={on.onMarkSeen}
            onOpenAttachment={on.onOpenAttachment}
            onOpenTag={on.onOpenTag}
            onRowAction={on.onRowAction}
            onTogglePeek={on.onTogglePeek}
            onUnmarkSeen={on.onUnmarkSeen}
          />
          <Composer
            attachmentNote={on.attachmentNote}
            binding={props.binding}
            disabled={props.composerEnabled === false}
            footNote={props.composerNote}
            mentionTargetId={props.mentionTargetId}
            mentionTargets={props.mentionTargets}
            onAttach={on.onAttach}
            onCancelBinding={on.onCancelBinding}
            onChange={on.onComposerChange}
            onKeyDown={on.onComposerKeyDown}
            onMention={on.onMention}
            onSend={on.onSend}
            roomName={props.room.name}
            textareaRef={on.composerRef}
            value={on.composerValue}
          />
        </section>,
      )}
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
          <StateLens
            objectives={props.objectives}
            objects={props.objects}
            onOpenReceipt={on.onOpenReceipt}
            onToggleObjective={on.onToggleObjective}
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
      ])}
    />
  );
}
