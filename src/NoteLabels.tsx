import type { Label } from './core/types';
import LabelChip from './LabelChip';

export default function NoteLabels({ labels, catalog = [], onRemove }: { labels?: readonly string[]; catalog?: readonly Label[]; onRemove?: (name: string) => void }) {
  const unique = [...new Set(labels?.filter(Boolean))];
  return unique.length ? <div className="note-labels" role="list" aria-label="Note labels">{unique.map(label => {
    const color = catalog.find(entry => entry.name === label)?.color;
    return <LabelChip key={label} role="listitem" name={label} color={color} onRemove={onRemove ? () => onRemove(label) : undefined} />;
  })}</div> : null;
}
