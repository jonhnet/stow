import { readChecklistItem, type RawChecklistRecord } from '../src/core/checklist-record';
import type { ConversionItem } from '../src/core/converted-checklist';

export function checklistRecordTypeContracts(raw: RawChecklistRecord) {
  // @ts-expect-error raw fields do not promise a complete, typed item
  const rawOwner: string = raw.get('noteId');
  // @ts-expect-error the caller must handle an incomplete record
  const complete: ConversionItem = readChecklistItem('row', raw);
  const item = readChecklistItem('row', raw);
  if (item) {
    const text: string = item.text;
    // @ts-expect-error projected text is a string, not an editable CRDT object
    item.text.insert(0, text);
  }
}
