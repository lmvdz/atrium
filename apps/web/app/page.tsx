/* ---------------------------------------------------------------------------
 * The app shell, rendered from the component library against fixture props.
 *
 * This is the scaffold's placeholder replaced by the real frame. It still has
 * no data layer — #25 wires these components to replayed conversations and #27
 * to live ones — so it renders the same fixtures the gallery uses. The point is
 * that `/` is now the actual three-surface product (init.md §3): Conversation
 * on the left, what the group now understands in the middle-right, what needs
 * *you* pinned above the feed.
 * ------------------------------------------------------------------------- */

import * as f from './gallery/fixtures';
import { RoomFrame } from './gallery/RoomFrame';

export default function HomePage() {
  return (
    <RoomFrame
      attention={f.ATTENTION}
      binding={f.BOUND}
      boxed={false}
      composerNote="nothing is inferred from a message unless you bind it"
      entries={f.timeline({ seen: false, filter: null, routineOpen: false })}
      filtered={false}
      focused="conversation"
      humans={f.HUMANS}
      label="home"
      lastCheck="12:29"
      objectives={f.OBJECTIVES}
      objects={f.OBJECTS}
      openAttentionId="X1"
      room={f.ROOM}
      rooms={f.ROOMS}
      trailer={f.TRAILER}
      updatedAt="13:41"
      viewer={f.VIEWER}
      viewerNote="here · 4 owed to you"
    />
  );
}
