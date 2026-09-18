import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { checkImage } from './image-preflight.ts';
import TurndownService from 'turndown';
import type { NoteColor } from '../src/core/types.ts';
import { stageKeepSource } from './keep-archive.ts';

export interface KeepSourceBlob {
  hash: string;
  path: string;
  sourcePaths: string[];
  size: number;
  type: string;
  role: 'image' | 'audio' | 'source-json' | 'unreferenced';
}
export interface KeepSourceNote {
  sourcePath: string;
  title: string;
  body: string;
  kind: 'text' | 'checklist';
  color: NoteColor;
  pinned: boolean;
  archived: boolean;
  trashed: boolean;
  createdAt: number;
  updatedAt: number;
  items: { text: string; checked: boolean }[];
  attachments: { sourcePath: string; hash: string; name: string; type: string; size: number }[];
  labels: string[];
  takeout: { sourcePath: string; rawHash: string; labels: string[] };
}
export interface KeepSourceWarning { code: string; sourcePaths: string[] }
export type KeepSourceLimits = Parameters<typeof stageKeepSource>[2];

const colors: Record<string, NoteColor> = {
  DEFAULT: 'default', RED: 'coral', ORANGE: 'peach', YELLOW: 'sand', GREEN: 'mint',
  TEAL: 'sage', BLUE: 'fog', CERULEAN: 'storm', PURPLE: 'dusk', PINK: 'blossom', BROWN: 'clay', GRAY: 'gray',
};
const types: Record<string, string> = {
  '.json': 'application/json', '.txt': 'text/plain', '.html': 'text/html',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
  '.3gp': 'audio/3gp', '.3gpp': 'audio/3gpp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
};
const noteFields = new Set(['title', 'color', 'isPinned', 'isArchived', 'isTrashed', 'createdTimestampUsec',
  'userEditedTimestampUsec', 'textContent', 'textContentHtml', 'listContent', 'attachments', 'labels', 'annotations', 'sharees', 'tasks']);

