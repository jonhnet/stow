export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface ImageView extends Point { scale: number }
export const MAX_IMAGE_ZOOM = 8;
export const FIT_IMAGE: ImageView = { scale: 1, x: 0, y: 0 };

export function fittedImage(image: Size, viewport: Size): Size {
  const fit = Math.min(1, viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * fit, height: image.height * fit };
}

export function boundImage(view: ImageView, image: Size, viewport: Size): ImageView {
  const scale = Math.min(MAX_IMAGE_ZOOM, Math.max(1, view.scale));
  const limitX = Math.max(0, (image.width * scale - viewport.width) / 2);
  const limitY = Math.max(0, (image.height * scale - viewport.height) / 2);
  return { scale, x: limitX ? Math.max(-limitX, Math.min(limitX, view.x)) : 0, y: limitY ? Math.max(-limitY, Math.min(limitY, view.y)) : 0 };
}

// Points are relative to the viewport center. Keep the image point under the
// original finger/midpoint under its new position, including a moving pinch.
export function moveImage(view: ImageView, from: Point, to: Point, scale: number, image: Size, viewport: Size): ImageView {
  const boundedScale = Math.min(MAX_IMAGE_ZOOM, Math.max(1, scale));
  const ratio = boundedScale / view.scale;
  return boundImage({ scale: boundedScale, x: to.x - (from.x - view.x) * ratio, y: to.y - (from.y - view.y) * ratio }, image, viewport);
}
