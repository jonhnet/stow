/** Browser-local ownership prevents closing an active tab's unfinished edit. */
export interface EditOwnership {
  acquire(owner: string, ifAvailable: boolean): Promise<(() => void) | null>;
}

export function browserEditOwnership(databaseName: string): EditOwnership {
  if (!globalThis.navigator?.locks) throw new Error('Stow requires a browser with Web Locks over HTTPS (or localhost) to recover interrupted edits safely.');
  return {
    acquire(owner, ifAvailable) {
      return new Promise((resolve, reject) => {
        void navigator.locks.request(`${databaseName}:edit:${owner}`, { mode: 'exclusive', ifAvailable }, lock => {
          if (!lock) { resolve(null); return; }
          return new Promise<void>(release => resolve(release));
        }).catch(reject);
      });
    },
  };
}
