import type {
  ContextualReferenceAttention,
  ReferenceAttentionLocation,
} from '../src/components/model/records';
import type { ReplayData } from './replay-data';

/**
 * Place direct references using persisted provenance only. Display text,
 * timestamps, visual proximity and the current open objective are deliberately
 * absent from this function's inputs, so none can become an accidental filing
 * rule.
 */
export function contextualReferenceAttention(
  data: ReplayData,
  viewerId: string | undefined,
): readonly ContextualReferenceAttention[] {
  const resolvedViewerId = data.participants.find((participant) => participant.id === viewerId)?.id;
  if (resolvedViewerId === undefined) return [];

  const pending = data.attention.filter(
    (item) =>
      item.userId === resolvedViewerId &&
      item.status === 'pending' &&
      item.subjectKind === 'message' &&
      item.reason.kind === 'mention',
  );

  return pending.flatMap((item) => {
    const locations = new Map<string, ReferenceAttentionLocation>();
    const addObject = (object: ReplayData['objects'][number]) => {
      const location: ReferenceAttentionLocation =
        object.type === 'objective'
          ? { kind: 'objective', id: object.id }
          : { kind: 'object', id: object.id };
      locations.set(`${location.kind}:${location.id}`, location);
    };
    const addProposal = (proposal: ReplayData['proposals'][number]) => {
      const accepted = data.objects.find((object) => object.proposalId === proposal.id);
      if (accepted !== undefined) {
        addObject(accepted);
        return;
      }
      const location: ReferenceAttentionLocation =
        proposal.type === 'objective'
          ? { kind: 'objective', id: proposal.id }
          : { kind: 'object', id: proposal.id };
      locations.set(`${location.kind}:${location.id}`, location);
    };

    for (const source of data.objectSources) {
      if (source.messageId !== item.subjectId) continue;
      const object = data.objects.find((candidate) => candidate.id === source.objectId);
      if (object !== undefined) addObject(object);
    }
    for (const source of data.proposalSources) {
      if (source.messageId !== item.subjectId) continue;
      const proposal = data.proposals.find((candidate) => candidate.id === source.proposalId);
      if (proposal !== undefined) addProposal(proposal);
    }

    if (locations.size === 0) locations.set('conversation', { kind: 'conversation', id: null });
    return [...locations.values()].map((location) => ({
      attentionId: item.id,
      messageId: item.subjectId,
      location,
    }));
  });
}
