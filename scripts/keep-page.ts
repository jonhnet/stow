import { createRequire } from 'node:module';

// The package ships a declaration for a different module name. This static DOM
// parser neither executes scripts nor loads any URLs from the saved document.
const { createDocument } = createRequire(import.meta.url)('@mixmark-io/domino') as { createDocument(html: string): Document };
const CARD = '.IZ65Hb-n0tgWb';
const TITLE = '[role="textbox"].vIzZGf-r4nke-YPqjbf';
const ROW = '.bVEB4e-rymPhb-ibnC6b';
const POSITION = '.rymPhb-ibnC6b-bVEB4e-sM5MNb';
const TEXT = '.rymPhb-ibnC6b-bVEB4e-fmcmS-haAclf';
const MORE = '.bVEB4e-rymPhb-zcdHbf';

export interface KeepPageItem {
  text: string;
  checked: boolean;
  indented: boolean;
  parentIndex?: number;
  /** Different DOM containers must never share an inferred parent. */
  section: number;
  visible: boolean;
  truncated: boolean;
  valid: boolean;
}
export interface KeepPageNote {
  cardIndex: number;
  title: string;
  items: KeepPageItem[];
  visible: boolean;
  truncated: boolean;
  issues: string[];
}
export interface KeepPage { identity: string; notes: KeepPageNote[] }
export interface KeepPageSource {
  id: string;
  title: string;
  archived: boolean;
  trashed: boolean;
  /** Original JSON plaintext, with stable IDs from the reviewed import plan. */
  items: { id: string; text: string; checked: boolean }[];
}
export interface KeepPageMatch {
  cardIndex: number;
  noteId: string;
  links: { itemId: string; parentId: string }[];
  matchedItems: number;
  sourceItems: number;
  complete: boolean;
}
export interface KeepPageIssue { cardIndex: number; reason: string }

/** Contenteditable HTML uses NBSP for preserved ordinary spaces, and wrapping
 * paragraphs add a final newline. No case folding, prefix/fuzzy matching, or
 * whitespace collapsing is permitted. Normalization collisions stay ambiguous. */
