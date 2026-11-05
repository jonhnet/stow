import { useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { boundImage, fittedImage, moveImage, FIT_IMAGE, MAX_IMAGE_ZOOM, type ImageView, type Point, type Size } from './imageZoom';
import './zoomableImage.css';

interface Gesture { view: ImageView; center: Point; distance: number }
const emptySize: Size = { width: 0, height: 0 };

export default function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const viewport = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null);
  const geometry = useRef({ viewport: emptySize, image: emptySize });
  const points = useRef(new Map<number, Point>()), gesture = useRef<Gesture | undefined>(undefined);
  const current = useRef(FIT_IMAGE);
  const [view, setView] = useState(FIT_IMAGE), [size, setSize] = useState(emptySize);
  const apply = (next: ImageView) => { current.current = next; setView(next); };
  const position = (event: PointerEvent): Point => {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const span = () => {
    const [a, b] = [...points.current.values()];
    return { center: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
      distance: b ? Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) : 1 };
  };
  const rebase = () => { gesture.current = points.current.size ? { view: current.current, ...span() } : undefined; };
  const measure = () => {
    const element = viewport.current!, original = image.current!;
    if (!original.naturalWidth || !element.clientWidth || !element.clientHeight) return;
    const available = { width: element.clientWidth, height: element.clientHeight };
    const fitted = fittedImage({ width: original.naturalWidth, height: original.naturalHeight }, available);
    const previous = geometry.current;
    if (previous.viewport.width === available.width && previous.viewport.height === available.height && previous.image.width === fitted.width && previous.image.height === fitted.height) return;
    geometry.current = { viewport: available, image: fitted }; setSize(fitted);
    // Keep the center of interest on rotation, then clamp to the new edges.
    const ratio = previous.image.width ? fitted.width / previous.image.width : 1;
    apply(boundImage({ ...current.current, x: current.current.x * ratio, y: current.current.y * ratio }, fitted, available));
    const captured = [...points.current.keys()]; points.current.clear(); rebase();
    for (const id of captured) if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
  };
  useLayoutEffect(() => {
    const observer = new ResizeObserver(measure); observer.observe(viewport.current!); measure();
    return () => observer.disconnect();
  }, [src]);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || points.current.size >= 2 || !geometry.current.image.width) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    points.current.set(event.pointerId, position(event)); rebase();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!points.current.has(event.pointerId) || !gesture.current) return;
    points.current.set(event.pointerId, position(event));
    const start = gesture.current, next = span(), { image, viewport } = geometry.current;
    apply(moveImage(start.view, start.center, next.center, start.view.scale * next.distance / start.distance, image, viewport));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!points.current.delete(event.pointerId)) return;
    rebase(); // Lifting one finger continues as a pan without jumping.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const zoom = (factor: number) => {
    const { image, viewport } = geometry.current;
    apply(moveImage(current.current, { x: 0, y: 0 }, { x: 0, y: 0 }, current.current.scale * factor, image, viewport)); rebase();
  };
  const reset = () => { apply(FIT_IMAGE); rebase(); };
  const keyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === '+' || event.key === '=') zoom(1.5);
    else if (event.key === '-') zoom(1 / 1.5);
    else if (event.key === '0') reset();
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const { image, viewport } = geometry.current;
      apply(boundImage({ ...current.current,
        x: current.current.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0),
        y: current.current.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0),
      }, image, viewport)); rebase();
    } else return;
    event.preventDefault(); event.stopPropagation();
  };
  return <div className="image-zoom" onKeyDown={keyDown}>
    <div ref={viewport} className={`image-viewport${view.scale > 1 ? ' is-zoomed' : ''}`} role="region" aria-label="Zoomable image" tabIndex={0}
      onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      <img ref={image} src={src} alt={alt} draggable={false} onDragStart={event => event.preventDefault()} onLoad={measure}
        style={{ width: size.width, height: size.height, transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    </div>
    <div className="image-zoom-controls" role="group" aria-label="Image zoom">
      <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out (−)" disabled={view.scale <= 1} onClick={() => zoom(1 / 1.5)}><ZoomOut size={20} /></button>
      <button type="button" className="image-fit" aria-label="Fit image" title="Fit image (0)" onClick={reset}>{Math.round(view.scale * 100)}%</button>
      <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in (+)" disabled={view.scale >= MAX_IMAGE_ZOOM} onClick={() => zoom(1.5)}><ZoomIn size={20} /></button>
    </div>
  </div>;
}
