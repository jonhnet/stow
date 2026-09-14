import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { plainText } from '../src/Markdown';

const render = (text: string, inline = false) => renderToStaticMarkup(createElement(Markdown, { text, inline }));

test('Markdown renders nested inline formatting and preserves single newlines', () => {
  assert.equal(render('**bold and *italic***, ~~done~~, `a < b`\nnext', true), '<span class="markdown-inline"><strong>bold and <em>italic</em></strong>, <s>done</s>, <code>a &lt; b</code><br/>next</span>');
  assert.equal(render('First\nSecond'), '<div class="markdown-body"><p>First<br/>Second</p></div>');
});

test('checklist Markdown keeps block syntax literal and creates no nested controls', () => {
  const html = render('# Heading\n- [ ] item\n> quote\n---', true);
  assert.equal(html, '<span class="markdown-inline"># Heading<br/>- [ ] item<br/>&gt; quote<br/>---</span>');
  assert.doesNotMatch(html, /<(h1|ul|li|blockquote|input|hr)\b/);
});

test('note Markdown supports headings, lists, quotes, code, and aligned tables', () => {
  const html = render('# Heading\n\n> Quote\n\n3. Three\n4. Four\n\n```js\nconst x = "<script>";\n```\n\n| Name | Value |\n| --- | ---: |\n| a | **b** |');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<blockquote><p>Quote<\/p><\/blockquote>/);
  assert.match(html, /<ol start="3"><li>Three<\/li><li>Four<\/li><\/ol>/);
  assert.match(html, /<pre><code>const x = &quot;&lt;script&gt;&quot;;\n<\/code><\/pre>/);
  assert.match(html, /<table><thead><tr><th>Name<\/th><th style="text-align:right">Value<\/th>/);
  assert.match(html, /<td style="text-align:right"><strong>b<\/strong><\/td>/);
});

test('plain links use parser punctuation handling, balanced parentheses, www, and email', () => {
  const html = render('See https://example.com/path_(one). Then www.example.org, or person@example.com.', true);
  assert.match(html, /href="https:\/\/example.com\/path_\(one\)"[^>]*>https:\/\/example.com\/path_\(one\)<\/a>\. Then/);
  assert.match(html, /href="http:\/\/www.example.org\/"[^>]*>www.example.org<\/a>,/);
  assert.match(html, /href="mailto:person@example.com"[^>]*>person@example.com<\/a>\./);
  assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 3);
});

test('raw HTML is text and unsupported link protocols retain labels without anchors', () => {
  const html = render('<script>alert(1)</script> <img src=x onerror=alert(2)>\n\n[bad](javascript:alert(3)) [data](data:text/html,hello) [file](file:///etc/passwd) [relative](/api/logout) [safe](https://example.com)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.doesNotMatch(html, /<(script|img)\b/);
  assert.doesNotMatch(html, /href="(?:javascript|data|file|\/api)/);
  assert.match(html, /<p>bad data file relative <a href="https:\/\/example.com\/"/);
});

test('Markdown images become labeled links and never fetch image URLs', () => {
  const html = render('![*diagram*](https://example.com/private.png "Diagram") ![](https://example.com/blank.png) ![bad](data:image/png;base64,abcd)', true);
  assert.doesNotMatch(html, /<img\b|src=|<link\b/);
  assert.match(html, /href="https:\/\/example.com\/private.png" title="Diagram"[^>]*>diagram<\/a>/);
  assert.match(html, /href="https:\/\/example.com\/blank.png"[^>]*>Image<\/a>/);
  assert.match(html, / bad<\/span>$/);
});

test('Markdown plain text uses rendered escapes, entities, image labels and block boundaries', () => {
  const source = '# Heading\n\n**Bold** and *italic* a\\_b \\*literal\\* &amp;lt; &lt;tag&gt;\nNext\n\n[Named link](https://example.com/path) ![*diagram*](https://example.com/image.png)\n\n```\nraw_<code>\n```';
  assert.equal(plainText(source), 'Heading\nBold and italic a_b *literal* &lt; <tag>\nNext\nNamed link diagram\nraw_<code>');
  assert.equal(plainText('# Literal heading\n- literal list\n**bold**', true), '# Literal heading\n- literal list\nbold');
  assert.equal(plainText('![](https://example.com/image.png)', true), 'Image');
});

test('Markdown retains repeated and entity-escaped leading spaces with one break per newline', () => {
  const source = '&#32;&#32;&#32;&#32;Indented   words\nSecond  line\n&#32;&#32;Third';
  assert.equal(plainText(source), '    Indented   words\nSecond  line\n  Third');
  assert.equal(render(source), '<div class="markdown-body"><p>    Indented   words<br/>Second  line<br/>  Third</p></div>');
  assert.equal(render(source, true), '<span class="markdown-inline">    Indented   words<br/>Second  line<br/>  Third</span>');
});
