import { createElement, Fragment, memo, type CSSProperties, type ReactNode } from 'react';
import MarkdownIt, { type Token } from 'markdown-it';
import { installMarkdownSourceMap, sourceOffsets } from './markdownSourceMap';
import { registerMarkdownSource } from './markdownCaret';

const parser = new MarkdownIt({ html: false, linkify: true, breaks: true });
parser.linkify.set({ fuzzyLink: true });
// Keep labels for unsupported destinations. Rendering below is the only place
// that creates links, and it permits only explicit web and email protocols.
parser.validateLink = () => true;
installMarkdownSourceMap(parser);

function safeHref(value: string | number | null): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function link(token: Token, children: MarkdownNode[]): MarkdownNode[] {
  const href = safeHref(token.attrGet(token.type === 'image' ? 'src' : 'href'));
  if (!href) return children;
  return [{ tag: 'a', attributes: { href, ...(token.attrGet('title') ? { title: String(token.attrGet('title')) } : {}), target: '_blank', rel: 'noopener noreferrer' }, children }];
}

function imageLabel(token: Token): string {
  return token.children?.map(child => child.type === 'image'
    ? imageLabel(child)
    : child.type === 'softbreak' || child.type === 'hardbreak' ? '\n' : child.content).join('') || 'Image';
}

function parseMarkdown(text: string, inline: boolean, sourceMap = false) {
  const env = { stowSourceMap: sourceMap };
  return inline ? parser.parseInline(text, env) : parser.parse(text, env);
}

