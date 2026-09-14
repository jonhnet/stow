import assert from 'node:assert/strict';
import test from 'node:test';
import MarkdownIt, { type Token } from 'markdown-it';
import { installMarkdownSourceMap, sourceOffsets } from '../src/markdownSourceMap';

const parser = new MarkdownIt({ html: false, linkify: true, breaks: true });
parser.linkify.set({ fuzzyLink: true });
parser.validateLink = () => true;
installMarkdownSourceMap(parser);

function leaves(source: string, inline = false): Token[] {
  const tokens = inline ? parser.parseInline(source, { stowSourceMap: true }) : parser.parse(source, { stowSourceMap: true });
  return tokens.flatMap(token => token.children ?? [token]);
}

function occurrence(source: string, text: string, expected: number, inline = false, last = false) {
  const candidates = leaves(source, inline).filter(token => ['text', 'code_inline', 'code_block', 'fence'].includes(token.type) && token.content.includes(text));
  const token = last ? candidates[candidates.length - 1] : candidates[0];
  assert.ok(token, `Missing ${text}`);
  const local = last ? token.content.lastIndexOf(text) : token.content.indexOf(text);
  assert.equal(sourceOffsets(token)?.[local], expected, `${JSON.stringify(source)}: ${text}`);
}

test('source mapping preserves repeated words across formatting and hidden link destinations', () => {
  for (const source of ['alpha **alpha** alpha', 'alpha [beta](https://x/alpha "alpha") alpha', 'alpha [beta][alpha] alpha\n\n[alpha]: https://x/alpha']) {
    occurrence(source, 'alpha', source.lastIndexOf(' alpha', source.indexOf('\n') < 0 ? undefined : source.indexOf('\n')) + 1, false, true);
  }
  occurrence('***bold and *italic* bold***', 'italic', 13);
  occurrence('~~done~~ plain', 'plain', 9);
});

test('source mapping accounts for escapes and HTML entities', () => {
  const source = String.raw`\*literal\* &amp; &#x1f680; &bogus; after`;
  occurrence(source, 'literal', source.indexOf('literal'));
  occurrence(source, 'after', source.indexOf('after'));
  const token = leaves('x &amp; y', true)[0];
  assert.deepEqual(sourceOffsets(token), [0, 1, 2, 7, 8, 9]);
});

test('source mapping handles block prefixes, code normalization, and original CRLF positions', () => {
  const source = '# Heading\r\n\r\n> Same\r\n> **Same**\r\n\r\n- Same\r\n  next\r\n\r\n```js\r\nconst x = 1;\r\n```';
  occurrence(source, 'Heading', source.indexOf('Heading'));
  occurrence(source, 'next', source.indexOf('next'));
  occurrence(source, 'const', source.indexOf('const'));
  occurrence('`` one\ntwo ``', 'two', 7, true);
  occurrence('    code\n    code', 'code', 4);
});

test('source mapping disambiguates repeated table cells and escaped pipes', () => {
  const source = '| same | same |\n| --- | --- |\n| a\\|b | **same** |';
  const tokens = leaves(source).filter(token => token.type === 'text' && token.content === 'same');
  assert.deepEqual(tokens.map(token => sourceOffsets(token)?.[0]), [2, 9, source.lastIndexOf('same')]);
  occurrence(source, 'a|b', source.indexOf('a\\|b'));
  const pipes = '| \\| | \\| |\n| --- | --- |';
  const pipeTokens = leaves(pipes).filter(token => token.type === 'text' && token.content === '|');
  assert.deepEqual(pipeTokens.map(token => sourceOffsets(token)), [[2, 4], [7, 9]]);
});

test('source mapping skips full explicit, fuzzy, email, and autolink destinations', () => {
  for (const source of [
    '[x](https://example.com/after_(one) "title") after',
    '[x]() after',
    '[x](<https://example.com/after>) after',
    'www.example.com after',
    'person@example.com after',
    '<https://example.com/after> after',
    '![*alt*](https://example.com/after) after',
  ]) occurrence(source, 'after', source.lastIndexOf('after'), true, true);
});

test('ordinary parser use does not allocate source mappings', () => {
  assert.equal(sourceOffsets(parser.parseInline('plain', {})[0].children![0]), undefined);
});

test('virtual indentation spaces map to their literal boundary and keep following text exact', () => {
  const source = '>\t\tcode\n>\t\tmore';
  const token = leaves(source).find(value => value.type === 'code_block')!;
  assert.equal(token.type, 'code_block');
  assert.equal(token.content, '  code\n  more\n');
  assert.deepEqual(sourceOffsets(token)?.slice(0, 3), [3, 3, 3]);
  occurrence(source, 'code', source.indexOf('code'));
  occurrence(source, 'more', source.indexOf('more'));
});

test('nested delimiters, hard breaks, Unicode links, and escaped table pipes retain later offsets', () => {
  for (const source of [
    '***alpha*** **b *alpha* c** alpha',
    '*https://example.com/alpha* alpha',
    '<https://xn--bcher-kva.example/alpha> alpha',
    'https://xn--bcher-kva.example/alpha alpha',
    'A  \n  B\\\n alpha',
    '[relative](/alpha) [unsafe](javascript:alpha()) alpha',
    '| a\\|b | alpha | alpha |\n| --- | --- | --- |',
  ]) occurrence(source, 'alpha', source.lastIndexOf('alpha'), false, true);
});

test('all rendered content has bounded insertion positions through unusual valid Markdown', () => {
  for (const source of [
    '\tcode\n\tmore', '  \t code\n  \t more', '-\t\tcode\n\t\tmore',
    '# # Heading #', '> > quote\n> > continued', 'a\0b',
    '| a | b |\n| - | - |\n| missing |', '| a\\|b | a\\|b |\n| --- | --- |',
    '` one\ntwo `', '`` `a` ``', '~~~\nfoo\n~~~', '```\nno final newline',
    '**a***b**c*', '\\*\\*a\\*\\*', '&#x1f680; &bogus; &#0; 😀',
    '[x]( "title") after', '[x](url "title with )") after',
  ]) {
    for (const token of leaves(source).filter(token => ['text', 'code_inline', 'code_block', 'fence'].includes(token.type))) {
      const offsets = sourceOffsets(token)!;
      assert.equal(offsets.length, token.content.length + 1, JSON.stringify(source));
      assert.ok(offsets.every(position => Number.isInteger(position) && position >= 0 && position <= source.length), JSON.stringify(source));
    }
  }
});

test('invalid and oversized numeric entities use inline-parser semantics without losing later positions', () => {
  for (const entity of ['&#x110000;', '&#xD800;', '&#0;', '&#xFFFF;', '&#0000000000000000000097;', '&#x0000000000000000000061;']) {
    occurrence(`${entity} AFTER`, 'AFTER', entity.length + 1, true);
  }
  assert.deepEqual(sourceOffsets(leaves('&#xD800; after', true)[0])?.slice(0, 3), [0, 8, 9]);
});

test('table cell content never maps onto enclosing blockquote or list markers', () => {
  for (const [source, expected] of [
    ['> | > | > |\n> | --- | --- |', [4, 8]],
    ['> > | > | > |\n> > | --- | --- |', [6, 10]],
    ['- | - | - |\n  | --- | --- |', [4, 8]],
    ['1. | 1. | 1. |\n   | --- | --- |', [5, 10]],
    ['> - | > | - |\n>   | --- | --- |', [6, 10]],
  ] as const) {
    const tokens = leaves(source).filter(token => token.type === 'text');
    assert.deepEqual(tokens.map(token => sourceOffsets(token)?.[0]), expected, source);
  }
});
