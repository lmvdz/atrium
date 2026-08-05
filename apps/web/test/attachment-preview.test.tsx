import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentPreview } from '../src/components';
import type { MessageAttachmentRecord } from '../src/components/model/quotation';

const image: MessageAttachmentRecord = {
  key: 'room/capture.png',
  name: 'capture.png',
  contentType: 'image/png',
  size: 2048,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('attachment preview', () => {
  /* CATCHES: opening the signed object URL directly, which provides no dialog,
     no metadata, no keyboard dismissal, and no focus route back to the source. */
  it('opens an accessible image dialog and restores focus after Escape', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(
      <AttachmentPreview
        attachment={image}
        loadUrl={async () => 'https://objects.invalid/capture-one'}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Preview capture.png' })).toBeDefined();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close attachment preview' }),
    );
    expect(screen.getByText('image/png · 2 KB')).toBeDefined();
    await screen.findByRole('img', { name: 'capture.png' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  /* CATCHES: declaring aria-modal while Tab can leave the dialog and reach the
     obscured room controls behind it. */
  it('keeps keyboard focus inside the modal', async () => {
    render(
      <AttachmentPreview
        attachment={image}
        loadUrl={async () => 'https://objects.invalid/capture-one'}
        onClose={() => undefined}
      />,
    );
    const close = screen.getByRole('button', { name: 'Close attachment preview' });
    const actualSize = screen.getByRole('button', { name: 'actual size' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(actualSize);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  /* CATCHES: painting a backdrop affordance whose click never closes the
     preview, leaving pointer users dependent on the header control. */
  it('closes from the backdrop', () => {
    const onClose = vi.fn();
    render(
      <AttachmentPreview
        attachment={image}
        loadUrl={async () => 'https://objects.invalid/capture-one'}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close preview backdrop' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /* CATCHES: caching an expired presigned URL forever; an image error must ask
     the authorization route for a fresh URL without mutating the attachment. */
  it('refreshes an expired image URL once', async () => {
    const loadUrl = vi
      .fn<(attachment: MessageAttachmentRecord) => Promise<string>>()
      .mockResolvedValueOnce('https://objects.invalid/expired')
      .mockResolvedValueOnce('https://objects.invalid/fresh');
    render(<AttachmentPreview attachment={image} loadUrl={loadUrl} onClose={() => undefined} />);
    const rendered = await screen.findByRole('img', { name: 'capture.png' });
    expect(rendered.getAttribute('src')).toContain('expired');
    fireEvent.error(rendered);
    await waitFor(() => expect(loadUrl).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole('img', { name: 'capture.png' })).getAttribute('src')).toContain(
      'fresh',
    );
  });

  /* CATCHES: making the only click target both preview and download; the
     explicit download action must acquire a fresh URL and name the original. */
  it('downloads through a distinct icon using a fresh authorization', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const loadUrl = vi.fn(async () => 'https://objects.invalid/fresh-download');
    render(<AttachmentPreview attachment={image} loadUrl={loadUrl} onClose={() => undefined} />);
    await screen.findByRole('img', { name: 'capture.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Download capture.png' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(loadUrl).toHaveBeenCalledTimes(2);
  });

  /* CATCHES: centering an oversized image in a flex scroller, which puts its
     top/left overflow before scroll origin and makes those pixels unreachable. */
  it('makes actual size a zoomable, draggable scroll canvas', async () => {
    const { container } = render(
      <AttachmentPreview
        attachment={image}
        loadUrl={async () => 'https://objects.invalid/capture-one'}
        onClose={() => undefined}
      />,
    );
    const rendered = await screen.findByRole('img', { name: 'capture.png' });
    fireEvent.click(screen.getByRole('button', { name: 'actual size' }));
    const stage = container.querySelector('[data-preview-mode="actual"]') as HTMLDivElement;
    expect(stage).toBeDefined();
    expect(rendered.style.width).toBe('1600px');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeDefined();
    expect(rendered.style.width).toBe('2000px');

    stage.scrollLeft = 300;
    stage.scrollTop = 200;
    const pointer = (type: string, values: Record<string, number>) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(
        event,
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, { configurable: true, value }]),
        ),
      );
      fireEvent(stage, event);
    };
    pointer('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    pointer('pointermove', { clientX: 60, clientY: 70, pointerId: 1 });
    expect(stage.scrollLeft).toBe(340);
    expect(stage.scrollTop).toBe(230);
    pointer('pointerup', { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'fit to window' }));
    expect(container.querySelector('[data-preview-mode="fit"]')).toBeDefined();
  });

  /* CATCHES: treating every attachment as an image and leaving other files
     with a broken image element instead of an honest open/download treatment. */
  it('gives a non-image an explicit download fallback', async () => {
    render(
      <AttachmentPreview
        attachment={{ ...image, name: 'notes.pdf', contentType: 'application/pdf' }}
        loadUrl={async () => 'https://objects.invalid/notes'}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText('This file has no inline preview.')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /download/i })).toHaveLength(2);
  });
});