function invalid(sourcePath: string, field: string): never {
  throw new Error(`Invalid Google Keep source ${sourcePath}: ${field}.`);
}
function object(value: unknown, sourcePath: string, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(sourcePath, `${field} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, sourcePath: string, field: string): string {
  if (typeof value !== 'string') invalid(sourcePath, `${field} must be a string`);
  // Invalid UTF-16 would change during Yjs's UTF-8 encoding. Fail before upload.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(sourcePath, `${field} contains an unpaired surrogate`);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid(sourcePath, `${field} contains an unpaired surrogate`);
  }
  return value;
}
function boolean(value: unknown, sourcePath: string, field: string): boolean {
  if (typeof value !== 'boolean') invalid(sourcePath, `${field} must be a boolean`);
  return value;
}
function array(value: unknown, sourcePath: string, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(sourcePath, `${field} must be an array`);
  return value;
}
function timestamp(value: unknown, sourcePath: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(sourcePath, `${field} must be a safe integer in microseconds`);
  return Math.floor(value / 1000);
}

function escapeMarkdownSyntax(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/[\\`*_[\]<>~|]/g, '\\$&')
    .replace(/^([ \t]*)([#+=-])/gm, '$1\\$2')
    .replace(/^([ \t]*)(\d+)([.)])(?=\s)/gm, '$1$2\\$3');
}
function trimLineEdges(text: string): string { return text.replace(/^[ \t]+|[ \t]+$/gm, ''); }
const linkifier = new MarkdownIt({ linkify: true }).linkify;
linkifier.set({ fuzzyLink: true });
function destination(url: string): string { return url.replace(/[<>\\]/g, char => encodeURIComponent(char)); }

/** Preserve plaintext as plaintext when displaying it through Stow's Markdown parser. */
export function keepPlaintextMarkdown(text: string): string {
  // Discard source line-edge whitespace rather than encoding it into the editor.
  // Normalize the whole field before splitting links: fragment edges can be
  // ordinary spaces between words, and must remain intact.
  return linkifiedMarkdown(trimLineEdges(text), escapeMarkdownSyntax);
}
function linkifiedMarkdown(text: string, escape: (value: string) => string): string {
  let result = '', offset = 0;
  // Auto-linkification runs before Markdown escapes inside URLs. Explicit links
  // keep a literal underscore/ampersand from becoming a backslash/entity in a URL.
  for (const match of linkifier.match(text) ?? []) {
    result += escape(text.slice(offset, match.index));
    result += `[${escape(match.text)}](<${destination(match.url)}>)`;
    offset = match.lastIndex;
  }
  return result + escape(text.slice(offset));
}

function meaningfulHtml(html: string): boolean {
  return /<(?:b|strong|i|em|s|del|strike|h[1-6]|a|ul|ol|li|blockquote|pre|code|hr|table)\b/i.test(html)
    || /(?:font-weight\s*:\s*(?:bold|[6-9]00)|font-style\s*:\s*italic|text-decoration(?:-line)?\s*:[^;"']*line-through)/i.test(html);
}
function wrap(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
  return match[2] ? `${match[1]}${marker}${match[2]}${marker}${match[3]}` : content;
}
function converter(linkify = true): TurndownService {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', strongDelimiter: '**' });
  // Turndown trims and restores inline elements' flanking whitespace itself.
  // Encoding those spaces as entities first would leave them inside the styled
  // span and also restore them outside it, duplicating the same source space.
  service.escape = linkify ? text => linkifiedMarkdown(text, escapeMarkdownSyntax) : escapeMarkdownSyntax;
  service.remove(['script', 'style', 'iframe', 'object']);
  service.addRule('keep-styles', {
    filter: node => node.nodeName === 'SPAN',
    replacement: (content, node) => {
      const style = (node as HTMLElement).getAttribute('style') ?? '';
      if (/text-decoration(?:-line)?\s*:[^;]*line-through/i.test(style)) content = wrap(content, '~~');
      if (/font-style\s*:\s*italic/i.test(style)) content = wrap(content, '*');
      if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style)) content = wrap(content, '**');
      return content;
    },
  });
  service.addRule('strike', { filter: node => ['DEL', 'S', 'STRIKE'].includes(node.nodeName), replacement: content => wrap(content, '~~') });
  service.addRule('link', {
    filter: 'a',
    replacement: (_content, node) => {
      const anchor = node as HTMLElement;
      const href = anchor.getAttribute('href');
      const label = converter(false).turndown(anchor.innerHTML);
      return href ? `[${label}](<${destination(href)}>)` : label;
    },
  });
  return service;
}

/** Read only the staged source. Account selection and durable publication belong to the caller. */
export async function readKeepSource(inputPath: string, stagingDir: string, limits?: KeepSourceLimits) {
  const files = await stageKeepSource(inputPath, stagingDir, limits);
  const warnings = new Map<string, Set<string>>();
  const warn = (code: string, sourcePath: string) => {
    let affected = warnings.get(code);
    if (!affected) warnings.set(code, affected = new Set());
    affected.add(sourcePath);
  };
  const markdown = converter();
  const text = (plain: unknown, html: unknown, sourcePath: string, field: string) => {
    const value = plain === undefined ? '' : string(plain, sourcePath, field);
    if (html === undefined) return keepPlaintextMarkdown(value);
    const rich = string(html, sourcePath, `${field}Html`);
    if (/<u\b|text-decoration(?:-line)?\s*:[^;"']*underline/i.test(rich)) warn('underline-retained-in-source-only', sourcePath);
    if (plain !== undefined && !meaningfulHtml(rich)) return keepPlaintextMarkdown(value);
    if (/<table\b/i.test(rich)) warn('table-layout-retained-in-source-only', sourcePath);
    warn('rich-text-converted-to-markdown', sourcePath);
    return markdown.turndown(rich);
  };
  const blobsByHash = new Map<string, KeepSourceBlob>();
  const blobsByPath = new Map<string, KeepSourceBlob>();
  const referenced = new Set<string>();
  const imageHashes = new Set<string>();
  async function blob(sourcePath: string, type: string, role: KeepSourceBlob['role']) {
    const previous = blobsByPath.get(sourcePath);
    if (previous) {
      if (previous.type !== type) invalid(sourcePath, 'the same file has conflicting media types');
      return previous;
    }
    const file = files.get(sourcePath);
    if (!file) invalid(sourcePath, 'referenced attachment is missing');
    const bytes = await readFile(file.path);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (type.startsWith('image/') && !imageHashes.has(hash)) {
      // Preflight uses the Rust server's decoder before uploading any original.
      try { await checkImage(bytes); }
      catch { invalid(sourcePath, 'image cannot be decoded by Stow; original bytes have not been uploaded'); }
      imageHashes.add(hash);
    }
    let result = blobsByHash.get(hash);
    if (result) {
      if (result.type !== type) invalid(sourcePath, 'identical bytes have conflicting media types');
      result.sourcePaths.push(sourcePath);
      if (result.role === 'unreferenced') result.role = role;
    } else {
      result = { hash, path: file.path, sourcePaths: [sourcePath], size: file.size, type, role };
      blobsByHash.set(hash, result);
    }
    blobsByPath.set(sourcePath, result);
    return result;
  }
  const notes: KeepSourceNote[] = [];
  for (const [sourcePath, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.posix.extname(sourcePath).toLowerCase() !== '.json') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(file.path, 'utf8')); }
    catch { invalid(sourcePath, 'JSON is malformed'); }
    const source = object(parsed, sourcePath, 'note');
    const raw = await blob(sourcePath, 'application/json', 'source-json');
    const color = string(source.color, sourcePath, 'color');
    if (!Object.hasOwn(colors, color)) invalid(sourcePath, 'color is unsupported');
    const labels = array(source.labels, sourcePath, 'labels').map((label, index) =>
      string(object(label, sourcePath, `labels[${index}]`).name, sourcePath, `labels[${index}].name`));
    const items = array(source.listContent, sourcePath, 'listContent').map((value, index) => {
      const item = object(value, sourcePath, `listContent[${index}]`);
      if (Object.keys(item).some(key => !['text', 'textHtml', 'isChecked'].includes(key))) warn('extra-checklist-metadata-retained-in-source-only', sourcePath);
      return { text: text(string(item.text, sourcePath, `listContent[${index}].text`), item.textHtml, sourcePath, `listContent[${index}].text`), checked: boolean(item.isChecked, sourcePath, `listContent[${index}].isChecked`) };
    });
    const attachments: KeepSourceNote['attachments'] = [];
    for (const value of array(source.attachments, sourcePath, 'attachments')) {
      const attachment = object(value, sourcePath, 'attachment');
      const reference = string(attachment.filePath, sourcePath, 'attachment.filePath');
      if (!reference || reference.includes('\\') || path.posix.isAbsolute(reference) || /^[a-z]:/i.test(reference) || reference.split('/').some(part => part === '..' || part === '.')) invalid(sourcePath, 'attachment path is unsafe');
      const attachmentPath = path.posix.join(path.posix.dirname(sourcePath), reference);
      const type = string(attachment.mimetype, sourcePath, 'attachment.mimetype').toLowerCase();
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) invalid(sourcePath, 'attachment MIME type is invalid');
      const role = type.startsWith('image/') ? 'image' : type.startsWith('audio/') ? 'audio' : 'unreferenced';
      if (role === 'unreferenced') warn('attachment-kept-as-download', sourcePath);
      const content = await blob(attachmentPath, type, role);
      referenced.add(attachmentPath);
      attachments.push({ sourcePath: attachmentPath, hash: content.hash, name: path.posix.basename(reference), type, size: content.size });
    }
    const title = string(source.title, sourcePath, 'title');
    let body = text(source.textContent, source.textContentHtml, sourcePath, 'textContent');
    const authoredText = [title, source.textContent ?? '', ...array(source.listContent, sourcePath, 'listContent').map(value => object(value, sourcePath, 'item').text)].join('\n');
    const appended = new Set<string>();
    for (const value of array(source.annotations, sourcePath, 'annotations')) {
      const annotation = object(value, sourcePath, 'annotation');
      const url = string(annotation.url, sourcePath, 'annotation.url');
      if (!/^https?:\/\//i.test(url)) { warn('annotation-retained-in-source-only', sourcePath); continue; }
      if (authoredText.includes(url) || appended.has(url)) continue;
      let parsed: URL;
      try { parsed = new URL(url); } catch { invalid(sourcePath, 'annotation URL is invalid'); }
      const label = string(annotation.title ?? '', sourcePath, 'annotation.title') || url;
      body += `${body ? '\n\n' : ''}[${escapeMarkdownSyntax(trimLineEdges(label)).replace(/\n/g, ' ')}](<${destination(parsed.href)}>)`;
      appended.add(url);
      warn('missing-annotation-links-added-to-body', sourcePath);
    }
    if (array(source.sharees, sourcePath, 'sharees').length) warn('collaborators-retained-in-source-only', sourcePath);
    if (array(source.tasks, sourcePath, 'tasks').length) warn('task-metadata-retained-in-source-only', sourcePath);
    if (Object.keys(source).some(key => !noteFields.has(key))) warn('extra-note-metadata-retained-in-source-only', sourcePath);
    notes.push({ sourcePath, title, body, kind: source.listContent === undefined ? 'text' : 'checklist', color: colors[color],
      pinned: boolean(source.isPinned, sourcePath, 'isPinned'), archived: boolean(source.isArchived, sourcePath, 'isArchived'),
      trashed: boolean(source.isTrashed, sourcePath, 'isTrashed'),
      createdAt: timestamp(source.createdTimestampUsec, sourcePath, 'createdTimestampUsec'),
      updatedAt: timestamp(source.userEditedTimestampUsec, sourcePath, 'userEditedTimestampUsec'),
      items, attachments, labels, takeout: { sourcePath, rawHash: raw.hash, labels: [...labels] } });
  }
  if (!notes.length) throw new Error('No Google Keep JSON notes were found.');
  for (const [sourcePath] of files) {
    const extension = path.posix.extname(sourcePath).toLowerCase();
    if (extension === '.json' || extension === '.html' || referenced.has(sourcePath)) continue;
    await blob(sourcePath, types[extension] ?? 'application/octet-stream', 'unreferenced');
    warn('unreferenced-file-preserved', sourcePath);
  }
  const blobs = [...blobsByHash.values()].sort((a, b) => a.hash.localeCompare(b.hash));
  return { notes, blobs, warnings: [...warnings].sort(([a], [b]) => a.localeCompare(b)).map(([code, paths]): KeepSourceWarning => ({ code, sourcePaths: [...paths].sort() })),
    counts: { files: files.size, sourceBytes: [...files.values()].reduce((sum, file) => sum + file.size, 0), notes: notes.length,
      blobs: blobs.length, blobBytes: blobs.reduce((sum, file) => sum + file.size, 0), validatedImages: imageHashes.size,
      checklistItems: notes.reduce((sum, note) => sum + note.items.length, 0) } };
}
