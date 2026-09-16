import * as Y from 'yjs';
import type { TextRef } from './merged-text';

export interface TextSpan { client: number; clock: number; length: number }
export interface TextMask { field: TextRef['field']; joinId?: string; spans: TextSpan[] }
export interface TextRun { text: Y.Text; index: number; value: string; span: TextSpan }
export const TEXT_MASK_PREFIX = 'text-mask:';

/** Exact character identities, so newly arriving insertions are never hidden. */
export function visibleTextRuns(text: Y.Text, masks: readonly TextSpan[]): TextRun[] {
  const byClient = new Map<number, TextSpan[]>();
  for (const mask of masks) {
    let spans = byClient.get(mask.client); if (!spans) byClient.set(mask.client, spans = []);
    spans.push(mask);
  }
  for (const spans of byClient.values()) spans.sort((a, b) => a.clock - b.clock);
  const runs: TextRun[] = [];
  let index = 0;
  // Walk Yjs's text structs without splitting them or opening a transaction.
  // String clocks and indexes use UTF-16, including surrogate pairs.
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
    const value = item.content.str, end = item.id.clock + value.length;
    let clock = item.id.clock;
    const append = (until: number) => {
      if (until > clock) runs.push({ text, index: index + clock - item!.id.clock,
        value: value.slice(clock - item!.id.clock, until - item!.id.clock), span: { client: item!.id.client, clock, length: until - clock } });
      clock = until;
    };
    for (const span of byClient.get(item.id.client) ?? []) {
      if (span.clock >= end) break;
      if (span.clock + span.length <= clock) continue;
      append(Math.max(clock, span.clock));
      clock = Math.min(end, span.clock + span.length);
    }
    append(end); index += value.length;
  }
  return runs;
}

export function textMasks(note: Y.Map<any>, field: TextRef['field'], joinId?: string): TextSpan[] {
  return [...note].flatMap(([key, value]) => key.startsWith(TEXT_MASK_PREFIX) &&
    (value as TextMask).field === field && (value as TextMask).joinId === joinId ? (value as TextMask).spans : []);
}
export function visibleText(text: Y.Text, note: Y.Map<any>, field: TextRef['field'], joinId?: string): string {
  const masks = textMasks(note, field, joinId);
  return masks.length ? visibleTextRuns(text, masks).map(run => run.value).join('') : text.toString();
}
