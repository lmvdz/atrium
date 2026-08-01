/* ---------------------------------------------------------------------------
 * The app shell, rendered from the component library against fixture props.
 *
 * This is the scaffold's placeholder replaced by the real frame. It still has
 * no data layer — #25 wires these components to replayed conversations and #27
 * to live ones — so it renders the same fixtures the gallery uses. The point is
 * that `/` is now the actual three-surface product (init.md §3): Conversation
 * on the left, what the group now understands in the middle-right, what needs
 * *you* pinned above the feed.
 *
 * Round 2's gauntlet found it forwarding no handlers, which made the page a
 * screen of dead controls. `RoomSession` is the consumer that drives it: it
 * owns the interaction state the components deliberately do not, and every
 * control on this page now does the thing it says it does.
 * ------------------------------------------------------------------------- */

import { RoomSession } from './RoomSession';

export default function HomePage() {
  return <RoomSession />;
}