function matchingText(value: string): string { return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/\n+$/, ''); }
function text(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  const element = node as Element;
  if (element.tagName === 'BR') return '\n';
  if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName)) return '';
  const contents = Array.from(node.childNodes).map(text).join('');
  return contents + (['P', 'DIV'].includes(element.tagName) ? '\n' : '');
}
function visible(element: Element): boolean {
  for (let cursor: Element | null = element; cursor; cursor = cursor.parentElement) {
    const style = (cursor as HTMLElement).style;
    if (cursor.hasAttribute('hidden') || cursor.getAttribute('aria-hidden') === 'true' || style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}

export function parseKeepPage(html: string): KeepPage {
  if (Buffer.byteLength(html, 'utf8') > 50 * 1024 * 1024) throw new Error('The saved Keep page exceeds 50 MiB. Save a smaller loaded view.');
  const document = createDocument(html);
  const accounts = Array.from(document.querySelectorAll('a[aria-label^="Google Account:"]'));
  if (accounts.length !== 1) throw new Error('The saved page must identify exactly one Google Account.');
  const emails = accounts[0].getAttribute('aria-label')!.match(/[^\s()<>]+@[^\s()<>]+/g) ?? [];
  if (emails.length !== 1) throw new Error('The saved page does not contain one unambiguous Google Account email.');
  const cards = Array.from(document.querySelectorAll(CARD));
  if (!cards.length) throw new Error('The saved page does not contain the supported Google Keep note-card layout.');
  const notes = cards.map((card, cardIndex): KeepPageNote => {
    const issues: string[] = [], titles = Array.from(card.querySelectorAll(TITLE));
    if (titles.length !== 1) issues.push('missing-or-ambiguous-title-element');
    const title = titles.length === 1 ? text(titles[0]).replace(/\n+$/, '') : '';
    const items: KeepPageItem[] = [];
    let parentIndex: number | undefined, container: Element | null = null, section = -1;
    let truncated = false;
    for (const element of Array.from(card.querySelectorAll(`${ROW}, ${MORE}`))) {
      if (element.matches(MORE)) { truncated = true; parentIndex = undefined; container = null; continue; }
      if (container !== element.parentElement) { container = element.parentElement; section++; parentIndex = undefined; }
      const positions = Array.from(element.querySelectorAll(POSITION));
      const labels = Array.from(element.querySelectorAll(TEXT));
      const checks = Array.from(element.querySelectorAll('[role="checkbox"]'));
      const margin = positions.length === 1 ? (positions[0] as HTMLElement).style.marginLeft : '';
      const checked = checks.length === 1 ? checks[0].getAttribute('aria-checked') : null;
      const valid = positions.length === 1 && labels.length === 1 && checks.length === 1 && (margin === '0px' || margin === '25px') && (checked === 'true' || checked === 'false');
      const label = labels.length === 1 ? text(labels[0]).replace(/\n+$/, '') : '';
      // The live overview replaces truncated label suffixes with an ellipsis.
      // Even a literal authored ellipsis is conservatively excluded from repair.
      const itemTruncated = /(?:…|\.\.\.)\s*$/.test(label);
      const indented = margin === '25px';
      const item: KeepPageItem = { text: label, checked: checked === 'true', indented, section,
        visible: visible(element), truncated: itemTruncated, valid,
        ...(valid && indented && parentIndex !== undefined ? { parentIndex } : {}) };
      if (!valid) { issues.push(`unsupported-row-layout:${items.length}`); parentIndex = undefined; }
      else if (!indented) parentIndex = items.length;
      else if (parentIndex === undefined) issues.push(`parent-not-present-in-section:${items.length}`);
      if (itemTruncated) { truncated = true; issues.push(`truncated-item-label:${items.length}`); }
      items.push(item);
    }
    return { cardIndex, title, items, visible: visible(card), truncated, issues };
  });
  return { identity: emails[0], notes };
}

/** Recover only explicit edges whose note, parent and child each have unique
 * full-text evidence. Unseen rows and ambiguous labels never supply identities. */
export function matchKeepPage(page: KeepPage, sources: KeepPageSource[]) {
  const matches: KeepPageMatch[] = [], issues: KeepPageIssue[] = [];
  const titleIndex = new Map<string, KeepPageSource[]>();
  for (const source of sources) {
    const key = matchingText(source.title), existing = titleIndex.get(key) ?? [];
    existing.push(source); titleIndex.set(key, existing);
  }
  const itemKey = (item: { text: string; checked: boolean }) => JSON.stringify([matchingText(item.text), item.checked]);
  for (const note of page.notes) {
    const issue = (reason: string) => issues.push({ cardIndex: note.cardIndex, reason });
    note.issues.forEach(issue);
    if (!note.visible) { issue('hidden-note-card'); continue; }
    if (note.issues.includes('missing-or-ambiguous-title-element')) continue;
    if (!note.items.length) { issue('no-checklist-items-in-card'); continue; }
    const anchors = note.items.filter(item => item.visible && item.valid && !item.truncated && matchingText(item.text).length);
    if (!anchors.length) { issue('no-complete-item-labels-for-matching'); continue; }
    const candidates = (titleIndex.get(matchingText(note.title)) ?? []).filter(source => {
      if (source.archived || source.trashed) return false;
      const keys = new Set(source.items.map(itemKey));
      return anchors.every(item => keys.has(itemKey(item)));
    });
    if (candidates.length !== 1) { issue(candidates.length ? 'ambiguous-source-note' : 'source-note-or-complete-items-do-not-match'); continue; }
    const source = candidates[0], sourceItems = new Map<string, string[]>(), pageOccurrences = new Map<string, number>();
    for (const item of source.items) {
      const key = itemKey(item), values = sourceItems.get(key) ?? []; values.push(item.id); sourceItems.set(key, values);
    }
    for (const item of note.items) if (item.visible && item.valid && !item.truncated) pageOccurrences.set(itemKey(item), (pageOccurrences.get(itemKey(item)) ?? 0) + 1);
    const aligned = note.items.map((item, index) => {
      if (!item.visible) { issue(`hidden-item-row:${index}`); return undefined; }
      if (!item.valid || item.truncated) return undefined;
      const key = itemKey(item), choices = sourceItems.get(key) ?? [];
      if (choices.length !== 1 || pageOccurrences.get(key) !== 1) { issue(`ambiguous-source-item:${index}`); return undefined; }
      return choices[0];
    });
    const links: KeepPageMatch['links'] = [];
    for (const [index, item] of note.items.entries()) {
      if (!item.visible || !item.valid || !item.indented) continue;
      const parent = item.parentIndex === undefined ? undefined : note.items[item.parentIndex];
      const itemId = aligned[index], parentId = item.parentIndex === undefined ? undefined : aligned[item.parentIndex];
      if (!itemId || !parentId || !parent || parent.indented || parent.section !== item.section) { issue(`unresolved-parent-link:${index}`); continue; }
      links.push({ itemId, parentId });
    }
    const matchedItems = aligned.filter(Boolean).length;
    matches.push({ cardIndex: note.cardIndex, noteId: source.id, links, matchedItems, sourceItems: source.items.length,
      complete: !note.truncated && matchedItems === note.items.length && matchedItems === source.items.length });
  }
  // Multiple rendered copies can disagree, e.g. an open editor and a stale card.
  // Do not silently select one of them or combine their different observations.
  const occurrences = new Map<string, number>();
  for (const match of matches) occurrences.set(match.noteId, (occurrences.get(match.noteId) ?? 0) + 1);
  return { matches: matches.filter(match => {
    if (occurrences.get(match.noteId) === 1) return true;
    issues.push({ cardIndex: match.cardIndex, reason: 'source-note-rendered-more-than-once' }); return false;
  }), issues };
}
