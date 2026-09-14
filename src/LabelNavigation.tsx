import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Palette, Tag, Trash2 } from 'lucide-react';
import type { Label, NoteColor } from './core/types';
import LabelChip from './LabelChip';
import LabelColorPicker from './LabelColorPicker';

export interface LabelNavigationProps {
  labels: readonly Label[];
  selected: string | null;
  onSelect: (name: string) => void;
  onColor: (name: string, color: NoteColor) => void;
  onDelete: (name: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  compact?: boolean;
}

const LabelNavigation = memo(function LabelNavigation({ labels, selected, onSelect, onColor, onDelete, expanded, onExpandedChange, compact = false }: LabelNavigationProps) {
  const groupId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [coloring, setColoring] = useState<{ name: string; anchor: HTMLButtonElement } | null>(null);
  const coloredLabel = coloring && labels.find(label => label.name === coloring.name);
  const closeColor = useCallback((restoreFocus = false) => {
    setColoring(null);
    if (restoreFocus && coloring?.anchor.isConnected) coloring.anchor.focus();
  }, [coloring]);
  useEffect(() => {
    if (coloring && (!expanded || !coloredLabel || !coloring.anchor.isConnected)) closeColor();
  }, [coloring, coloredLabel, expanded, closeColor]);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return <div className={`label-navigation${compact ? ' compact' : ''}`}>
    <button ref={toggle} type="button" className="nav-item label-nav-toggle" aria-label="Labels" aria-expanded={expanded} aria-controls={expanded ? groupId : undefined} title={compact ? 'Labels' : undefined} onClick={() => { closeColor(); onExpandedChange(!expanded); }}>
      <Tag size={22} aria-hidden="true" />
      <Chevron size={16} className="label-nav-chevron" aria-hidden="true" />
      <span>Labels</span>
    </button>
    {expanded && <div id={groupId} className="label-nav-list" role="group" aria-label="Labels">
      {labels.map(label => <div key={label.name} className={`label-nav-row${selected === label.name ? ' active' : ''}${coloring?.name === label.name ? ' has-popup' : ''}`}>
        <button type="button" className="label-nav-item" aria-label={`Show label ${label.name}`} aria-current={selected === label.name ? 'page' : undefined} title={label.name} onClick={() => { closeColor(); onSelect(label.name); }}><LabelChip name={label.name} color={label.color} /></button>
        <div className="label-row-actions">
          <button type="button" className="icon-button" aria-label={`Color for ${label.name}`} title={`Color for ${label.name}`} aria-expanded={coloring?.name === label.name} onClick={event => setColoring(coloring?.name === label.name ? null : { name: label.name, anchor: event.currentTarget })}><Palette size={16} /></button>
          <button type="button" className="icon-button" aria-label={`Delete label ${label.name}`} title={`Delete label ${label.name} from all notes`} onClick={event => {
            const restoreFocus = event.currentTarget === document.activeElement;
            closeColor(); onDelete(label.name);
            if (restoreFocus) requestAnimationFrame(() => toggle.current?.focus());
          }}><Trash2 size={16} /></button>
        </div>
      </div>)}
    </div>}
    {expanded && coloring && coloredLabel && <LabelColorPicker label={coloredLabel} anchor={coloring.anchor} onChange={color => onColor(coloredLabel.name, color)} onClose={closeColor} />}
  </div>;
});

export default LabelNavigation;
