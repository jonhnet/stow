import type { Attachment } from './types';

/** Explicit positions follow older, unpositioned attachments. Keep the latter's
 * input sequence: live views supply ID order, while history supplies its recorded
 * sequence. Concurrent additions at the same position converge by attachment ID. */
export function compareAttachmentOrder(a: Attachment, b: Attachment): number {
  if (a.order === undefined) return b.order === undefined ? 0 : -1;
  if (b.order === undefined) return 1;
  return a.order - b.order || a.id.localeCompare(b.id);
}
