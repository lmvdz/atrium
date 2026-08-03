export type Participant = 0 | 1 | 2 | 3 | 4;

export interface ScenarioMessage {
  seq: number;
  author: Participant;
  body: string;
  clientMessageId: string;
  semantic: 'objective' | 'decision' | 'commitment' | 'open_question' | 'claim' | null;
  attachment: boolean;
}

export interface MultiplayerManifest {
  messages: ScenarioMessage[];
  absentee: Participant;
  disconnected: Participant;
  absence: { after: number; through: number };
  disconnect: { after: number; through: number };
}

/**
 * Exact ground truth for #27's five-participant acceptance run.
 *
 * The semantic lines use the deterministic acceptance provider's visibly
 * synthetic, whole-line forms. Every rendered statement therefore remains the
 * participant's exact authored text; the fixture never asks the provider to
 * paraphrase somebody's speech.
 */
export function multiplayerManifest(
  runId: string,
  userIds: readonly string[],
): MultiplayerManifest {
  if (userIds.length !== 5)
    throw new Error(`the multiplayer manifest needs five users, got ${userIds.length}`);
  const messages: ScenarioMessage[] = [];
  for (let seq = 1; seq <= 200; seq += 1) {
    const author = authorFor(seq);
    let body = `Run ${runId} message ${seq}: ordinary project discussion.`;
    let semantic: ScenarioMessage['semantic'] = null;
    if (seq === 5) {
      body = `Objective: Run ${runId} ship reconnect correctness.`;
      semantic = 'objective';
    } else if (seq === 25) {
      body = `Objective: Run ${runId} preserve trustworthy receipts.`;
      semantic = 'objective';
    } else if (seq === 41) {
      body = `Commitment for ${userIds[4]}: Run ${runId} review the reconnect trace.`;
      semantic = 'commitment';
    } else if (seq === 60) {
      body = `Decision: Run ${runId} reconnect from the durable cursor.`;
      semantic = 'decision';
    } else if (seq === 75) {
      body = `Open question: Run ${runId} which trace proves ordered catch-up?`;
      semantic = 'open_question';
    } else if (seq === 90) {
      body = `Claim: Run ${runId} the first reconnect trace contains every committed message.`;
      semantic = 'claim';
    } else if (seq === 110) {
      body = `Decision: Run ${runId} keep the missed window frozen at return.`;
      semantic = 'decision';
    } else if (seq === 130) {
      body = `Claim: Run ${runId} the second trace preserves message order.`;
      semantic = 'claim';
    } else if (seq === 145) {
      body = `Run ${runId} message 145 carries the attachment receipt.`;
    }
    messages.push({
      seq,
      author,
      body,
      clientMessageId: `${runId}-message-${seq}`,
      semantic,
      attachment: seq === 145,
    });
  }
  return {
    messages,
    absentee: 4,
    disconnected: 3,
    absence: { after: 40, through: 160 },
    disconnect: { after: 170, through: 180 },
  };
}

function authorFor(seq: number): Participant {
  // Participant 4 is absent for exactly 41..160. Everyone authors before and
  // after that interval, so presence cannot be inferred from message authors.
  if (seq > 40 && seq <= 160) return ((seq - 41) % 4) as Participant;
  // Participant 3's production client is offline for this exact interval; the
  // other four keep writing so its reconnect has ten rows to recover.
  if (seq > 170 && seq <= 180) return [0, 1, 2, 4][(seq - 171) % 4] as Participant;
  return ((seq - 1) % 5) as Participant;
}
