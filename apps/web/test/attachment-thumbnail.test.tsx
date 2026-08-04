import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  /* CATCHES: keeping preview and download as one ambiguous filename button,
     which makes an inspection click unexpectedly leave the application. */
  it('offers separate preview and download controls', () => {
    const opened: string[] = [];
    const downloaded: string[] = [];
    const entry = messageEntry(imageMessage, {
      state: { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false },
    });
    renderWith(
      [imageMessage],
      <TimelineRow
        entry={entry}
        onDownloadAttachment={(_messageId, attachment) => downloaded.push(attachment.key)}
        onOpenAttachment={(_messageId, attachment) => opened.push(attachment.key)}
      />,
      'general',
    );
    screen.getByRole('button', { name: 'Preview capture.png' }).click();
    expect(opened).toEqual(['general/capture.png']);
    expect(downloaded).toEqual([]);
    screen.getByRole('button', { name: 'Download capture.png' }).click();
    expect(downloaded).toEqual(['general/capture.png']);
  });

  /* CATCHES: presigning every historical image at route load, which spends an
     authorization request on attachments the reader never scrolls near. */
  it('requests an image thumbnail only when its card approaches the viewport', async () => {
    let reveal: ((entries: IntersectionObserverEntry[]) => void) | undefined;
    class Observer {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        reveal = callback;
      }
      disconnect() {}
      observe() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = '120px';
      readonly thresholds = [0];
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const load = vi.fn(async () => 'https://objects.invalid/lazy-capture');
    const entry = messageEntry(imageMessage, {
      state: { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false },
    });
    const { container } = renderWith(
      [imageMessage],
      <TimelineRow entry={entry} loadAttachmentPreviewUrl={load} />,
      'general',
    );
    expect(load).not.toHaveBeenCalled();
    reveal?.([{ isIntersecting: true } as IntersectionObserverEntry]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-sent-attachment-thumbnail]')).not.toBeNull(),
    );
  });
});
