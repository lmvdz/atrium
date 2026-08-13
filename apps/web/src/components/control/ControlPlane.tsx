'use client';

/* ---------------------------------------------------------------------------
 * The control plane — the visible face of the room's work (#121).
 *
 * Projection-first over #116–119: the htop room PIN (filtered to what needs a
 * human), the agent→plan→session TREE (status glyphs), the three SURFACES
 * (decisions / unseen / cost), and a session REVIEW pane whose land is gated on
 * a formal human hold-to-arm. This component only ARRANGES the projection the
 * server loaded and derives the owed/cost sets; every glyph is derived in
 * state.ts, every count reads off the set its list renders.
 * ------------------------------------------------------------------------- */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { ArmOutcome, CertifyOutcome } from '@/lib/certify-session';
import type { ControlPlaneData, ControlSessionRow } from '@/lib/control-plane-data';
import type { ParticipantKind } from '../model/kind';
import { systemText } from '../model/quotation';
import { ControlPin, type ControlPinItem } from './ControlPin';
import { ControlSurfaces, type CostPlanLine, type SurfaceLine } from './ControlSurfaces';
import styles from './control.module.css';
import { ProcessTree } from './ProcessTree';
import { ReviewPane } from './ReviewPane';
import {
  decisionLabel,
  decisionState,
  formatMicros,
  planCost,
  sessionAwaitsLanding,
  sessionState,
} from './state';

export interface ControlPlaneProps {
  readonly data: ControlPlaneData;
  readonly viewerId: string;
  readonly viewerKind: ParticipantKind | 'unknown';
  readonly workspaceSlug: string;
  readonly roomSlug: string;
  /**
   * STEP ONE of the human-only certify, as a Server Action. Fired when the hold
   * BEGINS, so the interval the server later measures is the one the person
   * actually held. It carries no timing — that is the whole point (CS-2).
   */
  readonly armAction: (input: {
    sessionId: string;
    workspaceSlug: string;
    roomSlug: string;
  }) => Promise<ArmOutcome>;
  /** STEP TWO. Fired when the hold completes; the server measures its own clock. */
  readonly certifyAction: (input: {
    sessionId: string;
    workspaceSlug: string;
    roomSlug: string;
  }) => Promise<CertifyOutcome>;
}

/** A recent lifecycle event as one calm sentence. */
function eventLine(type: string, actorKind: string): string {
  const who = actorKind === 'human' ? 'a person' : actorKind === 'agent' ? 'an agent' : actorKind;
  switch (type) {
    case 'plan_opened':
      return `${who} opened a plan`;
    case 'plan_settled':
      return `a plan settled`;
    case 'session_opened':
      return `${who} opened a session`;
    case 'session_settled':
      return `a session settled`;
    case 'session_failed':
      return `a session failed`;
    case 'signal_raised':
      return `${who} raised a signal`;
    case 'plan_rlimit_set':
      return `${who} funded a plan`;
    case 'draw_refused':
      return `a draw was refused — a plan's slice is spent`;
    default:
      return type;
  }
}

function certifyErrorText(reason: string): string {
  switch (reason) {
    case 'not_human':
      return 'a session is certified only by a human — the server refused this identity';
    case 'not_in_room':
      return 'this session is not in a room you can open';
    case 'not_settled':
      return 'a session is certified once it has settled';
    case 'already_certified':
      return 'this session has already been certified, and a certification is written once';
    case 'not_armed':
      return 'the server recorded no hold for this session — press and hold the control itself';
    case 'held_too_short':
      return 'the hold was shorter than the server requires — press and hold until the meter fills';
    case 'arm_expired':
      return 'that hold went stale — press and hold again';
    default:
      return 'the certification could not be recorded';
  }
}

