import { render } from '@testing-library/react';
import { type ComponentType, createElement } from 'react';
import type { BodySegment } from '../../app/prototype/certify-span';
import { BODY_ROOT_ATTR } from '../../app/prototype/certify-span';

/**
 * Render the REAL {@link CertifyBody} into jsdom and hand back the certify-body
 * root plus locators — so the mapping test drives the SAME DOM a human selects over,
 * not a hand-built stand-in that could drift from the component.
 *
 * `textNodeOf(k)` returns the FIRST text node of the k-th rendered segment.
 *
 * `pointOf(k, charOffset)` resolves a character offset WITHIN the k-th segment to a
 * concrete `(node, offset)` DOM point, walking the segment's descendant text nodes
 * in document order. A single run can render as MULTIPLE text nodes — `renderRun`
 * splits on `\n` and re-emits each newline as its own text node — so a run
 * containing a newline has no single whole-segment text node; addressing a raw
 * offset past the first node requires this walk. (The old helper assumed
 * `childNodes[k].firstChild` was the whole segment, which is false the moment a run
 * carries a `\n` — E8 finding #5; the newline-split test below would have built its
 * Range on a truncated node.)
 */
export function renderCertifyBodyDom(
  CertifyBody: ComponentType<{ segments: readonly BodySegment[] }>,
  segments: readonly BodySegment[],
): {
  root: HTMLElement;
  textNodeOf: (segmentIndex: number) => Text;
  pointOf: (segmentIndex: number, charOffset: number) => { node: Text; offset: number };
} {
  const { container } = render(createElement(CertifyBody, { segments }));
  const root = container.querySelector(`[${BODY_ROOT_ATTR}]`) as HTMLElement | null;
  if (!root) throw new Error('certify body root not rendered');

  const segmentEl = (segmentIndex: number): Node => {
    const el = root.childNodes[segmentIndex];
    if (!el) throw new Error(`segment ${segmentIndex} not rendered`);
    return el;
  };

  /** Every descendant text node of `node`, in document order. */
  const textNodesUnder = (node: Node): Text[] => {
    const out: Text[] = [];
    const visit = (n: Node) => {
      if (n.nodeType === 3) {
        out.push(n as Text);
        return;
      }
      for (let i = 0; i < n.childNodes.length; i++) {
        const child = n.childNodes[i];
        if (child) visit(child);
      }
    };
    visit(node);
    return out;
  };

  const textNodeOf = (segmentIndex: number): Text => {
    const [first] = textNodesUnder(segmentEl(segmentIndex));
    if (!first) throw new Error(`segment ${segmentIndex} has no text node`);
    return first;
  };

  const pointOf = (segmentIndex: number, charOffset: number): { node: Text; offset: number } => {
    const nodes = textNodesUnder(segmentEl(segmentIndex));
    if (nodes.length === 0) throw new Error(`segment ${segmentIndex} has no text node`);
    let acc = 0;
    for (const node of nodes) {
      const len = node.data.length;
      if (charOffset <= acc + len) return { node, offset: charOffset - acc };
      acc += len;
    }
    throw new Error(`offset ${charOffset} past segment ${segmentIndex} (length ${acc})`);
  };

  return { root, textNodeOf, pointOf };
}
