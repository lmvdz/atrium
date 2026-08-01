/* Inline runs inside a message body: plain text, code, and mentions. Nothing
   else is markup — a message is a person's words, not a document.

   Every run renders through `segmentText`, which is the same function
   `messageEntry` uses to prove the body reads as the record it is attributed
   to. Rendering the `@` here and checking it there would be two definitions of
   what a mention says, and the check would be measuring a string nobody sees. */

import type { BodySegment } from '../model/records';
import { segmentText } from '../model/records';
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
              {segmentText(segment)}
            </span>
          );
        }
        return <span key={key}>{segmentText(segment)}</span>;
      })}
    </>
  );
}
