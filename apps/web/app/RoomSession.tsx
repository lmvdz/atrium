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

import { useCallback, useMemo, useState } from 'react';
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
import { messageEntry, ReceiptView, slot } from '../src/components';
import * as f from './gallery/fixtures';
import { RoomFrame } from './gallery/RoomFrame';

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
  const [sent, setSent] = useState<readonly MessageEntry[]>([]);
  /* The last thing the page did, in words, shown under the composer. Every
     handler writes here, so a control that fires nothing is visible as a
     control that says nothing — which is the failure this page exists to make
     impossible to ship again. */
  const [note, setNote] = useState('nothing is inferred from a message unless you bind it');
  /* THE STATE BEHIND THE THREE HANDLERS THE FRAME NEVER FORWARDED. Round 6's
     critic clicked all four rail room chips, both objective triangles and all
     ten object rows and measured no change to `documentElement.className`, to
     `body.innerHTML.length` or to `innerText`. The props existed on `Rail`,
     `StateLens` and `ObjectRow` the whole time; what did not exist was a
     consumer holding the state they change. */
  const [room, setRoom] = useState(f.ROOM.name);
  const [objectives, setObjectives] = useState<readonly ObjectiveRecord[]>(f.OBJECTIVES);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  const attention = useMemo(
    () => f.ATTENTION.filter((item) => !actedOn.includes(item.id)),
    [actedOn],
  );

  /* Every message this session has produced, ON THE SAME REGISTER as the
     fixtures. A sent row cites `local-3`; if `local-3` is not in the ledger the
     row does not render, so the consumer holding the draft is also the consumer
     holding the record — which is the shape #25 and #27 will have too. Round 5:
     the actor beside a message is looked up here, never carried on the row. */
  const [records, setRecords] = useState<readonly MessageRecord[]>(f.RECORDS);

  const entries: readonly TimelineEntry[] = useMemo(
    () => [...f.timeline({ seen, filter, routineOpen }), ...sent],
    [seen, filter, routineOpen, sent],
  );

  const send = useCallback(
    (text: string) => {
      const at = clock();
      /* A sent message is a MESSAGE RECORD first and a row second. It goes
         through `messageEntry` like every other row, so the words on screen are
         the words on the record — the same derivation that stops a caller
         handing a body that disagrees with the message it is attributed to. */
      const record: MessageRecord = {
        id: `local-${sent.length + 1}`,
        at,
        actor: f.VIEWER.name,
        text: text.trim(),
        origin: 'typed',
      };
      setRecords((current) => [...current, record]);
      setSent((current) => [
        ...current,
        messageEntry(record, { state: TALK, viewer: f.VIEWER.name }),
      ]);
      setDraft('');
      setBinding(f.FREE);
      setNote(`sent at ${at} · typed, quotable, attributed to ${f.VIEWER.name}`);
    },
    [sent.length],
  );

  const receipt =
    receiptId === null
      ? undefined
      : slot(
          <ReceiptView
            key={receiptId}
            onBack={() => {
              setReceiptId(null);
              setNote('back to current state · the receipt is a view, not a mode');
            }}
            onJump={(messageId: string) => {
              setNote(`jump to ${messageId} · the id came off the record, not off the row`);
            }}
            onReopen={(id: string) => {
              setNote(`reopened ${id} · corrections are events, not erasures`);
            }}
            receipt={f.receiptFor(receiptId)}
          />,
        );

  return (
    <RoomFrame
      attention={attention}
      binding={binding}
      boxed={false}
      composerNote={note}
      entries={entries}
      filtered={filter !== null}
      focused={focused}
      humans={f.HUMANS}
      handlers={{
        onSelectRoom: (roomId: string) => {
          const chosen = f.ROOMS.find((candidate) => candidate.id === roomId);
          setRoom(chosen?.name ?? f.ROOM.name);
          setNote(
            `switched to #${chosen?.name ?? roomId} · #25 owns the feed behind the switch; the frame follows it now`,
          );
        },
        onToggleObjective: (objectiveId: string) => {
          setObjectives((current) =>
            current.map((objective) =>
              objective.id === objectiveId ? { ...objective, open: !objective.open } : objective,
            ),
          );
          const wasOpen = objectives.find((o) => o.id === objectiveId)?.open === true;
          setNote(
            `${wasOpen ? 'collapsed' : 'expanded'} ${objectiveId} · a collapsed objective hides objects, so it has to be openable`,
          );
        },
        onOpenReceipt: (objectId: string) => {
          setReceiptId(objectId);
          setNote(`opened the receipt for ${objectId} · what happened, and what it rests on`);
        },
        onJumpToMessage: (messageId: string) => {
          setNote(`revealed ${messageId} · the trace resolved it against this room's register`);
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
      objects={f.OBJECTS}
      openAttentionId={openId}
      receipt={receipt}
      room={{ ...f.ROOM, name: room }}
      rooms={f.ROOMS}
      trailer={f.TRAILER}
      updatedAt="13:41"
      viewer={f.VIEWER}
      viewerNote={`here · ${attention.length} owed to you`}
    />
  );
}
