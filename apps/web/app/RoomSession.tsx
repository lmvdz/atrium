'use client';

/* ---------------------------------------------------------------------------
 * `/` — the library, driven.
 *
 * Round 2's gauntlet: `/` rendered the real frame and forwarded no handlers, so
 * the page whose job is to prove the component library works was a screen of
 * controls that did nothing when clicked. Nothing was FORCED to fork — the props
 * all existed — but a demo that cannot be operated demonstrates markup, not a
 * library.
 *
 * This is the smallest honest consumer: it owns the state the components
 * deliberately do not (draft, filter, focus, which item is open, what has been
 * acted on) and hands it back down as props. It is still not a data layer —
 * there is no fetch and no store — which is the same boundary #25 and #27 will
 * sit on when they wire replay and live data to these components.
 *
 * The `/gallery` frames stay static on purpose. They are STATES, presented side
 * by side; a gallery whose frames drift as a reviewer clicks around is a gallery
 * that cannot be compared against the prototype.
 * ------------------------------------------------------------------------- */

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  Arming,
  AttentionClass,
  ComposerBinding,
  MessageEntry,
  MessageRecord,
  ObjectiveRecord,
  SurfaceId,
  TimelineEntry,
} from '../src/components';
import { messageEntry, needsViewer } from '../src/components';
import * as f from './gallery/fixtures';
import { RoomFrame } from './gallery/RoomFrame';
import { RECORDS, sessionView } from './gallery/rooms';

const TALK = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
} as const;

