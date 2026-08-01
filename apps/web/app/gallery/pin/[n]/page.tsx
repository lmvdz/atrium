/* ---------------------------------------------------------------------------
 * The pin under load — one full frame per owed-item count.
 *
 * Round 1 measured the unbounded pin at 1440×900: 13 owed items left the feed
 * 183px tall, 17 left 55px, and at 19 the composer's bottom edge sat at 909 in
 * a 900px viewport with `scrollHeight` stuck at 900 — unreachable by any means.
 * These routes exist so that number is MEASURED on every run rather than
 * asserted once: `pin-bound.spec.ts` drives all four counts across all four
 * widths in both themes and checks the composer is still in frame.
 *
 * They are static: `generateStaticParams` names the four counts, so nothing
 * here needs a runtime.
 * ------------------------------------------------------------------------- */

import type { Metadata } from 'next';
import * as f from '../../fixtures';
import { RoomFrame } from '../../RoomFrame';

/** 4 fits; 13 and 19 are the round-1 failure points; 34 is well past them. */
export const PIN_LOADS = [4, 13, 19, 34] as const;

export function generateStaticParams() {
  return PIN_LOADS.map((n) => ({ n: String(n) }));
}

export const metadata: Metadata = {
  title: 'Atrium · the pin under load',
};

export default async function PinLoadPage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  const count = Number.parseInt(n, 10);
  const attention = f.manyOwed(count);

  return (
    <div data-pin-load={String(count)}>
      <RoomFrame
        attention={attention}
        binding={f.FREE}
        boxed={false}
        composerNote={`${count} owed · the pin folds rather than pushing this off the screen`}
        entries={f.timeline({ seen: false, filter: null, routineOpen: false })}
        filtered={false}
        focused="needs-you"
        humans={f.HUMANS}
        label={`pin-load-${count}`}
        lastCheck="12:29"
        objectives={f.OBJECTIVES}
        objects={f.OBJECTS}
        room={f.ROOM}
        rooms={f.ROOMS}
        trailer={f.TRAILER}
        updatedAt="13:41"
        viewer={f.VIEWER}
        viewerNote={`here · ${count} owed to you`}
      />
    </div>
  );
}
