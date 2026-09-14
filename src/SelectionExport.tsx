import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import type { downloadNotes } from './noteExport';
import { useDismissiblePopup } from './useDismissiblePopup';

type Format = Parameters<typeof downloadNotes>[1];
const formats = [
  { value: 'markdown', label: 'Markdown (.md)' },
  { value: 'text', label: 'Plain text (.txt)' },
  { value: 'html', label: 'HTML (.html)' },
] as const;

export default function SelectionExport({ onExport }: { onExport: (format: Format) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissiblePopup(open, anchor, restoreFocus => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  });
  useLayoutEffect(() => { if (open) menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const keys = (event: KeyboardEvent) => {
    if (!open) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    event.preventDefault(); event.stopPropagation(); options[next].focus();
  };
  return <div ref={anchor} className="menu-anchor selection-export" onKeyDown={keys}>
    <button ref={trigger} type="button" className="selection-export-button" aria-label="Export notes"
      title="Export selected notes" aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (!open && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
      }}><Download size={20} /><span>Export notes</span><ChevronDown size={13} /></button>
    {open && <div ref={menu} className="popup-menu selection-export-menu" role="menu" aria-label="Export format">
      {formats.map(format => <button type="button" role="menuitem" key={format.value}
        onClick={() => { onExport(format.value); close(); }}>{format.label}</button>)}
    </div>}
  </div>;
}
