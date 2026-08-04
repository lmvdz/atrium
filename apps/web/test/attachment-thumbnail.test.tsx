import { describe, expect, it } from 'vitest';
import { messageEntry, TimelineRow } from '../src/components';
import type { MessageRecord } from '../src/components/model/quotation';
import { renderWith } from './harness';

const imageMessage: MessageRecord = {
  id: 'image-message',
  actor: 'lars',
  at: '12:00',
  origin: 'typed',
  room: 'general',
  text: 'Latest interface capture.',
  attachments: [
    {
      key: 'general/capture.png',
      name: 'capture.png',
      contentType: 'image/png',
      size: 2048,
    },
  ],
};

describe('sent attachment presentation', () => {
  /* CATCHES: keeping image metadata on the persisted message while flattening
     its live presentation back into the same generic filename button as every
     other attachment. The URL stays outside the attribution record because it
     is an expiring authorization, not something the person authored. */
  it('renders an authorized image thumbnail without adding the URL to the record', () => {
    const entry = messageEntry(imageMessage, {
      state: {
        kind: 'event',
        verification: 'routine',
        owedToViewer: false,
        irreversible: false,
      },
    });
    const { container } = renderWith(
      [imageMessage],
      <TimelineRow
        attachmentPreviewUrl={(messageId, attachment) =>
          messageId === imageMessage.id && attachment.key === 'general/capture.png'
            ? 'https://objects.invalid/signed-capture.png'
            : undefined
        }
        entry={entry}
      />,
      'general',
    );
    const thumbnail = container.querySelector('[data-sent-attachment-thumbnail]');
    expect(thumbnail?.getAttribute('src')).toContain('signed-capture.png');
    expect(container.textContent).toContain('capture.png');
    expect(JSON.stringify(imageMessage)).not.toContain('signed-capture.png');
  });
});
