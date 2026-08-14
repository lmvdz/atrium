/* The Atrium component library.
 *
 * Everything here is props-driven and stateless: zero data fetching, zero
 * global state, no interaction state machine. Behaviour the prototype has not
 * settled arrives as a prop and the caller decides. #25 wires these to replay
 * data; #27 wires them to live data.
 */

export { AttentionCard } from './attention/AttentionCard';
export { AttentionCompact } from './attention/AttentionCompact';
export { CrossRoomJump } from './attention/CrossRoomJump';
export { nextPageLabel, Pin } from './attention/Pin';
export { Trailer } from './attention/Trailer';
export { ControlPin } from './control/ControlPin';
export { ControlPlane } from './control/ControlPlane';
export { ControlSurfaces } from './control/ControlSurfaces';
export { ProcessTree } from './control/ProcessTree';
export { ReviewPane } from './control/ReviewPane';
export {
  AppFrame,
  WorkspaceMark,
  WorkspaceSpacer,
  WorkspaceTile,
  WorkspaceYou,
} from './frame/AppFrame';
export { Composer } from './frame/Composer';
export { Rail } from './frame/Rail';
export { RoomHead } from './frame/RoomHead';
export { SurfaceIndicators } from './frame/SurfaceIndicators';
export { ObjectiveGroup } from './lens/ObjectiveGroup';
export { ObjectRow } from './lens/ObjectRow';
export { ReceiptView } from './lens/ReceiptView';
export { ReferenceMarkers } from './lens/ReferenceMarkers';
export { StateLens } from './lens/StateLens';
export * from './model';
export { ClaimText } from './primitives/ClaimText';
export { Glyph } from './primitives/Glyph';
export type { Arming, HoldToActProps } from './primitives/HoldToAct';
export { DEFAULT_HOLD_MS, HoldToAct } from './primitives/HoldToAct';
export { MessageBody } from './primitives/MessageBody';
export { hasRichMessageSyntax, RichMessageBody } from './primitives/RichMessageBody';
export { Quoted, SystemVoice } from './primitives/Voice';
export { AttachmentPreview } from './timeline/AttachmentPreview';
export { RoutineCollapse } from './timeline/RoutineCollapse';
export { SinceYouLeftDivider } from './timeline/SinceYouLeftDivider';
export { SystemRow } from './timeline/SystemRow';
export { Timeline } from './timeline/Timeline';
export type { RowAction } from './timeline/TimelineRow';
export { TimelineRow } from './timeline/TimelineRow';
