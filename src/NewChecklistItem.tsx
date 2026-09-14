import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';

/** Persist every composing input, retaining its native field until the IME ends. */
export default function NewChecklistItem({ onAdd, onEdit, onFocus, onPendingChange }: {
  onAdd: (text: string) => string;
  onEdit: (id: string, text: string) => void;
  onFocus: (id: string) => void;
  onPendingChange?: (id: string | undefined) => void;
}) {
  const [value, setValue] = useState('');
  const composing = useRef(false);
  const pending = useRef<string | undefined>(undefined);
  const write = (text: string) => {
    if (pending.current) onEdit(pending.current, text);
    else {
      pending.current = onAdd(text);
      if (composing.current) onPendingChange?.(pending.current);
    }
  };
  const finish = (focus = true) => {
    const id = pending.current;
    pending.current = undefined;
    setValue('');
    onPendingChange?.(undefined);
    if (id && focus) onFocus(id);
  };
  return <div className="new-item"><Plus size={19} /><input data-note-field placeholder="List item" aria-label="New list item" value={value}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={event => {
      const field = event.currentTarget;
      queueMicrotask(() => {
        if (field.value || pending.current) write(field.value);
        composing.current = false;
        // A blur may have committed the IME after the user chose another field.
        finish(document.activeElement === field);
      });
    }}
    onChange={event => {
      const text = event.currentTarget.value;
      setValue(text);
      if (text || pending.current) write(text);
      if (!composing.current) finish();
    }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); write(value); finish(); }
    }}
  /></div>;
}
