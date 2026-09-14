import { X } from 'lucide-react';
import type { NoteColor } from './core/types';
import { noteColor } from './colors';

export default function LabelChip({ name, color = 'default', onRemove, role }: {
  name: string;
  color?: NoteColor;
  onRemove?: () => void;
  role?: 'listitem';
}) {
  return <span className="label-chip" role={role} style={color !== 'default' ? { backgroundColor: noteColor(color) } : undefined}>
    <span className="label-chip-name">{name}</span>
    {onRemove && <button type="button" aria-label={`Remove label ${name}`} title={`Remove label ${name}`} onClick={onRemove}><X size={12} /></button>}
  </span>;
}
