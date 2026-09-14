import type { KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';

/** Measure native textarea carets, including wrapping and trailing empty lines. */
function textareaCaretRects(field: HTMLTextAreaElement, offsets: number[]): DOMRect[] {
  const style = getComputedStyle(field);
  const mirror = document.createElement('div');
  mirror.inert = true;
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.cssText = 'all: initial; position: fixed; left: -100000px; top: 0; visibility: hidden; pointer-events: none; box-sizing: border-box;';
  for (const property of [
    'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch',
    'font-variant', 'font-feature-settings', 'font-variation-settings', 'font-kerning',
    'line-height', 'letter-spacing', 'word-spacing', 'tab-size', 'text-indent',
    'text-transform', 'text-align', 'direction', 'white-space', 'overflow-wrap', 'word-break',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  ]) mirror.style.setProperty(property, style.getPropertyValue(property));
  // clientWidth includes padding but excludes the border and any vertical scrollbar.
  // Auto height measures all lines even when the source field is scrolled or capped.
  mirror.style.width = `${field.clientWidth}px`;
  // A zero-width final character gives empty text and trailing newlines a line box.
  // Offsets still address the unchanged source, including UTF-16 emoji sequences.
  const text = document.createTextNode(`${field.value}\u200b`);
  mirror.append(text);
  document.body.append(mirror);
  try {
    const fieldRect = field.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const left = fieldRect.left + parseFloat(style.borderLeftWidth) - field.scrollLeft - mirrorRect.left;
    const top = fieldRect.top + parseFloat(style.borderTopWidth) - field.scrollTop - mirrorRect.top;
    const range = document.createRange();
    return offsets.map(offset => {
      range.setStart(text, offset);
      range.collapse(true);
      const caret = range.getBoundingClientRect();
      return new DOMRect(left + caret.left, top + caret.top, caret.width, caret.height);
    });
  } finally {
    mirror.remove();
  }
}

export function textareaCaretRect(field: HTMLTextAreaElement): DOMRect {
  return textareaCaretRects(field, [field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd])[0];
}

/** Whether the caret is on the first/last rendered line of a native text field. */
export function isVerticalBoundary(field: HTMLInputElement | HTMLTextAreaElement, direction: -1 | 1): boolean {
  if (field instanceof HTMLInputElement) return true;
  const [caret, boundary] = textareaCaretRects(field, [field.selectionStart, direction === -1 ? 0 : field.value.length]);
  // Font fallback (for example emoji) can shift glyph bounds within one line.
  return Math.abs(caret.top - boundary.top) < Math.min(caret.height, boundary.height) / 2;
}

/** Traverse editable fields in their displayed order without intercepting native selection or shortcuts. */
export function navigateNoteFields(event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  const current = event.target;
  if (!(current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement)
      || !current.hasAttribute('data-note-field') || current.disabled || current.readOnly
      || current.selectionStart !== current.selectionEnd) return;

  const direction = event.key === 'ArrowUp' ? -1 : 1;
  const fields = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-note-field]')]
    .filter(field => !field.matches(':disabled, [aria-disabled="true"]') && field.getClientRects().length > 0);
  const index = fields.indexOf(current);
  const next = fields[index + direction];
  if (index === -1 || !next || !isVerticalBoundary(current, direction)) return;

  event.preventDefault();
  // Focusing a Markdown preview mounts its source textarea. Finish that change
  // now so the very next keystroke uses the new field and its entry position.
  flushSync(() => next.focus({ preventScroll: true }));
  const focused = document.activeElement;
  if ((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)
      && event.currentTarget.contains(focused) && focused.hasAttribute('data-note-field')) {
    const position = direction === 1 ? 0 : focused.value.length;
    focused.setSelectionRange(position, position);
    focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
