import type { Item } from './types';

/** Provenance of a copied body line, not its spelling or ordinal in the note. */
export interface ChecklistConversion { source: string; text: string; rank: number }
export interface ConversionItem extends Item { deleted: boolean; conversion?: ChecklistConversion }
const views = new WeakMap<ConversionItem, Item>();

/**
 * Offline conversions keep separate editable CRDT records. Coalesce equivalent
 * copies in the view, never overwrite one nested Y.Map with another. Once a
 * copy is edited (including deletion), untouched copies cannot resurrect the
 * original. Distinct edited versions remain visible rather than losing edits.
 * Keep this projection in sync with server-rust/history_state.rs.
 */
export function coalesceConversions(items: readonly ConversionItem[]): Item[] {
  const groups = new Map<string, ConversionItem[]>(), result: ConversionItem[] = [];
  for (const item of items) {
    if (!item.conversion) { result.push(item); continue; }
    let group = groups.get(item.conversion.source);
    if (!group) groups.set(item.conversion.source, group = []);
    group.push(item);
  }
  const aliases = new Map<string, string>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const edited = group.filter(item => item.deleted || item.checked || item.parentId ||
      item.text !== item.conversion!.text || item.rank !== item.conversion!.rank);
    const variants = new Map<string, ConversionItem>();
    const signature = (item: ConversionItem) => JSON.stringify([item.text, item.checked,
      item.parentId ?? null, item.rank === item.conversion!.rank ? null : item.rank, item.deleted]);
    for (const item of edited.length ? edited : group) {
      const key = signature(item);
      if (!variants.has(key)) variants.set(key, item);
    }
    const selected = [...variants.values()];
    result.push(...selected);
    // A child added against either equivalent parent follows the visible copy.
    // If there are conflicting versions, prefer the first surviving version.
    const fallback = selected.find(item => !item.deleted) ?? selected[0];
    for (const item of group) aliases.set(item.id, (variants.get(signature(item)) ?? fallback).id);
  }
  return result.filter(item => !item.deleted).map(record => {
    const parent = record.parentId && (aliases.get(record.parentId) ?? record.parentId);
    let view = views.get(record);
    if (!view || view.parentId !== parent) {
      const { conversion: _, deleted: __, ...item } = record;
      view = parent ? { ...item, parentId: parent } : item; views.set(record, view);
    }
    return view;
  });
}
