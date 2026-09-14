import type { Env, MarkdownIt, StateCore, Token } from 'markdown-it';

const positions = new WeakMap<Token, number[]>();

/** UTF-16 insertion positions in the original Markdown, one per content boundary. */
export function sourceOffsets(token: Token): number[] | undefined {
  return positions.get(token);
}

type Source = { text: string; offsets: number[]; end?: number };

function normalizedSource(text: string): Source {
  let normalized = '';
  const offsets = [0];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\r' && text[index + 1] === '\n') index++;
    normalized += character === '\r' ? '\n' : character === '\0' ? '\ufffd' : character;
    offsets.push(index + 1);
  }
  return { text: normalized, offsets };
}

function mapInline(parser: MarkdownIt, env: Env, tokens: Token[], source: Source) {
  let cursor = 0;
  const raw = source.text;
  const at = (position: number) => source.offsets[Math.max(0, Math.min(position, source.offsets.length - 1))];
  const links: Array<{ end: number; after: number }> = [];
  const state = new parser.inline.State(raw, parser, env, []);

  function labelBounds(start: number) {
    const end = parser.helpers.parseLinkLabel(state, start, false);
    let after = end + 1;
    if (raw[after] === '(') {
      let position = after + 1;
      while (/\s/.test(raw[position] ?? '') && position < raw.length) position++;
      const destination = parser.helpers.parseLinkDestination(raw, position, raw.length);
      if (destination.ok) position = destination.pos;
      const beforeWhitespace = position;
      while (/\s/.test(raw[position] ?? '') && position < raw.length) position++;
      if (position > beforeWhitespace) {
        const title = parser.helpers.parseLinkTitle(raw, position, raw.length);
        if (title.ok) position = title.pos;
        while (/\s/.test(raw[position] ?? '') && position < raw.length) position++;
      }
      if (raw[position] === ')') after = position + 1;
    } else if (raw[after] === '[') {
      const referenceEnd = parser.helpers.parseLinkLabel(state, after, false);
      if (referenceEnd >= 0) after = referenceEnd + 1;
    }
    return { end, after };
  }

  function textOffsets(content: string): number[] {
    const offsets = [at(cursor)];
    for (let output = 0; output < content.length;) {
      const encoded = /^(?:\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#[xX][\da-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z\d]{1,31});)/.exec(raw.slice(cursor))?.[0];
      let decoded = encoded ? parser.utils.unescapeAll(encoded) : raw[cursor];
      // Inline numeric entities replace invalid code points. unescapeAll uses
      // link-destination semantics instead, retaining invalid entities verbatim.
      if (encoded?.startsWith('&#')) {
        const hex = encoded[2].toLowerCase() === 'x';
        const code = parseInt(encoded.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
        decoded = parser.utils.isValidEntityCode(code) ? parser.utils.fromCodePoint(code) : '\ufffd';
      }
      if (decoded && content.startsWith(decoded, output)) {
        const length = encoded?.length ?? 1;
        for (let index = 1; index <= decoded.length; index++) offsets.push(at(cursor + (decoded === encoded ? index : index === decoded.length ? length : 0)));
        output += decoded.length;
        cursor += length;
      } else {
        // Linkification can display decoded Unicode URLs. Those link labels are
        // generated text; map their characters within the recognized link span.
        const link = links[links.length - 1];
        if (!link) {
          // Display text without a matching source unit has no exact insertion
          // position. Keep it at this token's known boundary within the block.
          while (output++ < content.length) offsets.push(at(cursor));
          break;
        }
        offsets.push(at(Math.min(++cursor, link.end)));
        output++;
      }
    }
    return offsets;
  }

  for (const token of tokens) {
    if (token.type === 'text') {
      positions.set(token, textOffsets(token.content));
    } else if (['em_open', 'em_close', 'strong_open', 'strong_close', 's_open', 's_close'].includes(token.type)) {
      cursor += token.markup.length;
    } else if (token.type === 'link_open') {
      if (raw[cursor] === '[') {
        links.push(labelBounds(cursor));
        cursor++;
      } else if (token.markup === 'autolink') {
        const end = raw.indexOf('>', cursor);
        links.push({ end, after: end + 1 });
        cursor++;
      } else {
        const match = parser.linkify.match(raw.slice(cursor))?.find(value => value.index === 0);
        const end = cursor + (match?.raw.replace(/\*+$/, '').length ?? 0);
        links.push({ end, after: end });
      }
    } else if (token.type === 'link_close') {
      cursor = links.pop()!.after;
    } else if (token.type === 'image') {
      const bounds = labelBounds(cursor + 1);
      const start = cursor + 2;
      positions.set(token, source.offsets.slice(start, bounds.end + 1));
      mapInline(parser, env, token.children ?? [], { text: raw.slice(start, bounds.end), offsets: source.offsets.slice(start, bounds.end + 1) });
      cursor = bounds.after;
    } else if (token.type === 'code_inline') {
      let start = cursor + token.markup.length;
      let end = raw.indexOf(token.markup, start);
      while (end >= 0) {
        let runEnd = end + token.markup.length;
        while (raw[runEnd] === '`') runEnd++;
        if (runEnd - end === token.markup.length) break;
        end = raw.indexOf(token.markup, runEnd);
      }
      if (end < 0) {
        positions.set(token, Array(token.content.length + 1).fill(at(cursor)));
        continue;
      }
      cursor = end + token.markup.length;
      const content = raw.slice(start, end).replace(/\n/g, ' ');
      if (content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) { start++; end--; }
      positions.set(token, source.offsets.slice(start, end + 1));
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      const newline = raw.indexOf('\n', cursor);
      positions.set(token, [at(newline), at(newline + 1)]);
      cursor = newline + 1;
      while (raw[cursor] === ' ' || raw[cursor] === '\t') cursor++;
    }
  }
}

/** Map a block's extracted content to its original lines, including stripped prefixes. */
function blockSource(content: string, source: Source, lineStarts: number[], lines: [number, number], skipFirst: boolean, startCursor = 0, table = false): Source {
  const offsets: number[] = [];
  const parts = content.split('\n');
  let line = lines[0] + Number(skipFirst);
  let last = lineStarts[line] ?? source.text.length;
  for (let index = 0; index < parts.length; index++, line++) {
    const start = lineStarts[line] ?? source.text.length;
    const end = Math.min(lineStarts[line + 1] ?? source.text.length, source.text.length);
    let text = source.text.slice(start, end).replace(/\n$/, '');
    let lineOffsets = Array.from({ length: text.length + 1 }, (_, position) => start + position);
    if (table) {
      const retained: number[] = [];
      for (let position = 0; position < text.length; position++) if (!(text[position] === '\\' && text[position + 1] === '|')) retained.push(position);
      // The boundary before an escaped pipe belongs before its backslash, so
      // inserting there cannot split the escape; the next boundary follows it.
      lineOffsets = [...retained.map(position => start + position - Number(text[position] === '|' && text[position - 1] === '\\')), start + text.length];
      // Unescaped pipes delimit cells, so they cannot match a cell's text. NUL
      // cannot occur in inline content: Markdown's normalization replaces it.
      text = retained.map(position => text[position] === '|' && text[position - 1] !== '\\' ? '\0' : text[position]).join('');
    }
    const part = parts[index];
    const minimum = index === 0 ? Math.max(0, lineOffsets.findIndex(position => position >= startCursor)) : 0;
    const found = text.indexOf(part, minimum);
    if (found >= 0) {
      for (let position = 0; position < part.length; position++) offsets.push(source.offsets[lineOffsets[found + position]]);
      last = lineOffsets[found + part.length];
    } else {
      // Removing block indentation can leave virtual spaces from a partial tab.
      // Their source position is the boundary before the remaining literal text.
      const literal = part.replace(/^[ \t]+/, '');
      const literalAt = text.indexOf(literal, minimum);
      const padding = part.length - literal.length;
      const boundary = lineOffsets[literalAt >= 0 ? literalAt : minimum];
      for (let position = 0; position < part.length; position++) offsets.push(source.offsets[literalAt >= 0 && position >= padding ? lineOffsets[literalAt + position - padding] : boundary]);
      last = literalAt >= 0 ? lineOffsets[literalAt + literal.length] : boundary;
    }
    if (index + 1 < parts.length) offsets.push(source.offsets[end - Number(source.text[end - 1] === '\n')]);
  }
  offsets.push(source.offsets[last]);
  return { text: content, offsets, end: last };
}

/** Adds mappings only for parses explicitly requested by an editable preview. */
export function installMarkdownSourceMap(parser: MarkdownIt): void {
  const sources = new WeakMap<StateCore, Source>();
  parser.core.ruler.before('normalize', 'stow_source_original', state => {
    if (state.env.stowSourceMap) sources.set(state, normalizedSource(state.src));
  });
  parser.core.ruler.push('stow_source_offsets', state => {
    const source = sources.get(state);
    if (!source) return;
    const lineStarts = [0];
    for (let index = 0; index < source.text.length; index++) if (source.text[index] === '\n') lineStarts.push(index + 1);
    let row: [number, number] | undefined;
    let rowCursor = 0;
    const containers: Token[] = [];
    for (const token of state.tokens) {
      if (token.type === 'blockquote_open' || token.type === 'list_item_open') containers.push(token);
      if (token.type === 'blockquote_close' || token.type === 'list_item_close') containers.pop();
      if (token.type === 'tr_open') {
        row = token.map!;
        rowCursor = lineStarts[row[0]];
        // The parser identifies the enclosing containers and their literal
        // markers; exclude those markers from the table's first cell matches.
        for (const container of containers) {
          while (source.text[rowCursor] === ' ' || source.text[rowCursor] === '\t') rowCursor++;
          const marker = container.type === 'blockquote_open' ? '>' : container.map?.[0] === row[0] ? container.info + container.markup : '';
          if (marker && source.text.startsWith(marker, rowCursor)) rowCursor += marker.length;
        }
      }
      if (token.type === 'tr_close') row = undefined;
      if (token.type !== 'inline' && token.type !== 'fence' && token.type !== 'code_block') continue;
      const mapped = state.inlineMode ? source : blockSource(token.content, source, lineStarts, token.map ?? row!, token.type === 'fence', row ? rowCursor : 0, !!row);
      positions.set(token, mapped.offsets);
      if (row) rowCursor = mapped.end!;
      if (token.type === 'inline') mapInline(parser, state.env, token.children ?? [], mapped);
    }
  });
}
