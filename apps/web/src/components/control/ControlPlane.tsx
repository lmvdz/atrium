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
import type { ArmOutcome, CertifyOutcome, DisarmOutcome } from '@/lib/certify-session';
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
   * BEGINS, so the server stamps the start of the interval it later measures. It
   * carries no timing — that is the whole point (CS-2). The interval is a
   * minimum-delay between two deliberate server calls, not a proof of a continuous
   * physical hold (see certify-session.ts's honesty note).
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
  /**
   * CANCELLATION. Fired when the hold is released before it completes, so the
   * server can clear the arm it stamped on begin. Without it a released hold left
   * a live arm for its whole TTL, and a later direct confirm certified (CS-3).
   */
  readonly disarmAction: (input: {
    sessionId: string;
    workspaceSlug: string;
    roomSlug: string;
  }) => Promise<DisarmOutcome>;
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
    case 'no_artifact':
      return 'this session produced no artifact to review — there is nothing to certify';
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
  disarmAction,
}: ControlPlaneProps) {
  const router = useRouter();
  const [openSessionId, setOpenSessionId] = useState<string | undefined>(undefined);
  const [certifyError, setCertifyError] = useState<string | null>(null);

  /* WHO IS OWED. A failed session and an unlanded artifact are owed to any HUMAN
     — certifying is a human-only act — so an agent-principal viewer must not be
     told "needs you" for one. Allowlist the compliant form: only `'human'` is
     owed; `'agent'` and the fail-closed `'unknown'` are not. Every owed
     derivation below (pin, decisions surface) reads this one answer. */
  const viewerIsHuman = viewerKind === 'human';

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
  //
  // GATED ON THE VIEWER BEING HUMAN. A failed session and an unlanded artifact are
  // owed to a HUMAN — certifying is a human-only act — so an agent-principal viewer
  // is owed NEITHER: the same answer `sessionState`'s `owedToViewer` already
  // derives per glyph (state.ts), applied here to MEMBERSHIP so the pin row and the
  // decisions line disappear for a non-human viewer, not merely lose their colour.
  // Round 3 gated the glyph but left these two collections unconditional, so an
  // agent still read the item under NEEDS YOU and in the decisions count. `viewerIsHuman`
  // is the allowlist of the compliant form (`=== 'human'`); an agent or a
  // fail-closed `'unknown'` kind is not owed the session work at all.
  const pinItems = useMemo<ControlPinItem[]>(() => {
    const items: ControlPinItem[] = [];
    for (const { session, planTitle } of allSessions) {
      // A non-human viewer is owed no session certification; skip the room's
      // failed and awaits-landing sessions entirely for them.
      if (!viewerIsHuman) continue;
      if (session.status === 'failed') {
        items.push({
          id: session.id,
          state: sessionState(session, viewerIsHuman),
          title: `${session.model} failed`,
          detail: session.exitSummary ?? 'the session exited without a clean receipt',
          meta: planTitle,
          onOpen: () => setOpenSessionId(session.id),
        });
      } else if (sessionAwaitsLanding(session)) {
        items.push({
          id: session.id,
          state: sessionState(session, viewerIsHuman),
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
  }, [allSessions, owedDecisions, viewerIsHuman]);

  // The three surfaces. The certify lines are the SAME session work the pin
  // filters, and they are owed to a human too — so they are gated on the viewer
  // being human, exactly as the pin membership is. An agent-principal viewer sees
  // only the room's owed decisions here (already per-viewer filtered), and the
  // count reads off the list it renders, so it cannot drift back to a room fact.
  const decisionsLines: SurfaceLine[] = [
    ...(viewerIsHuman ? allSessions : [])
      .filter((entry) => sessionAwaitsLanding(entry.session))
      .map((entry) => ({
        id: `certify:${entry.session.id}`,
        state: sessionState(entry.session, viewerIsHuman),
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

  /* DISARM on cancel. The control fires this when a hold is released before it
     completes, so the server clears the arm it stamped on begin — a cancelled
     hold must not leave a live arm a later confirm could spend (CS-3). Fire and
     forget: a failed disarm is harmless (the arm's TTL and the confirm gate still
     hold), and surfacing an error for a release the person already walked away
     from would be noise. */
  const onDisarm = (sessionId: string) => {
    void disarmAction({ sessionId, workspaceSlug, roomSlug });
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
            viewerIsHuman={viewerIsHuman}
          />
        </div>
        <div className={styles.right}>
          <div className={styles.rightSticky}>
            <ReviewPane
              agentName={open?.agentName ?? null}
              certifyError={certifyError}
              onArm={onArm}
              onCertify={onCertify}
              onDisarm={onDisarm}
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
