import { useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import AutoTextarea from './AutoTextarea';
import Markdown from './Markdown';
import { markdownCaretAtPoint } from './markdownCaret';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue'> & {
  value: string;
  inline?: boolean;
  'data-item-id'?: string;
  'data-note-field'?: boolean;
};

/** One native source editor per field; formatting never rewrites the stored text. */
export default function MarkdownField({ value, inline = false, className = '', onBlur, onFocus, onCompositionStart, onCompositionEnd, ...props }: Props) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null>(null);
  const pointer = useRef<number | null>(null);
  const pendingBlur = useRef(false);
  const composing = useRef(false);

  useLayoutEffect(() => {
    if (!editing || props.disabled) return;
    let completion: number | null = null;
    const finishGesture = () => {
      if (completion !== null) window.clearTimeout(completion);
      completion = null;
      pointer.current = null;
      if (pendingBlur.current && !composing.current && document.hasFocus()) {
        pendingBlur.current = false;
        if (document.activeElement !== input.current) setEditing(false);
      }
    };
    const afterGesture = () => {
      if (completion !== null) window.clearTimeout(completion);
      // A new task runs after native click dispatch, including handlers that stop propagation.
      completion = window.setTimeout(finishGesture, 0);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.isPrimary && event.button === 0) pointer.current = event.pointerId;
    };
    const pointerUp = (event: PointerEvent) => {
      if (pointer.current === event.pointerId) afterGesture();
    };
    const pointerCancel = (event: PointerEvent) => {
      if (pointer.current === event.pointerId) finishGesture();
    };
    const click = () => { if (pointer.current !== null) afterGesture(); };
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('pointerup', pointerUp, true);
    document.addEventListener('pointercancel', pointerCancel, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', finishGesture, true);
    window.addEventListener('blur', finishGesture);
    return () => {
      if (completion !== null) window.clearTimeout(completion);
      pointer.current = null;
      pendingBlur.current = false;
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('pointerup', pointerUp, true);
      document.removeEventListener('pointercancel', pointerCancel, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', finishGesture, true);
      window.removeEventListener('blur', finishGesture);
    };
  }, [editing, props.disabled]);

  useLayoutEffect(() => {
    if (!editing || !input.current) return;
    input.current.focus({ preventScroll: true });
    const saved = selection.current;
    input.current.setSelectionRange(saved?.start ?? value.length, saved?.end ?? value.length, saved?.direction);
  }, [editing]);

  if (editing && !props.disabled) return <AutoTextarea {...props} ref={input} value={value}
    className={`markdown-field-source ${className}`} onFocus={event => {
      pendingBlur.current = false;
      onFocus?.(event);
    }} onBlur={event => {
      selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd, direction: event.currentTarget.selectionDirection };
      // A tab/window switch blurs the field too. Keep its native editor and
      // selection mounted so the browser can restore focus when we return.
      // Also keep geometry fixed through a click so its target cannot move away.
      if (!document.hasFocus() || pointer.current !== null || composing.current) pendingBlur.current = true;
      else setEditing(false);
      onBlur?.(event);
    }} onCompositionStart={event => {
      composing.current = true;
      onCompositionStart?.(event);
    }} onCompositionEnd={event => {
      onCompositionEnd?.(event);
      queueMicrotask(() => {
        composing.current = false;
        if (pendingBlur.current && pointer.current === null && document.hasFocus() && document.activeElement !== input.current) {
          pendingBlur.current = false;
          setEditing(false);
        }
      });
    }} />;

  return <div className={`markdown-field-preview ${className}`} role="textbox" aria-readonly="true" aria-multiline="true"
    aria-label={props['aria-label']} aria-disabled={props.disabled || undefined} data-item-id={props['data-item-id']} data-note-field={props['data-note-field']}
    tabIndex={props.disabled ? -1 : 0} onFocus={event => {
      if (event.target === event.currentTarget && !props.disabled) setEditing(true);
    }} onPointerDown={event => {
      if ((event.target as HTMLElement).closest('a')) return;
      // Mouse focus waits for the click; touch scrolling keeps its native gesture.
      if (!props.disabled && event.pointerType === 'mouse' && event.button === 0) event.preventDefault();
    }} onMouseDown={event => {
      // Touch taps also dispatch mousedown before focus. Defer that focus until
      // click has measured the preview, without cancelling touch scrolling.
      if (!(event.target as HTMLElement).closest('a') && !props.disabled && event.button === 0) event.preventDefault();
    }} onClick={event => {
      if ((event.target as HTMLElement).closest('a') || props.disabled) return;
      if (event.detail > 0) {
        const content = event.currentTarget.firstElementChild?.getBoundingClientRect();
        const belowText = !inline && content && event.clientY >= content.bottom;
        const offset = belowText ? value.length : markdownCaretAtPoint(event.currentTarget, event.clientX, event.clientY) ?? value.length;
        selection.current = { start: offset, end: offset, direction: 'none' };
      }
      event.preventDefault();
      setEditing(true);
    }}>
    {value ? <Markdown text={value} inline={inline} sourceMap={!props.disabled} /> : <span className="markdown-placeholder">{props.placeholder}</span>}
  </div>;
}
