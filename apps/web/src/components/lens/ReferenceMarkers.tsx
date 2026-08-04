import type { ContextualReferenceAttention } from '../model/records';
import styles from './lens.module.css';

export interface ReferenceMarkersProps {
  readonly references: readonly ContextualReferenceAttention[];
  readonly onOpen?: (attentionIds: readonly string[], messageId: string) => void;
}

/** One subtle control per exact source message; its count is references in that message. */
export function ReferenceMarkers({ references, onOpen }: ReferenceMarkersProps) {
  const byMessage = new Map<string, ContextualReferenceAttention[]>();
  for (const reference of references) {
    const current = byMessage.get(reference.messageId) ?? [];
    current.push(reference);
    byMessage.set(reference.messageId, current);
  }
  if (byMessage.size === 0) return null;
  return (
    <span className={styles.referenceMarkers} data-reference-markers="true">
      {[...byMessage].map(([messageId, grouped]) => (
        <button
          aria-label={`Open ${grouped.length} direct ${grouped.length === 1 ? 'reference' : 'references'} in its message`}
          data-reference-message={messageId}
          key={messageId}
          onClick={() =>
            onOpen?.(
              grouped.map((item) => item.attentionId),
              messageId,
            )
          }
          type="button"
        >
          <svg aria-hidden="true" fill="none" height="12" viewBox="0 0 24 24" width="12">
            <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
            <path
              d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2"
            />
          </svg>
          {grouped.length > 1 ? <span>{grouped.length}</span> : null}
        </button>
      ))}
    </span>
  );
}
