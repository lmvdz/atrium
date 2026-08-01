/* ---------------------------------------------------------------------------
 * RoomFrame — assembles the library into ONE FULL FRAME.
 *
 * The corpus rule the gallery exists to honour: never review a component in
 * isolation. Density, hairlines and the vertical rhythm only mean anything
 * against a whole screen, so every gallery entry is a complete rail | workspace
 * | lens frame with real content in all three surfaces.
 * ------------------------------------------------------------------------- */

import { Fragment, type ReactNode } from 'react';
import {
  AppFrame,
  Composer,
  CrossRoomJump,
  Pin,
  Rail,
  RoomHead,
  StateLens,
  SurfaceIndicators,
  Timeline,
  WorkspaceSpacer,
  WorkspaceTile,
  WorkspaceYou,
} from '../../src/components';
import type {
  AttentionItem,
  ComposerBinding,
  CrossRoomJumpRecord,
  HumanSummary,
  ObjectiveRecord,
  RoomHeadRecord,
  RoomSummary,
  StateObject,
  SurfaceId,
  TimelineEntry,
  TrailerSummary,
} from '../../src/components/model';
import { ThemeToggle } from '../theme-toggle';
import { surfaces } from './fixtures';

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
  readonly receipt?: ReactNode;
  readonly boxed?: boolean;
  readonly label?: string;
}

export function RoomFrame(props: RoomFrameProps) {
  return (
    <AppFrame
      boxed={props.boxed ?? true}
      label={props.label ?? 'atrium'}
      lens={
        <StateLens
          key="lens"
          objectives={props.objectives}
          objects={props.objects}
          receipt={props.receipt}
          roomName={props.room.name}
          updatedAt={props.updatedAt}
        />
      }
      rail={
        <Rail
          key="rail"
          humans={props.humans}
          rooms={props.rooms}
          viewer={props.viewer}
          viewerNote={props.viewerNote}
          workspaceName="atrium"
          workspaceSub="4 rooms · 5 humans"
        />
      }
      /* Every element handed across a slot boundary carries a key. React's dev
         build validates slot content as a child list, and an unkeyed element
         created in one component and rendered inside another trips the "unique
         key" warning even when the slot only ever holds one thing. */
      strip={[
        <WorkspaceTile code="AT" key="tile" title="Atrium — this workspace" />,
        <WorkspaceSpacer key="spacer" />,
        <ThemeToggle key="theme" />,
        <WorkspaceYou initials="LV" key="you" title="lars — you" />,
      ]}
      workspace={[
        <Fragment key="workspace">
          <RoomHead
            room={props.room}
            surfaces={
              <SurfaceIndicators
                key="surfaces"
                focused={props.focused}
                surfaces={surfaces(props.attention.length, props.objects.length)}
              />
            }
          />
          {props.jump === undefined ? <div /> : <CrossRoomJump jump={props.jump} />}
          <Pin
            folded={false}
            items={props.attention}
            lastCheck={props.lastCheck}
            openId={props.openAttentionId}
            trailer={props.trailer}
          />
          <Timeline entries={props.entries} filtered={props.filtered} />
          <Composer
            binding={props.binding}
            footNote={props.composerNote}
            roomName={props.room.name}
          />
        </Fragment>,
      ]}
    />
  );
}
