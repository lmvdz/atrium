'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageAttachmentRecord } from '../model/quotation';
import styles from './attachment-preview.module.css';

export interface AttachmentPreviewProps {
  readonly attachment: MessageAttachmentRecord;
  readonly loadUrl: (attachment: MessageAttachmentRecord) => Promise<string>;
  readonly onClose: () => void;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Ephemeral authorization stays outside the attachment record. Opening and an
 * image load failure both ask the route for a fresh URL, so an expired grant is
 * recoverable without changing the durable attachment or the authored message.
 */
export function AttachmentPreview({ attachment, loadUrl, onClose }: AttachmentPreviewProps) {
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [actualSize, setActualSize] = useState(false);
  const [generation, setGeneration] = useState(0);
  const retried = useRef(false);

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', keyDown);
    return () => {
      window.removeEventListener('keydown', keyDown);
      opener.current?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    void generation;
    let current = true;
    setUrl(undefined);
    setError(undefined);
    void loadUrl(attachment)
      .then((next) => {
        if (current) setUrl(next);
      })
      .catch((failure: unknown) => {
        if (current) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      current = false;
    };
  }, [attachment, generation, loadUrl]);

  const download = useCallback(() => {
    void loadUrl(attachment)
      .then((freshUrl) => {
        const anchor = document.createElement('a');
        anchor.href = freshUrl;
        anchor.download = attachment.name;
        anchor.rel = 'noopener';
        anchor.click();
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      );
  }, [attachment, loadUrl]);

  const isImage = attachment.contentType.startsWith('image/');
  return (
    <div className={styles.backdrop} data-attachment-preview="true">
      <button
        aria-label="Close preview backdrop"
        className={styles.backdropDismiss}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-label={`Preview ${attachment.name}`}
        aria-modal="true"
        className={styles.dialog}
        role="dialog"
      >
        <header className={styles.header}>
          <span className={styles.name}>{attachment.name}</span>
          <span className={styles.meta}>
            {attachment.contentType} · {formatBytes(attachment.size)}
          </span>
          {isImage ? (
            <button
              aria-pressed={actualSize}
              className={styles.action}
              onClick={() => setActualSize((current) => !current)}
              type="button"
            >
              {actualSize ? 'fit to window' : 'actual size'}
            </button>
          ) : null}
          <button
            aria-label={`Download ${attachment.name}`}
            className={styles.icon}
            onClick={download}
            title="download original"
            type="button"
          >
            <svg aria-hidden="true" fill="none" height="15" viewBox="0 0 24 24" width="15">
              <path
                d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </svg>
          </button>
          <button
            aria-label="Close attachment preview"
            className={styles.icon}
            onClick={onClose}
            ref={close}
            type="button"
          >
            <svg aria-hidden="true" fill="none" height="15" viewBox="0 0 24 24" width="15">
              <path
                d="m6 6 12 12M18 6 6 18"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </svg>
          </button>
        </header>
        <div className={styles.stage}>
          {error !== undefined ? (
            <div className={styles.fallback} role="alert">
              <span>{error}</span>
              <button onClick={() => setGeneration((current) => current + 1)} type="button">
                retry preview
              </button>
            </div>
          ) : url === undefined ? (
            <span aria-live="polite" className={styles.loading}>
              loading preview…
            </span>
          ) : isImage ? (
            <Image
              alt={attachment.name}
              className={actualSize ? styles.actual : styles.fit}
              height={1200}
              onError={() => {
                if (retried.current) {
                  setError('the preview URL expired; retry to request another');
                  return;
                }
                retried.current = true;
                setGeneration((current) => current + 1);
              }}
              priority
              src={url}
              unoptimized
              width={1600}
            />
          ) : (
            <div className={styles.fallback}>
              <span>This file has no inline preview.</span>
              <button onClick={download} type="button">
                download original
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
