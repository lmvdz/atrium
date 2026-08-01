/* Inline runs inside a message body: plain text, code, and mentions. Nothing
   else is markup — a message is a person's words, not a document. */

import type { BodySegment } from '../model/records';
import styles from './primitives.module.css';

export interface MessageBodyProps {
  readonly body: readonly BodySegment[];
}

export function MessageBody({ body }: MessageBodyProps) {
  return (
    <>
      {body.map((segment, index) => {
        const key = `${segment.kind}-${index}-${segment.text}`;
        if (segment.kind === 'code') {
          return (
            <code className={styles.code} key={key}>
              {segment.text}
            </code>
          );
        }
        if (segment.kind === 'mention') {
          return (
            <span className={styles.mention} key={key}>
              @{segment.text}
            </span>
          );
        }
        return <span key={key}>{segment.text}</span>;
      })}
    </>
  );
}
