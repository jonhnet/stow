import { useCallback, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import type { Label, NoteColor } from './core/types';
import { COLORS } from './colors';
import LabelChip from './LabelChip';
import { useDismissiblePopup } from './useDismissiblePopup';
import './labelColorPicker.css';

export interface LabelColorPickerProps {
  label: Label;
  anchor: HTMLButtonElement;
  onChange: (color: NoteColor) => void;
  onClose: (restoreFocus?: boolean) => void;
}

export default function LabelColorPicker({ label, anchor, onChange, onClose }: LabelColorPickerProps) {
  const popup = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback((restoreFocus = false) => {
    if (closing.current) return;
    closing.current = true;
    onCloseRef.current(restoreFocus);
  }, []);
  useDismissiblePopup(true, popup, close, anchor);

  useLayoutEffect(() => {
    const element = popup.current!;
    closing.current = false;
    const position = () => {
      const margin = 8, gap = 8;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(280, viewportWidth - margin * 2);
      element.style.width = `${width}px`;
      element.style.maxHeight = `${viewportHeight - margin * 2}px`;
      const height = element.getBoundingClientRect().height;
      const rect = anchor.getBoundingClientRect();
      const below = rect.bottom + gap;
      const top = below + height <= viewportHeight - margin ? below : rect.top - gap - height;
      element.style.left = `${Math.max(margin, Math.min(rect.left, viewportWidth - width - margin))}px`;
      element.style.top = `${Math.max(margin, Math.min(top, viewportHeight - height - margin))}px`;
      element.style.visibility = 'visible';
    };
    position();
    element.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [anchor, label.name, close]);

  return createPortal(<div ref={popup} className="label-color-popup" role="group" aria-label={`Label color for ${label.name}`}>
    <div className="label-color-popup-heading"><LabelChip name={label.name} color={label.color} /></div>
    <p className="label-color-popup-hint">Chip color everywhere this label appears</p>
    <div className="label-color-popup-swatches">
      {COLORS.map(color => {
        const selected = label.color === color.value;
        return <button key={color.value} type="button" className={`label-color-popup-swatch${selected ? ' selected' : ''}`} aria-label={color.label} title={color.label} aria-pressed={selected} style={{ backgroundColor: color.hex }} onClick={() => { onChange(color.value); close(true); }}>
          {selected && <Check size={16} aria-hidden="true" />}
        </button>;
      })}
    </div>
    <div className="label-color-popup-footer"><button type="button" onClick={() => close(true)}>Done</button></div>
  </div>, document.body);
}
