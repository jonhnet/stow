const positions = new WeakMap<HTMLElement, readonly number[]>();

export function registerMarkdownSource(element: HTMLElement, offsets: readonly number[]): void {
  positions.set(element, offsets);
}

/** Resolve the browser's rendered-text caret before the preview changes geometry. */
export function markdownCaretAtPoint(root: HTMLElement, x: number, y: number): number | undefined {
  const caret = document.caretPositionFromPoint(x, y);
  if (!caret || !root.contains(caret.offsetNode)) return undefined;
  const parent = caret.offsetNode.nodeType === Node.ELEMENT_NODE ? caret.offsetNode as Element : caret.offsetNode.parentElement;
  const mapped = parent?.closest<HTMLElement>('[data-markdown-source]');
  const range = document.createRange();
  if (mapped && root.contains(mapped)) {
    range.selectNodeContents(mapped);
    range.setEnd(caret.offsetNode, caret.offset);
    return positions.get(mapped)![range.toString().length];
  }

  // A caret on a container boundary (between paragraphs, for example) belongs
  // to the next text run, or the end of the final run when no text follows it.
  range.setStart(caret.offsetNode, caret.offset);
  range.collapse(true);
  let end: number | undefined;
  for (const element of root.querySelectorAll<HTMLElement>('[data-markdown-source]')) {
    const offsets = positions.get(element)!;
    if (range.comparePoint(element, 0) >= 0) return offsets[0];
    end = offsets[offsets.length - 1];
  }
  return end;
}
