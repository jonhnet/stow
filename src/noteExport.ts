import { checklistGroups, isChecklistGroupChecked } from './core/checklist';
import type { Attachment, Item, Note } from './core/types';
import { escapeHtml, markdownHtml, markdownText } from './Markdown';

export type NoteExportFormat = 'markdown' | 'text' | 'html';

const attachmentLabel = (attachment: Attachment) => `${attachment.type.startsWith('image/') ? 'Image' : 'Attachment'}: ${attachment.name} (file not included)`;
const escapeMarkdown = (text: string) => text.replace(/([\\`*_{}\[\]()#+.!<>|~-])/g, '\\$1').replace(/\r?\n/g, ' ');
const groupsFor = (items: readonly Item[]) => {
  const groups = checklistGroups(items);
  return [...groups.filter(group => !isChecklistGroupChecked(group)), ...groups.filter(isChecklistGroupChecked)];
};

function checklistText(note: Note, format: 'markdown' | 'text'): string {
  const line = (item: Item, child: boolean) => {
    const text = format === 'markdown' ? item.text : markdownText(item.text, true);
    const indent = child ? '    ' : '';
    return `${indent}- [${item.checked ? 'x' : ' '}] ${text.replace(/\n/g, `\n${indent}  `)}`;
  };
  return groupsFor(note.items).flatMap(({ root, children }) => [line(root, false), ...children.map(child => line(child, true))]).join('\n');
}

function checklistHtml(note: Note): string {
  const item = (entry: Item) => `<span aria-label="${entry.checked ? 'Checked' : 'Unchecked'}">${entry.checked ? '☑' : '☐'}</span> ${markdownHtml(entry.text, true)}`;
  const list = (children: string) => `<ul style="list-style:none;padding-left:1.5em">${children}</ul>`;
  return list(groupsFor(note.items).map(({ root, children }) => `<li>${item(root)}${children.length ? list(children.map(child => `<li>${item(child)}</li>`).join('')) : ''}</li>`).join(''));
}

function noteText(note: Note, format: 'markdown' | 'text'): string {
  const title = note.title || 'Untitled note';
  const parts = [format === 'markdown' ? `# ${escapeMarkdown(title)}` : title];
  if (note.body) parts.push(format === 'markdown' ? note.body : markdownText(note.body));
  if (note.items.length) parts.push(checklistText(note, format));
  if (note.labels?.length) parts.push(`Labels: ${note.labels.map(label => format === 'markdown' ? escapeMarkdown(label) : label).join(', ')}`);
  if (note.images.length) parts.push(note.images.map(attachment => format === 'markdown' ? escapeMarkdown(`[${attachmentLabel(attachment)}]`) : `[${attachmentLabel(attachment)}]`).join('\n'));
  return parts.join('\n\n');
}

function noteHtml(note: Note): string {
  return `<article><h1>${escapeHtml(note.title || 'Untitled note')}</h1>`
    + (note.body ? markdownHtml(note.body) : '')
    + (note.items.length ? checklistHtml(note) : '')
    + (note.labels?.length ? `<p>Labels: ${note.labels.map(escapeHtml).join(', ')}</p>` : '')
    + (note.images.length ? `<ul>${note.images.map(attachment => `<li>${escapeHtml(`[${attachmentLabel(attachment)}]`)}</li>`).join('')}</ul>` : '')
    + '</article>';
}

/** The caller supplies selected notes in their current visual order. No media is fetched. */
export function formatNotes(notes: readonly Note[], format: NoteExportFormat): string {
  if (!notes.length) throw new Error('Select at least one note to copy or export.');
  if (!['markdown', 'text', 'html'].includes(format)) throw new Error('Unsupported note export format.');
  return notes.map(note => format === 'html' ? noteHtml(note) : noteText(note, format)).join(format === 'html' ? '\n<hr>\n' : '\n\n---\n\n');
}

export async function copyNotes(notes: readonly Note[]): Promise<void> {
  const text = formatNotes(notes, 'text'), html = formatNotes(notes, 'html');
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Copying notes requires a current browser over HTTPS or localhost.');
  await navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([text], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }),
  })]);
}

/** Downloads are textual exports; use the separate vault backup for storage recovery. */
export function downloadNotes(notes: readonly Note[], format: NoteExportFormat): void {
  let content = formatNotes(notes, format);
  const title = notes.length === 1 ? notes[0].title || 'Untitled note' : `Stow — ${notes.length} notes`;
  if (format === 'html') content = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${content}</body></html>\n`;
  const extension = { markdown: 'md', text: 'txt', html: 'html' }[format];
  const type = { markdown: 'text/markdown', text: 'text/plain', html: 'text/html' }[format];
  const base = notes.length === 1 ? notes[0].title : `stow-${notes.length}-notes`;
  const name = Array.from(base.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-').trim().replace(/^[. ]+|[. ]+$/g, '')).slice(0, 100).join('');
  const filename = name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? name : 'stow-notes';
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement('a');
  try {
    anchor.href = url; anchor.download = `${filename}.${extension}`;
    document.body.append(anchor); anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
