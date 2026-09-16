declare const __STOW_BUILD__: {
  commit: string | null;
  committedAt: string | null;
  dirty: boolean;
};

// Compiled into this bundle, so a stale tab reports its own code's revision.
export const BUILD_INFO = __STOW_BUILD__;
