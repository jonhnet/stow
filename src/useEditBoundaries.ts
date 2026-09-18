import { useEffect, useRef, type HTMLAttributes, type RefObject } from 'react';
import { store } from './core/store';

type TextField = HTMLInputElement | HTMLTextAreaElement;
function isNoteField(target: EventTarget | null): target is TextField {
  return (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    && target.hasAttribute('data-note-field') && !target.disabled && !target.readOnly;
}

/** Native editing stays live; intent boundaries control history and Undo grouping. */
export function useEditBoundaries(container: RefObject<HTMLElement | null>, onUndoRedo: (kind: 'undo' | 'redo') => void) {
  const undoRedo = useRef(onUndoRedo); undoRedo.current = onUndoRedo;
  const composing = useRef(false);
  const pendingClose = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const element = container.current!;
    const vault = store.vault;
    const beforeInput = (event: InputEvent) => {
      if (store.getSnapshot().syncRejection?.code === 'client_update_required') {
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (!isNoteField(event.target) || event.defaultPrevented || event.isComposing) return;
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        // Android's native editing menu has no keyboard event. Route it through
        // the same Undo action, suppressing the browser's private input history.
        event.preventDefault(); event.stopPropagation();
        undoRedo.current(event.inputType === 'historyUndo' ? 'undo' : 'redo');
      } else if (event.inputType === 'insertFromPaste' || event.inputType === 'deleteByCut') {
        vault.finishEdit();
      }
    };
    element.addEventListener('beforeinput', beforeInput, true);
    return () => {
      element.removeEventListener('beforeinput', beforeInput, true);
      vault.finishEdit();
    };
  }, [container]);

  const clipboard = (target: EventTarget | null) => {
    if (!isNoteField(target)) return;
    store.vault.finishEdit();
  };
  const events: HTMLAttributes<HTMLElement> = {
    onBlurCapture: event => {
      if (!isNoteField(event.target)) return;
      store.vault.finishEdit();
    },
    onPointerDownCapture: event => {
      if (isNoteField(event.target) && event.target === document.activeElement && event.isPrimary && event.button === 0) store.vault.breakUndo();
    },
    onKeyDownCapture: event => {
      if (!isNoteField(event.target) || event.nativeEvent.isComposing) return;
      if (/^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(event.key)
          || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) store.vault.breakUndo();
    },
    onPasteCapture: event => clipboard(event.target),
    onCutCapture: event => clipboard(event.target),
    onInput: event => {
      if (!isNoteField(event.target)) return;
      const input = event.nativeEvent as InputEvent;
      if (input.inputType !== 'insertFromPaste' && input.inputType !== 'deleteByCut') return;
      // React dispatches onInput before onChange. Seal only after the latter
      // has put the pasted/cut value in the CRDT, within this same event task.
      const vault = store.vault;
      queueMicrotask(() => vault.finishEdit());
    },
    onCompositionStartCapture: event => {
      if (!isNoteField(event.target)) return;
      composing.current = true;
      store.vault.beginComposition();
    },
    onCompositionEndCapture: event => {
      if (!isNoteField(event.target)) return;
      const vault = store.vault;
      queueMicrotask(() => {
        composing.current = false;
        vault.endComposition();
        const close = pendingClose.current; pendingClose.current = undefined;
        close?.();
      });
    },
  };
  const close = (callback: () => void) => {
    store.vault.finishEdit();
    // Keep the native composing field mounted until the IME commits it.
    if (composing.current) pendingClose.current = callback;
    else callback();
  };
  return { events, close };
}
