import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Dismiss a popup when interaction leaves it, without stealing the new focus. */
export function useDismissiblePopup(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  onDismiss: (restoreFocus: boolean) => void,
  anchor?: HTMLElement,
) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (!root.current?.contains(target) && !anchor?.contains(target)) dismiss.current(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      dismiss.current(true);
    };
    // Capture sees taps even when an editable field or drag control handles them.
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, root, anchor]);
}
