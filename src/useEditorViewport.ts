import { useLayoutEffect, type RefObject } from 'react';
import { textareaCaretRect } from './textNavigation';

/** The keyboard can shrink/pan the visual viewport without changing CSS viewport units. */
export function useEditorViewport(backdrop: RefObject<HTMLDivElement | null>, dialog: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const element = backdrop.current!;
    const editor = dialog.current!;
    const viewport = window.visualViewport!;
    let frame = 0;
    const update = () => {
      frame = 0;
      element.style.top = `${viewport.offsetTop}px`;
      element.style.height = `${viewport.height}px`;
      element.style.bottom = 'auto';

      const scroller = editor.querySelector<HTMLElement>('.editor-scroll');
      const field = document.activeElement;
      if (!scroller || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
          || !field.hasAttribute('data-note-field') || !scroller.contains(field)) return;
      const visible = scroller.getBoundingClientRect();
      const rect = field.getBoundingClientRect();
      const margin = 12;
      // Most inputs fit entirely. Only a tall multiline field needs a caret measurement.
      const target = field instanceof HTMLTextAreaElement && rect.height > visible.height - margin * 2
        ? textareaCaretRect(field) : rect;
      // Scroll this note, never the page: moving the page can make the browser pan
      // its visual viewport again while it is trying to reveal the native caret.
      if (target.top < visible.top + margin) scroller.scrollTop += target.top - visible.top - margin;
      else if (target.bottom > visible.bottom - margin) scroller.scrollTop += target.bottom - visible.bottom + margin;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const selection = () => { if (editor.contains(document.activeElement)) schedule(); };
    update();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    editor.addEventListener('focusin', schedule);
    editor.addEventListener('input', schedule);
    document.addEventListener('selectionchange', selection);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      editor.removeEventListener('focusin', schedule);
      editor.removeEventListener('input', schedule);
      document.removeEventListener('selectionchange', selection);
    };
  }, [backdrop, dialog]);
}
