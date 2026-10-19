import type { Transaction } from 'yjs';
import type { Vault } from './vault';
const ORDER = 'stow-global-undo-order';
/** A page-local ordering of document-local undo. The metadata travels with the
 * existing persistent undo entries; remote transactions never enter this list. */
export class ScopedUndo {
  private scopes = new Map<Vault, () => boolean>();
  private branch = 0;
  private last?: Vault;
  private clock = 0;
  private moving = false;
  add(vault: Vault, enabled = () => true) {
    this.scopes.set(vault, enabled);
    const added = ({ stackItem, type }: { stackItem: { meta: Map<unknown, unknown> }; type: string }) => {
      if (this.moving) return;
      if (type !== 'undo') return;
      this.clock = Math.max(Date.now(), this.clock + 1);
      stackItem.meta.set(ORDER, this.clock);
      this.branch = this.clock;
      for (const scope of this.scopes.keys()) if (scope !== vault) scope.undoManager.clear(false, true);
    };
    // Image decoding and recovery can complete outside the UI call that began
    // them. Observe the actual local transaction, not merely button handlers.
    const before = (transaction: Transaction) => {
      if (!this.moving && transaction.origin !== vault.undoManager && vault.undoManager.trackedOrigins.has(transaction.origin)) this.before(vault);
    };
    vault.doc.on('beforeTransaction', before);
    vault.undoManager.on('stack-item-added', added);
    return () => { this.scopes.delete(vault); vault.undoManager.off('stack-item-added', added); vault.doc.off('beforeTransaction', before); };
  }
  restored(vault: Vault) {
    const redo = vault.undoManager.redoStack;
    if (this.branch && redo.some(item => Number(item.meta.get(ORDER) ?? 0) <= this.branch)) vault.undoManager.clear(false, true);
    for (const item of [...vault.undoManager.undoStack, ...redo]) this.clock = Math.max(this.clock, Number(item.meta.get(ORDER) ?? 0));
  }
  before(vault: Vault) {
    if (this.last !== vault) { this.last?.breakUndo(); vault.breakUndo(); this.last = vault; }
  }
  can(kind: 'undo' | 'redo') { return [...this.scopes.keys()].some(v => this.scopes.get(v)!() && v.undoManager[`${kind}Stack`].length); }
  run(kind: 'undo' | 'redo'): string | undefined {
    for (const scope of this.scopes.keys()) scope.breakUndo();
    this.moving = true;
    try {
      while (true) {
        const vault = [...this.scopes.keys()].filter(v => this.scopes.get(v)!() && v.undoManager[`${kind}Stack`].length)
          .sort((a, b) => Number(b.undoManager[`${kind}Stack`].at(-1)!.meta.get(ORDER) ?? 0) - Number(a.undoManager[`${kind}Stack`].at(-1)!.meta.get(ORDER) ?? 0))[0];
        if (!vault) return;
        const description = vault.undoStep(kind);
        if (!description) continue;
        this.clock = Math.max(Date.now(), this.clock + 1);
        vault.undoManager[kind === 'undo' ? 'redoStack' : 'undoStack'].at(-1)?.meta.set(ORDER, this.clock);
        return description;
      }
    } finally { this.moving = false; }
  }
}
