import * as Y from 'yjs';
import type { ChecklistConversion, ConversionItem } from './converted-checklist';

/** Raw fields are untrusted and may not have arrived yet. This is deliberately
 * a read boundary, not a validator for incoming CRDT updates. */
export interface RawChecklistRecord { get(key: string): unknown }

function conversion(value: unknown): ChecklistConversion | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' &&
      'source' in value && typeof value.source === 'string' &&
      'text' in value && typeof value.text === 'string' &&
      'rank' in value && typeof value.rank === 'number') {
    return { source: value.source, text: value.text, rank: value.rank };
  }
  // Conversion provenance is one atomic object, unlike the surrounding Y.Map.
  throw new Error('This checklist item has invalid conversion metadata.');
}

/** Missing required fields mean pending, not an empty item. Defaults for optional
 * metadata match the existing projection and never author CRDT repairs. */
export function readChecklistItem(id: string, record: RawChecklistRecord): ConversionItem | undefined {
  const noteId = record.get('noteId'), text = record.get('text');
  if (noteId === undefined || text === undefined) return undefined;
  if (typeof noteId !== 'string') throw new Error('This checklist item has an invalid note owner.');
  if (!(text instanceof Y.Text)) throw new Error('This checklist item has invalid editable text.');
  const parentId = record.get('parentId');
  return {
    id, noteId, text: text.toString(), checked: !!record.get('checked'),
    deleted: !!record.get('deleted'), rank: Number(record.get('rank')) || 0,
    conversion: conversion(record.get('conversion')),
    ...(typeof parentId === 'string' && parentId ? { parentId } : {}),
  };
}