export function ControlPlane({
  data,
  viewerId,
  viewerKind,
  workspaceSlug,
  roomSlug,
  armAction,
  certifyAction,
}: ControlPlaneProps) {
  const router = useRouter();
  const [openSessionId, setOpenSessionId] = useState<string | undefined>(undefined);
  const [certifyError, setCertifyError] = useState<string | null>(null);

  // A flat index of every session with its plan + agent, so the pin and the
  // review pane resolve one by id without re-walking the tree each render.
  const index = useMemo(() => {
    const map = new Map<
      string,
      { session: ControlSessionRow; planTitle: string; agentName: string }
    >();
    for (const agent of data.agents) {
      for (const plan of agent.plans) {
        for (const session of plan.sessions) {
          map.set(session.id, {
            session,
            planTitle: plan.title,
            agentName: agent.name,
          });
        }
      }
    }
    return map;
  }, [data.agents]);

  const allSessions = useMemo(() => [...index.values()], [index]);

  /* WHAT THE PIN AND THE DECISIONS SURFACE ARE ABOUT: the items addressed to
     THIS reader. The room's other pending items belong to the people they name,
     and rendering them under a second-person label was the surface lying. Both
     consumers read this one array, so the count cannot drift from the list. */
  const owedDecisions = useMemo(
    () => data.decisions.filter((decision) => decision.owedToViewer),
    [data.decisions],
  );

  // The PIN: only what needs a human. Failed sessions and settled-awaiting-landing
  // sessions from the tree, plus the room's owed decisions. Order is derived in
  // ControlPin from the glyph, so the failed session floats to the top.
  const pinItems = useMemo<ControlPinItem[]>(() => {
    const items: ControlPinItem[] = [];
    for (const { session, planTitle } of allSessions) {
      if (session.status === 'failed') {
        items.push({
          id: session.id,
          state: sessionState(session),
          title: `${session.model} failed`,
          detail: session.exitSummary ?? 'the session exited without a clean receipt',
          meta: planTitle,
          onOpen: () => setOpenSessionId(session.id),
        });
      } else if (sessionAwaitsLanding(session)) {
        items.push({
          id: session.id,
          state: sessionState(session),
          title: `certify ${session.model}`,
          detail:
            session.artifact?.diffStat ??
            (session.artifact?.branch
              ? `on ${session.artifact.branch}`
              : 'settled, awaiting a human'),
          meta: planTitle,
          onOpen: () => setOpenSessionId(session.id),
        });
      }
    }
    for (const decision of owedDecisions) {
      items.push({
        id: decision.id,
        state: decisionState(decision),
        title: decisionLabel(decision.class),
        detail: `${decision.subjectKind} · owed`,
        meta: '',
      });
    }
    return items;
  }, [allSessions, owedDecisions]);

  // The three surfaces.
  const decisionsLines: SurfaceLine[] = [
    ...allSessions
      .filter((entry) => sessionAwaitsLanding(entry.session))
      .map((entry) => ({
        id: `certify:${entry.session.id}`,
        state: sessionState(entry.session),
        text: `certify ${entry.session.model} · ${entry.planTitle}`,
      })),
    ...owedDecisions.map((decision) => ({
      id: decision.id,
      state: decisionState(decision),
      text: decisionLabel(decision.class),
    })),
  ];
  const decisionsCount = decisionsLines.length;

  const unseenLines: SurfaceLine[] = data.unseen.map((event) => ({
    id: event.id,
    text: eventLine(event.type, event.actorKind),
  }));

  const costPlans: CostPlanLine[] = [];
  for (const agent of data.agents) {
    for (const plan of agent.plans) {
      const cost = planCost(plan);
      const ceiling = cost.draws.ceiling;
      const fill =
        ceiling === null
          ? cost.draws.used > 0
            ? 1
            : 0
          : ceiling === 0
            ? cost.draws.used > 0
              ? 1
              : 0
            : cost.draws.used / ceiling;
      costPlans.push({
        id: plan.id,
        title: plan.title,
        drawsLabel:
          ceiling === null
            ? `${cost.draws.used} draws · unfunded`
            : `${cost.draws.used}/${ceiling} draws`,
        dollarsLabel:
          plan.budgetLimitMicros === null
            ? `${formatMicros(plan.spentMicros)} spent`
            : `${formatMicros(plan.spentMicros)} / ${formatMicros(plan.budgetLimitMicros)}`,
        warn: cost.warn,
        fill,
      });
    }
  }
  const costWarn = costPlans.some((plan) => plan.warn);

  const open = openSessionId === undefined ? null : (index.get(openSessionId) ?? null);

  /* ARM at the START of the hold. The `Arming` record the control produces is
     still the local receipt of who pressed and for how long — it is just no
     longer EVIDENCE, and none of it is sent. What the server gates on is the
     interval between its own clock at this call and its own clock at the confirm
     below, which is why this fires on hold-begin and not on hold-complete. */
  const onArm = (sessionId: string) => {
    setCertifyError(null);
    void armAction({ sessionId, workspaceSlug, roomSlug }).then((outcome) => {
      if (!outcome.ok) setCertifyError(certifyErrorText(outcome.reason));
    });
  };

  const onCertify = (sessionId: string) => {
    void certifyAction({ sessionId, workspaceSlug, roomSlug }).then((outcome) => {
      if (outcome.ok) {
        router.refresh();
      } else {
        setCertifyError(certifyErrorText(outcome.reason));
      }
    });
  };

  return (
    <main className={styles.page} data-frame="control" data-room-id={data.room.id}>
      <header className={styles.head}>
        <span className={styles.headMark} aria-hidden="true">
          ▚
        </span>
        <span className={styles.headRoom}>#{systemText(data.room.name, 'ControlPlane room')}</span>
        <span className="atr-lbl" style={{ color: 'var(--tx2)' }}>
          CONTROL
        </span>
        <span className={styles.headSpacer} />
        <Link className={styles.headLink} href={`/app/${workspaceSlug}/${roomSlug}`}>
          conversation →
        </Link>
      </header>

      <div className={styles.body}>
        <div className={styles.left}>
          <ControlPin items={pinItems} openId={openSessionId} />
          <ControlSurfaces
            cost={{ warn: costWarn, plans: costPlans }}
            decisions={{ count: decisionsCount, lines: decisionsLines }}
            unseen={{ count: data.unseen.length, lines: unseenLines }}
          />
          <ProcessTree
            agents={data.agents}
            onOpenSession={setOpenSessionId}
            openSessionId={openSessionId}
          />
        </div>
        <div className={styles.right}>
          <div className={styles.rightSticky}>
            <ReviewPane
              agentName={open?.agentName ?? null}
              certifyError={certifyError}
              onArm={onArm}
              onCertify={onCertify}
              planTitle={open?.planTitle ?? null}
              session={open?.session ?? null}
              viewerId={viewerId}
              viewerKind={viewerKind}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
