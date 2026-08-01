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

import { Fragment } from 'react';
import type { Arming } from '../../src/components';
import {
  AppFrame,
  Composer,
  CrossRoomJump,
  Pin,
  Rail,
  RoomHead,
  StateLens,
  SurfaceIndicators,
  slot,
  Timeline,
  WorkspaceSpacer,
  WorkspaceTile,
  WorkspaceYou,
} from '../../src/components';
import type {
  AttentionClass,
  AttentionItem,
  ComposerBinding,
  CrossRoomJumpRecord,
  HumanSummary,
  ObjectiveRecord,
  RoomHeadRecord,
  RoomSummary,
  Slot,
  StateObject,
  SurfaceId,
  TimelineEntry,
  TrailerSummary,
} from '../../src/components/model';
import { ThemeToggle } from '../theme-toggle';
import { surfaces } from './fixtures';

/**
 * Every seam the library offers, in one place. Optional throughout: the
 * gallery's frames are stills and pass none of them; `/` passes all of them.
 */
export interface RoomFrameHandlers {
  readonly onFocusSurface?: (surface: SurfaceId) => void;
  readonly onFilter?: (attentionClass: AttentionClass) => void;
  readonly onTogglePeek?: (entryId: string) => void;
  readonly onRowAction?: (entryId: string, actionId: string) => void;
  readonly onOpenTag?: (entryId: string) => void;
  readonly onMarkSeen?: (entryId: string) => void;
  readonly onUnmarkSeen?: (entryId: string) => void;
  readonly onOpenAttention?: (itemId: string) => void;
  readonly onAct?: (itemId: string, actionId: string) => void;
  readonly onArm?: (itemId: string, arming: Arming) => void;
  readonly onJumpToSource?: (itemId: string) => void;
  readonly onPagePin?: (page: number, pageCount: number) => void;
  readonly onFoldPin?: (folded: boolean) => void;
  readonly composerValue?: string;
  readonly onComposerChange?: (draft: string) => void;
  readonly onSend?: (draft: string) => void;
  readonly onCancelBinding?: () => void;
}

export interface RoomFrameProps {
  readonly room: RoomHeadRecord;
  readonly rooms: readonly RoomSummary[];
  readonly humans: readonly HumanSummary[];
  readonly viewer: HumanSummary;
  readonly viewerNote: string;
  readonly focused: SurfaceId;
  readonly attention: readonly AttentionItem[];
  readonly openAttentionId?: string;
  readonly trailer: TrailerSummary;
  readonly lastCheck: string;
  readonly entries: readonly TimelineEntry[];
  readonly filtered: boolean;
  readonly objectives: readonly ObjectiveRecord[];
  readonly objects: readonly StateObject[];
  readonly updatedAt: string;
  readonly binding: ComposerBinding;
  readonly composerNote: string;
  readonly jump?: CrossRoomJumpRecord;
  readonly receipt?: Slot;
  readonly boxed?: boolean;
  readonly label?: string;
  readonly handlers?: RoomFrameHandlers;
}

export function RoomFrame(props: RoomFrameProps) {
  const on = props.handlers ?? {};
  return (
    <AppFrame
      boxed={props.boxed ?? true}
      label={props.label ?? 'atrium'}
      lens={slot(
        <StateLens
          key="lens"
          objectives={props.objectives}
          objects={props.objects}
          receipt={props.receipt}
          roomName={props.room.name}
          updatedAt={props.updatedAt}
        />,
      )}
      rail={slot(
        <Rail
          key="rail"
          humans={props.humans}
          rooms={props.rooms}
          viewer={props.viewer}
          viewerNote={props.viewerNote}
          workspaceName="atrium"
          workspaceSub="4 rooms · 5 humans"
        />,
      )}
      /* Every element handed across a slot boundary carries a key. React's dev
         build validates slot content as a child list, and an unkeyed element
         created in one component and rendered inside another trips the "unique
         key" warning even when the slot only ever holds one thing. */
      strip={slot([
        <WorkspaceTile code="AT" key="tile" title="Atrium — this workspace" />,
        <WorkspaceSpacer key="spacer" />,
        <ThemeToggle key="theme" />,
        <WorkspaceYou initials="LV" key="you" title="lars — you" />,
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
                surfaces={surfaces(props.attention.length, props.objects.length)}
              />,
            )}
          />
          {props.jump === undefined ? <div /> : <CrossRoomJump jump={props.jump} />}
          <Pin
            items={props.attention}
            lastCheck={props.lastCheck}
            onAct={on.onAct}
            onArm={on.onArm}
            onFold={on.onFoldPin}
            onJumpToSource={on.onJumpToSource}
            onOpen={on.onOpenAttention}
            onPage={on.onPagePin}
            openId={props.openAttentionId}
            trailer={props.trailer}
            viewer={props.viewer.name}
          />
          <Timeline
            entries={props.entries}
            filtered={props.filtered}
            onFilter={on.onFilter}
            onMarkSeen={on.onMarkSeen}
            onOpenTag={on.onOpenTag}
            onRowAction={on.onRowAction}
            onTogglePeek={on.onTogglePeek}
            onUnmarkSeen={on.onUnmarkSeen}
          />
          <Composer
            binding={props.binding}
            footNote={props.composerNote}
            onCancelBinding={on.onCancelBinding}
            onChange={on.onComposerChange}
            onSend={on.onSend}
            roomName={props.room.name}
            value={on.composerValue}
          />
        </Fragment>,
      ])}
    />
  );
}