/** Wall clock as the feed writes it: 24-hour, no seconds. */
function clock(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function RoomSession() {
  const [focused, setFocused] = useState<SurfaceId>('conversation');
  const [filter, setFilter] = useState<AttentionClass | null>(null);
  const [seen, setSeen] = useState(false);
  const [routineOpen, setRoutineOpen] = useState(false);
  const [binding, setBinding] = useState<ComposerBinding>(f.BOUND);
  const [draft, setDraft] = useState('');
  const [openId, setOpenId] = useState<string | undefined>('X1');
  const [actedOn, setActedOn] = useState<readonly string[]>([]);
  /* The last thing the page did, in words, shown under the composer. Every
     handler writes here, so a control that fires nothing is visible as a
     control that says nothing — which is the failure this page exists to make
     impossible to ship again.
     IT STARTS EMPTY. It used to be seeded with "every control on this page is
     wired — click one and this line reports what it did", which is an
     instruction to a reviewer sitting in the product chrome of the route this
     round calls the actual product; the r8 review named it as the one piece of
     demo scaffolding on `/`. A status line with nothing to report reports
     nothing, and `Composer` renders no element for it. */
  const [note, setNote] = useState<string | undefined>(undefined);
  /* THE STATE BEHIND THE THREE HANDLERS THE FRAME NEVER FORWARDED. Round 6's
     critic clicked all four rail room chips, both objective triangles and all
     ten object rows and measured no change to `documentElement.className`, to
     `body.innerHTML.length` or to `innerText`. The props existed on `Rail`,
     `StateLens` and `ObjectRow` the whole time; what did not exist was a
     consumer holding the state they change. */
  /* WHICH ROOM YOU ARE IN IS ONE VALUE. Round 7, D6: this held `room`, the NAME,
     and the chip set it — so the head changed and the feed, the pin, the lens
     and the composer binding did not, while the rail went on marking a different
     room current. The two sources of truth this product is about, disagreeing on
     screen. It holds the room's ID now and everything on the page derives from
     the view that id names. */
  const [roomId, setRoomId] = useState('r1');
  /* THE ONLY VIEW THIS COMPONENT CAN GET, AND THE ACTS ARE ALREADY IN IT.
     ROUND 8, D1/D2: this was `roomView(roomId)` — the room as the fixtures
     declare it — and the acted-on items were filtered out of ONE array on the
     way to `Pin`, `SurfaceIndicators` and the rail's footer note. `objects`,
     `railRooms(roomId)`, `trailerForRoom(view)`, the feed's tag and
     `onSelectRoom`'s prose all read the unfiltered one, so a single click left
     six surfaces on one screen disagreeing about one number.
     `sessionView` takes the register of acts and returns the room after them.
     `roomView` is not exported any more: there is no expression in this file
     whose type is the unsettled room, so the next surface added here cannot
     read the stale array by forgetting to filter it. */
  const view = useMemo(() => sessionView(roomId, actedOn), [roomId, actedOn]);
  /* A collapsed objective is a per-room fact, so it is stored per room. Leaving
     it global would carry room one's disclosure state into room two, which is
     the same "one fact, two rooms" defect one level down. */
  const [openObjectives, setOpenObjectives] = useState<Readonly<Record<string, boolean>>>({});
  const [receiptId, setReceiptId] = useState<string | null>(null);

  const objectives: readonly ObjectiveRecord[] = useMemo(
    () =>
      view.objectives.map((objective) => {
        const override = openObjectives[`${roomId}:${objective.id}`];
        return override === undefined ? objective : { ...objective, open: override };
      }),
    [view, roomId, openObjectives],
  );

  /* Every message this session has produced, ON THE SAME REGISTER as the
     fixtures. A sent row cites `local-3`; if `local-3` is not in the ledger the
     row does not render, so the consumer holding the draft is also the consumer
     holding the record — which is the shape #25 and #27 will have too. Round 5:
     the actor beside a message is looked up here, never carried on the row. */
  const [records, setRecords] = useState<readonly MessageRecord[]>(RECORDS);

  /* Sent rows belong to the room they were sent in. The RECORDS do not move —
     there is one register for the whole page, because `<AttributionLedger>`
     refuses to nest and two registers in one tree is the defect, not the
     feature. */
  const [sentIn, setSentIn] = useState<Readonly<Record<string, readonly MessageEntry[]>>>({});

  const entries: readonly TimelineEntry[] = useMemo(
    () => [...view.timeline({ seen, filter, routineOpen }), ...(sentIn[roomId] ?? [])],
    [view, roomId, seen, filter, routineOpen, sentIn],
  );

  /* THE ID IS MINTED FROM A COUNTER THIS HANDLER OWNS, NOT FROM RENDERED STATE.
     ROUND 7, D5: it was `local-${sent.length + 1}`, read out of a closure over
     `sent.length`. Two sends inside one task — `btn.click(); btn.click()`, which
     is what a fast double-press and every automated driver produce — see the
     same `sent.length`, mint `local-1` twice, and put two records under one id
     on the register. A ref is incremented when the send HAPPENS rather than when
     the page last rendered, so the id is unique per act. StrictMode's double
     render does not re-run an event handler, so it does not skip a number. */
  const minted = useRef(0);
  /* WHICH ROOM A SEND LANDS IN, read at the moment of the send rather than out
     of a closure — the same reason the id counter is a ref. A `useCallback` that
     closed over `roomId` would file a message into the room the page last
     rendered, which is the D5 shape in a different field. */
  const here = useRef('r1');
  /* AND WHICH ROOM IT SAYS IT IS IN. A sent record used to carry no `room`, and
     round 8's D3 made absence mean "wherever you happen to be looking" — so a
     message typed in #platform would have been rendered as local by every one of
     the four rooms. `MessageRecord.room` is absolute; a record minted here says
     which room it was typed in, once, at the moment it is typed. */
  const hereName = useRef(f.ROOM.name);

  const send = useCallback((text: string) => {
    const at = clock();
    minted.current += 1;
    /* A sent message is a MESSAGE RECORD first and a row second. It goes
       through `messageEntry` like every other row, so the words on screen are
       the words on the record — the same derivation that stops a caller
       handing a body that disagrees with the message it is attributed to. */
    const record: MessageRecord = {
      id: `local-${minted.current}`,
      at,
      actor: f.VIEWER.name,
      text: text.trim(),
      origin: 'typed',
      room: hereName.current,
    };
    setRecords((current) => [...current, record]);
    const row = messageEntry(record, { state: TALK, viewer: f.VIEWER.name });
    setSentIn((current) => ({
      ...current,
      [here.current]: [...(current[here.current] ?? []), row],
    }));
    setDraft('');
    setBinding(f.FREE);
    setNote(`sent at ${at} · typed, quotable, attributed to ${f.VIEWER.name}`);
  }, []);

  /* THE RECEIPT IS A RECORD THIS PAGE HANDS DOWN, NOT CONTENT IT BUILDS.
     Round 7, D3: this used to be `slot(<ReceiptView … onBack onJump onReopen/>)`,
     and a `Slot` is opaque — no enumeration in the repo could see that edge, so
     the receipt's three seams were required by nothing and deleting `onJump`
     here killed five visible controls with every gate green. `RoomFrame` builds
     the receipt now and its handlers go through `RoomFrameHandlers` like every
     other seam in the library. */
  const receipt = receiptId === null ? undefined : view.receiptFor(receiptId);

  return (
    <RoomFrame
      attention={view.attention}
      binding={binding}
      boxed={false}
      composerNote={note}
      entries={entries}
      filter={filter}
      focused={focused}
      participants={f.PARTICIPANTS}
      handlers={{
        onSelectRoom: (next: string) => {
          const chosen = sessionView(next, actedOn);
          setRoomId(next);
          here.current = next;
          hereName.current = chosen.room.name;
          /* Everything scoped to the room you were in goes with it: an open
             receipt belongs to an object in the room you left, a binding names
             an item in it, and a filter is a question about its feed. */
          setReceiptId(null);
          setBinding(chosen.binding);
          setFilter(null);
          /* The pin opens what NEEDS you; `attention[0]` is merely the first item
             the room ever owed, which after an act is not the same thing. */
          setOpenId(chosen.attention.find((item) => needsViewer(item.state))?.id);
          setNote(
            `switched to #${chosen.room.name} · ${chosen.owedCount} owed to you here, ${chosen.objects.length} objects in the lens`,
          );
        },
        onToggleObjective: (objectiveId: string) => {
          const key = `${roomId}:${objectiveId}`;
          const wasOpen = objectives.find((o) => o.id === objectiveId)?.open === true;
          setOpenObjectives((current) => ({ ...current, [key]: !wasOpen }));
          setNote(
            `${wasOpen ? 'collapsed' : 'expanded'} ${objectiveId} · a collapsed objective hides objects, so it has to be openable`,
          );
        },
        onOpenReceipt: (objectId: string) => {
          setReceiptId(objectId);
          setNote(`opened the receipt for ${objectId} · what happened, and what it rests on`);
        },
        onJumpToMessage: (messageId: string) => {
          setNote(`revealed ${messageId} · the id came off the record, not off the row`);
        },
        onCloseReceipt: () => {
          setReceiptId(null);
          setNote('back to current state · the receipt is a view, not a mode');
        },
        onReopen: (id: string) => {
          setNote(`reopened ${id} · corrections are events, not erasures`);
        },
        onRetypeToClaim: (id: string) => {
          setNote(`retyped ${id} as a claim · the prior decision stays in its correction chain`);
        },
        onShowRest: () => {
          setFocused('current-state');
          setNote(
            'the rest of the room is in Current state — the trailer counts what sits outside your list',
          );
        },
        composerValue: draft,
        onComposerChange: setDraft,
        onSend: send,
        onCancelBinding: () => {
          setBinding(f.FREE);
          setNote('binding cancelled · your next message resolves nothing on its own');
        },
        onFocusSurface: (surface: SurfaceId) => {
          setFocused(surface);
          setNote(`focused ${surface} · all three surfaces are already on screen`);
        },
        onFilter: (attentionClass: AttentionClass) => {
          const next = filter === attentionClass ? null : attentionClass;
          setFilter(next);
          setNote(
            next === null
              ? 'filter cleared · every row was on screen the whole time'
              : `filtered to ${next} · matching rows are lifted, nothing is hidden or faded`,
          );
        },
        onMarkSeen: () => {
          setSeen(true);
          setNote('marked seen · the divider mutes, it does not disappear');
        },
        onUnmarkSeen: () => {
          setSeen(false);
          setNote('unmarked · the divider is back at full weight');
        },
        onTogglePeek: () => {
          setRoutineOpen((current) => !current);
          setNote(routineOpen ? 'routine group folded' : 'routine group peeked');
        },
        onRowAction: (entryId: string, actionId: string) => {
          setNote(`${actionId} on ${entryId}`);
        },
        onOpenTag: (entryId: string) => {
          setNote(`opened the tag on ${entryId}`);
        },
        onOpenAttention: (itemId: string) => {
          setOpenId(itemId);
          setNote(`opened ${itemId} · the pin opens what needs you, hardest first`);
        },
        onAct: (itemId: string, actionId: string) => {
          setActedOn((current) => [...current, itemId]);
          setNote(`${actionId} on ${itemId} · it leaves the pin because it no longer needs you`);
        },
        onArm: (itemId: string, arming: Arming) => {
          /* The whole record, not a timestamp cut out of it: who armed it, when,
             and the hold as it was actually measured. */
          setNote(
            `armed ${arming.actionId} on ${itemId} by ${arming.actor} at ${arming.armedAt} after ${arming.heldMs}ms held`,
          );
        },
        onJumpToSource: (itemId: string, messageId: string) => {
          setNote(
            `the source of ${itemId} is ${messageId} — the id came off the record, not off the card`,
          );
        },
        onPagePin: (page: number, pageCount: number) => {
          setNote(`pin page ${page + 1} of ${pageCount} · every owed item is still reachable`);
        },
        onFoldPin: (folded: boolean) => {
          setNote(folded ? 'pin folded — the count stays in the head' : 'pin unfolded');
        },
      }}
      label="home"
      lastCheck="12:29"
      messages={records}
      objectives={objectives}
      objects={view.objects}
      openAttentionId={openId}
      receipt={receipt}
      room={view.room}
      rooms={view.rooms}
      trailer={view.trailer}
      updatedAt="13:41"
      viewer={f.VIEWER}
      /* `owedCount`, not `attention.length` — round 10, D5. The pin's array holds
         acted-on items now, so its length is the number of things that were ever
         owed here rather than the number that still are. */
    />
  );
}
