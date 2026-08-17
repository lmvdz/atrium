import { render } from '@testing-library/react';
import { type ComponentType, createElement } from 'react';
import type { BodySegment } from '../../app/prototype/certify-span';
import { BODY_ROOT_ATTR } from '../../app/prototype/certify-span';

/**
 * Render the REAL {@link CertifyBody} into jsdom and hand back the certify-body
 * root plus a text-node locator — so the mapping test drives the SAME DOM a human
 * selects over, not a hand-built stand-in that could drift from the component.
 *
 * `textNodeOf(k)` returns the text node of the k-th rendered segment (each text or
 * mark segment renders as one child element wrapping a single text node); it is the
 * anchor a `Range` is built on, at raw character offsets.
 */
export function renderCertifyBodyDom(
  CertifyBody: ComponentType<{ segments: readonly BodySegment[] }>,
  segments: readonly BodySegment[],
): { root: HTMLElement; textNodeOf: (segmentIndex: number) => Text } {
  const { container } = render(createElement(CertifyBody, { segments }));
  const root = container.querySelector(`[${BODY_ROOT_ATTR}]`) as HTMLElement | null;
  if (!root) throw new Error('certify body root not rendered');
  const textNodeOf = (segmentIndex: number): Text => {
    const text = root.childNodes[segmentIndex]?.firstChild;
    if (!text || text.nodeType !== 3) {
      throw new Error(`segment ${segmentIndex} has no text node`);
    }
    return text as Text;
  };
  return { root, textNodeOf };
}
