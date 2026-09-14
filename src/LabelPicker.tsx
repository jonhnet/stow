import { useLayoutEffect, useRef, useState } from 'react';
import { Plus, Search, Tag } from 'lucide-react';
import type { Label } from './core/types';
import LabelChip from './LabelChip';
import { useDismissiblePopup } from './useDismissiblePopup';

export default function LabelPicker({ labels, selected = [], onToggle, onOpen }: {
  labels: readonly Label[];
  selected?: readonly string[];
  onToggle: (name: string, present: boolean) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [placement, setPlacement] = useState<{ top?: string; bottom?: string; maxHeight: number }>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const name = query.trim();
  const visible = labels.filter(label => label.name.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
  const canCreate = !!name && !labels.some(label => label.name === name);
  const close = (restoreFocus = false) => {
    setOpen(false); setQuery('');
    if (restoreFocus) trigger.current?.focus();
  };
  useDismissiblePopup(open, root, close);
  useLayoutEffect(() => { if (open) search.current?.focus(); }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = root.current!.getBoundingClientRect();
      const above = rect.top - 12, below = window.innerHeight - rect.bottom - 12;
      const upward = (root.current!.closest('.note-editor') ? above >= 280 : below < 280) && above > below;
      setPlacement(upward ? { bottom: 'calc(100% + 8px)', maxHeight: above } : { top: 'calc(100% + 8px)', maxHeight: below });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, selected.length]);
  const create = () => { if (canCreate) { onToggle(name, true); setQuery(''); search.current?.focus(); } };
  return <div ref={root} className="label-control">
    <button ref={trigger} type="button" className="icon-button" aria-label="Edit labels" title="Edit labels" aria-expanded={open} onClick={() => {
      if (open) close(); else { onOpen(); setOpen(true); }
    }}><Tag size={18} /></button>
    {open && <div className="label-picker" role="group" aria-label="Edit labels" style={placement}>
      <div>
        <div className="label-picker-heading">Label note</div>
        <div className="label-search"><Search size={16} /><input ref={search} data-native-undo aria-label="Find or create label" placeholder="Find or create label" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canCreate) create();
            else if (name) onToggle(name, !selected.includes(name));
          }
        }} /></div>
        <div className="label-options">
          {visible.map(label => <div className="label-option" key={label.name}>
            <label><input type="checkbox" checked={selected.includes(label.name)} onChange={event => onToggle(label.name, event.target.checked)} /><LabelChip name={label.name} color={label.color} /></label>
          </div>)}
          {canCreate && <button type="button" className="create-label" onClick={create}><Plus size={17} /><span>Create label “{name}”</span></button>}
        </div>
      </div>
      <div className="label-picker-footer"><button type="button" className="text-button" onClick={() => close(true)}>Done</button></div>
    </div>}
  </div>;
}
