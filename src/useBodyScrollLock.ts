import { useLayoutEffect } from 'react';

let locks = 0;
let previousOverflow = '';

/** Nested dialogs may unmount together, without closing in reverse order. */
export function useBodyScrollLock() {
  useLayoutEffect(() => {
    if (locks++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    return () => {
      if (--locks === 0) document.body.style.overflow = previousOverflow;
    };
  }, []);
}
