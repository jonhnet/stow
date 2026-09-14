import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

/** Keep the native text editor tall enough for its contents, including after a width change. */
const AutoTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function AutoTextarea({ className = '', value, ...props }, forwardedRef) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useRef(() => {});
  useImperativeHandle(forwardedRef, () => ref.current!, []);

  useLayoutEffect(() => {
    const field = ref.current!;
    // Collapsing the live editor to measure scrollHeight lays out every following
    // checklist row on every input. An out-of-flow mirror confines that work to
    // the textarea; the live height changes only when the line count changes.
    const mirror = document.createElement('textarea');
    mirror.setAttribute('aria-hidden', 'true'); mirror.tabIndex = -1;
    mirror.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;contain:layout style;height:0;min-height:0;max-height:none;overflow:hidden;resize:none;';
    let borderBox = true, horizontalBorder = 0, horizontalPadding = 0, verticalAdjustment = 0;
    const copySizingStyle = () => {
      const computed = getComputedStyle(field);
      for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
        'letter-spacing', 'line-height', 'text-indent', 'text-transform', 'text-align', 'tab-size',
        'padding', 'border-width', 'border-style', 'box-sizing', 'word-break', 'overflow-wrap', 'white-space', 'direction']) {
        mirror.style.setProperty(property, computed.getPropertyValue(property));
      }
      mirror.wrap = field.wrap;
      horizontalBorder = parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
      horizontalPadding = parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight);
      borderBox = computed.boxSizing === 'border-box';
      verticalAdjustment = borderBox ? parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth)
        : -parseFloat(computed.paddingTop) - parseFloat(computed.paddingBottom);
    };
    copySizingStyle();
    let width = field.getBoundingClientRect().width;
    document.body.append(mirror);
    resize.current = () => {
      mirror.style.width = `${borderBox ? width : width - horizontalBorder - horizontalPadding}px`;
      mirror.value = field.value || field.placeholder;
      const height = `${mirror.scrollHeight + verticalAdjustment}px`;
      if (field.style.height !== height) field.style.height = height;
    };
    resize.current();
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0].borderBoxSize[0].inlineSize;
      if (nextWidth !== width) { width = nextWidth; copySizingStyle(); resize.current(); }
    });
    observer.observe(field);
    return () => { observer.disconnect(); mirror.remove(); resize.current = () => {}; };
  }, [className, props.style]);
  useLayoutEffect(() => resize.current(), [value, props.placeholder]);

  return <textarea {...props} ref={ref} value={value} className={`auto-textarea ${className}`} rows={1} />;
});

export default AutoTextarea;
