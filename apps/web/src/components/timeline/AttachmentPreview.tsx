'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageAttachmentRecord } from '../model/quotation';
import { systemText } from '../model/quotation';
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
  const dialog = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [actualSize, setActualSize] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [imageSize, setImageSize] = useState({ width: 1600, height: 1200 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [generation, setGeneration] = useState(0);
  const retried = useRef(false);

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>('button, [href]') ?? []),
      ].filter((control) => !control.hasAttribute('disabled') && control.tabIndex >= 0);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
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
  const name = systemText(attachment.name, 'AttachmentPreview name');
  const contentType = systemText(attachment.contentType, 'AttachmentPreview contentType');
  const setScale = (next: number) => setZoom(Math.min(4, Math.max(0.25, next)));
  const toggleActualSize = () => {
    setActualSize((current) => {
      const next = !current;
      if (next) {
        setZoom(1);
        requestAnimationFrame(() => {
          const viewport = stage.current;
          if (viewport === null) return;
          viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
          viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
        });
      }
      return next;
    });
  };
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
        aria-label={`Preview ${name}`}
        aria-modal="true"
        className={styles.dialog}
        ref={dialog}
        role="dialog"
      >
        <header className={styles.header}>
          <span className={styles.name}>{name}</span>
          <span className={styles.meta}>
            {contentType} · {formatBytes(attachment.size)}
          </span>
          {isImage ? (
            <div className={styles.zoomControls}>
              {actualSize ? (
                <>
                  <button
                    aria-label="Zoom out"
                    className={styles.icon}
                    disabled={zoom <= 0.25}
                    onClick={() => setScale(zoom - 0.25)}
                    type="button"
                  >
                    −
                  </button>
                  <span aria-live="polite" className={styles.zoomLevel}>
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    aria-label="Zoom in"
                    className={styles.icon}
                    disabled={zoom >= 4}
                    onClick={() => setScale(zoom + 0.25)}
                    type="button"
                  >
                    +
                  </button>
                </>
              ) : null}
              <button
                aria-pressed={actualSize}
                className={styles.action}
                onClick={toggleActualSize}
                type="button"
              >
                {actualSize ? 'fit to window' : 'actual size'}
              </button>
            </div>
          ) : null}
          <button
            aria-label={`Download ${name}`}
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
        <div
          className={[
            styles.stage,
            actualSize ? styles.stageActual : null,
            dragging ? styles.dragging : null,
          ]
            .filter(Boolean)
            .join(' ')}
          data-preview-mode={actualSize ? 'actual' : 'fit'}
          onPointerDown={(event) => {
            if (!actualSize || event.button !== 0) return;
            const viewport = stage.current;
            if (viewport === null) return;
            if (typeof viewport.setPointerCapture === 'function') {
              viewport.setPointerCapture(event.pointerId);
            }
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              left: viewport.scrollLeft,
              top: viewport.scrollTop,
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const viewport = stage.current;
            const origin = drag.current;
            if (viewport === null || origin === null) return;
            viewport.scrollLeft = origin.left - (event.clientX - origin.x);
            viewport.scrollTop = origin.top - (event.clientY - origin.y);
          }}
          onPointerUp={(event) => {
            const viewport = stage.current;
            if (
              typeof viewport?.hasPointerCapture === 'function' &&
              viewport.hasPointerCapture(event.pointerId)
            ) {
              viewport.releasePointerCapture(event.pointerId);
            }
            drag.current = null;
            setDragging(false);
          }}
          ref={stage}
        >
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
              alt={name}
              className={actualSize ? styles.actual : styles.fit}
              height={1200}
              onLoad={(event) => {
                const rendered = event.currentTarget;
                setImageSize({ width: rendered.naturalWidth, height: rendered.naturalHeight });
              }}
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
              style={
                actualSize
                  ? { width: imageSize.width * zoom, height: imageSize.height * zoom }
                  : undefined
              }
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
