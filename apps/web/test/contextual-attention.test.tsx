import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StateLens } from '../src/components';
import type {
  ContextualReferenceAttention,
  ObjectiveRecord,
  StateObject,
} from '../src/components/model/records';

afterEach(cleanup);

const objectives: ObjectiveRecord[] = [
  { id: 'objective-one', title: 'Ship the preview', status: 'active', open: true },
];
const objects: StateObject[] = [
  {
    id: 'decision-one',
    kind: 'decision',
    state: {
      kind: 'decision',
      verification: 'accepted',
      owedToViewer: false,
      irreversible: false,
    },
    text: 'Use the durable source edge.',
    facts: [],
    objectives: ['objective-one'],
  },
];

describe('contextual reference markers', () => {
  /* CATCHES: collapsing every direct reference into one global Needs-you card
     instead of preserving its persisted objective, object, or conversation location. */
  it('renders each provenance-derived location on its corresponding row', () => {
    const references: ContextualReferenceAttention[] = [
      {
        attentionId: 'conversation-attention',
        messageId: 'message-unfiled',
        location: { kind: 'conversation', id: null },
      },
      {
        attentionId: 'objective-attention',
        messageId: 'message-objective',
        location: { kind: 'objective', id: 'objective-one' },
      },
      {
        attentionId: 'object-attention-a',
        messageId: 'message-object',
        location: { kind: 'object', id: 'decision-one' },
      },
      {
        attentionId: 'object-attention-b',
        messageId: 'message-object',
        location: { kind: 'object', id: 'decision-one' },
      },
    ];
    const opened: Array<{ ids: readonly string[]; messageId: string }> = [];
    const { container } = render(
      <StateLens
        objectives={objectives}
        objects={objects}
        onOpenReferences={(ids, messageId) => opened.push({ ids, messageId })}
        referenceAttention={references}
        roomName="general"
        updatedAt="12:00"
      />,
    );

    const conversation = container.querySelector('[data-reference-location="conversation"]');
    expect(conversation).not.toBeNull();
    expect(
      within(conversation as HTMLElement).getByRole('button', {
        name: 'Open 1 direct reference in its message',
      }),
    ).toBeDefined();
    const objective = container.querySelector('[data-objective-id="objective-one"]');
    expect(
      within(objective as HTMLElement).getByRole('button', {
        name: 'Open 1 direct reference in its message',
      }),
    ).toBeDefined();
    const object = container.querySelector('[data-object-id="decision-one"]')?.parentElement;
    const aggregate = within(object as HTMLElement).getByRole('button', {
      name: 'Open 2 direct references in its message',
    });
    expect(aggregate.textContent).toBe('2');
    fireEvent.click(aggregate);
    expect(opened).toEqual([
      { ids: ['object-attention-a', 'object-attention-b'], messageId: 'message-object' },
    ]);
  });

  /* CATCHES: rendering a marker whose location id merely resembles a row id;
     only exact typed location matches may enter that row. */
  it('does not attach an unrelated reference to the first objective', () => {
    render(
      <StateLens
        objectives={objectives}
        objects={objects}
        referenceAttention={[
          {
            attentionId: 'elsewhere',
            messageId: 'message-elsewhere',
            location: { kind: 'objective', id: 'objective-two' },
          },
        ]}
        roomName="general"
        updatedAt="12:00"
      />,
    );
    expect(screen.queryByRole('button', { name: /direct reference/i })).toBeNull();
  });
});