/** Visible text for current-note search, using exactly the renderer's parser. */
export function plainText(text: string, inline = false): string {
  const parts: string[] = [];
  const boundary = () => { if (parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n'); };
  const collect = (tokens: Token[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case 'inline': collect(token.children ?? []); break;
        case 'text':
        case 'code_inline': parts.push(token.content); break;
        case 'code_block':
        case 'fence': boundary(); parts.push(token.content); boundary(); break;
        case 'softbreak':
        case 'hardbreak': parts.push('\n'); break;
        case 'image': parts.push(imageLabel(token)); break;
        case 'hr': boundary(); break;
        default: if (token.block && token.nesting === -1) boundary();
      }
    }
  };
  collect(parseMarkdown(text, inline));
  return parts.join('').replace(/\n+$/, '');
}

const containerTags = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li',
  'em', 'strong', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

type MarkdownNode = string | { tag: string; attributes: Record<string, string>; children: MarkdownNode[]; offsets?: readonly number[] };

function tokenText(token: Token): MarkdownNode {
  const offsets = sourceOffsets(token);
  return offsets ? { tag: 'span', attributes: {}, children: [token.content], offsets } : token.content;
}

/** One allowlisted element tree for the interactive renderer and textual exports. */
function markdownNodes(tokens: Token[]): MarkdownNode[] {
  let index = 0;
  function sequence(): MarkdownNode[] {
    const children: MarkdownNode[] = [];
    const element = (tag: string, nested: MarkdownNode[] = [], attributes: Record<string, string> = {}) => children.push({ tag, attributes, children: nested });
    while (index < tokens.length) {
      const token = tokens[index++];
      if (token.nesting === -1) return children;
      if (token.nesting === 1) {
        const nested = sequence();
        if (token.hidden) children.push(...nested);
        else if (token.type === 'link_open') children.push(...link(token, nested));
        else {
          if (!containerTags.has(token.tag)) throw new Error(`Unsupported Markdown container: ${token.type}`);
          const attributes: Record<string, string> = {};
          if (token.tag === 'ol' && token.attrGet('start')) attributes.start = String(Number(token.attrGet('start')));
          if (token.tag === 'td' || token.tag === 'th') {
            const alignment = token.attrGet('style');
            if (typeof alignment === 'string' && ['text-align:left', 'text-align:center', 'text-align:right'].includes(alignment)) attributes.style = alignment;
          }
          element(token.tag, nested, attributes);
        }
        continue;
      }
      switch (token.type) {
        case 'text': children.push(tokenText(token)); break;
        case 'inline': children.push(...markdownNodes(token.children || [])); break;
        case 'softbreak':
        case 'hardbreak': element('br'); break;
        case 'code_inline': element('code', [tokenText(token)]); break;
        case 'code_block':
        case 'fence': element('pre', [{ tag: 'code', attributes: {}, children: [tokenText(token)] }]); break;
        case 'hr': element('hr'); break;
        case 'image': children.push(...link(token, [imageLabel(token)])); break;
        default: throw new Error(`Unsupported Markdown token: ${token.type}`);
      }
    }
    return children;
  }
  return sequence();
}

function reactNodes(nodes: MarkdownNode[], interactive: boolean): ReactNode[] {
  return nodes.map((node, key) => {
    if (typeof node === 'string') return node;
    const children = reactNodes(node.children, interactive);
    if (node.tag === 'a' && !interactive) return createElement(Fragment, { key }, children);
    const { style, ...attributes } = node.attributes;
    const props: Record<string, unknown> = { key, ...attributes };
    if (node.offsets) {
      props['data-markdown-source'] = '';
      props.ref = (element: HTMLElement | null) => { if (element) registerMarkdownSource(element, node.offsets!); };
    }
    if (style) props.style = { textAlign: style.slice('text-align:'.length) } as CSSProperties;
    if (node.tag === 'a') {
      props.onClick = (event: React.MouseEvent) => event.stopPropagation();
      props.onPointerDown = (event: React.PointerEvent) => event.stopPropagation();
    }
    return createElement(node.tag, props, ...children);
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** HTML uses exactly the same safe element tree as the note renderer. */
export function markdownHtml(text: string, inline = false): string {
  const serialize = (nodes: MarkdownNode[]): string => nodes.map(node => {
    if (typeof node === 'string') return escapeHtml(node);
    const attributes = Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
    return `<${node.tag}${attributes}>${node.tag === 'br' || node.tag === 'hr' ? '' : `${serialize(node.children)}</${node.tag}>`}`;
  }).join('');
  return serialize(markdownNodes(parseMarkdown(text, inline)));
}

/** Readable rendered Markdown, retaining safe link destinations for copying. */
export function markdownText(text: string, inline = false): string {
  const serialize = (nodes: MarkdownNode[]): string => nodes.map(node => {
    if (typeof node === 'string') return node;
    const content = serialize(node.children);
    if (node.tag === 'a') return content === node.attributes.href || `mailto:${content}` === node.attributes.href ? content : `${content} (${node.attributes.href})`;
    if (node.tag === 'br') return '\n';
    if (node.tag === 'hr') return '\n---\n\n';
    if (node.tag === 'ul' || node.tag === 'ol') {
      let ordinal = Number(node.attributes.start || '1');
      return node.children.map(child => {
        const value = (typeof child === 'string' ? child : child.children.map(part =>
          (typeof part !== 'string' && (part.tag === 'ul' || part.tag === 'ol') ? '\n' : '') + serialize([part]),
        ).join('')).replace(/\n+$/, '');
        const prefix = node.tag === 'ol' ? `${ordinal++}. ` : '- ';
        return prefix + value.replace(/\n/g, '\n' + ' '.repeat(prefix.length));
      }).join('\n') + '\n\n';
    }
    if (node.tag === 'blockquote') return content.replace(/\n+$/, '').split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    if (node.tag === 'tr') return node.children.map(child => serialize(typeof child === 'string' ? [child] : child.children).trim()).join(' | ') + '\n';
    if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table'].includes(node.tag)) return content.replace(/\n+$/, '') + '\n\n';
    return content;
  }).join('');
  return serialize(markdownNodes(parseMarkdown(text, inline))).replace(/\n+$/, '');
}

export type MarkdownProps = { text: string; inline?: boolean; className?: string; interactive?: boolean; sourceMap?: boolean };

/** Same parser for notes and checklist labels; labels bypass all block rules. */
const Markdown = memo(function Markdown({ text, inline = false, className = '', interactive = true, sourceMap = false }: MarkdownProps) {
  const tokens = parseMarkdown(text, inline, sourceMap);
  return createElement(inline ? 'span' : 'div', {
    className: `${inline ? 'markdown-inline' : 'markdown-body'} ${className}`.trim(),
  }, reactNodes(markdownNodes(tokens), interactive));
});

export default Markdown;
