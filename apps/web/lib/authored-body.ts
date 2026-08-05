/** Reject an empty draft without rewriting any authored byte that will be recorded. */
export function authoredBody(text: string): string | null {
  return text.trim().length === 0 ? null : text;
}
