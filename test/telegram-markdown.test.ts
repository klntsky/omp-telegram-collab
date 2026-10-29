import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTelegramMarkdown } from '../src/telegram-markdown.js';

function decodedText(html: string, limit = 4000, expected: { tags?: readonly string[]; href?: string } = {}): string {
  const stack: string[] = [];
  const parts: string[] = [];
  let consumed = 0;
  for (const match of html.matchAll(/<([^>]+)>|([^<]+)/g)) {
    consumed += match[0].length;
    if (match[2] !== undefined) {
      for (const tag of expected.tags ?? []) assert.ok(stack.includes(tag), `Visible text lost its ${tag} entity`);
      parts.push(match[2]);
      continue;
    }
    const body = match[1]!;
    const closing = body.startsWith('/');
    const name = body.replace(/^\//, '').split(' ')[0]!;
    assert.ok(['b', 'i', 's', 'code', 'pre', 'a', 'blockquote'].includes(name), `Unsupported Telegram tag: ${name}`);
    if (closing) assert.equal(stack.pop(), name, 'Every chunk must close its own tags in order');
    else {
      assert.ok(!stack.includes(name), `Nested ${name} entities are not allowed`);
      if (name === 'code') assert.ok(stack.length === 0 || (stack.length === 1 && stack[0] === 'pre'));
      if (name === 'pre') assert.equal(stack.length, 0);
      if (name === 'a' && expected.href) {
        const href = body.match(/\bhref="([^"]*)"/)?.[1];
        assert.ok(href, 'Link entity must retain its destination');
        const decodedHref = href.replace(/&(amp|lt|gt|quot);/g, (_entity, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[entity]!);
        assert.equal(new URL(decodedHref).href, new URL(expected.href).href);
      }
      stack.push(name);
    }
  }
  assert.equal(consumed, html.length, 'Literal HTML must be escaped');
  assert.deepEqual(stack, []);
  const text = parts.join('');
  assert.ok(!/[<>]/.test(text), 'Literal HTML must be escaped');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(text), 'HTML entities must not be cut or left unescaped');
  const decoded = text.replace(/&(amp|lt|gt|quot);/g, (_entity, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[name]!);
  assert.ok(decoded.length <= limit, `Chunk has ${decoded.length} decoded UTF-16 units`);
  for (const character of decoded) assert.ok(character.length !== 1 || !/[\uD800-\uDFFF]/.test(character), 'Chunk split a Unicode code point');
  return decoded;
}

test('agent Markdown renders as Telegram-supported headings, emphasis, links, lists and quotes', () => {
  assert.deepEqual(renderTelegramMarkdown('# Heading\n\n**bold** *italic* ~~gone~~ [site](https://example.com/?a=1&b=2)'), [
    '<b>Heading</b>\n\n<b>bold</b> <i>italic</i> <s>gone</s> <a href="https://example.com/?a=1&amp;b=2">site</a>',
  ]);
  const [html] = renderTelegramMarkdown('- one\n- **two**\n\n3. three\n4. four\n\n> quoted **text**');
  assert.equal(html, '• one\n• <b>two</b>\n\n3. three\n4. four\n\n<blockquote>quoted <b>text</b></blockquote>');
  assert.equal(decodedText(html!), '• one\n• two\n\n3. three\n4. four\n\nquoted text');
});

test('code retains tabs, whitespace, punctuation and Unicode without interpreting Markdown or HTML', () => {
  const literal = '\tconst text = "<b> **raw** & 😀 中文";\n  return text;';
  const [html] = renderTelegramMarkdown(`\`\`\`ts\n${literal}\n\`\`\``);
  assert.equal(html, '<pre><code class="language-ts">\tconst text = &quot;&lt;b&gt; **raw** &amp; 😀 中文&quot;;\n  return text;\n</code></pre>');
  assert.equal(decodedText(html!), `${literal}\n`);
  assert.deepEqual(renderTelegramMarkdown('**before `a < b && 😀` after**'), [
    '<b>before </b><code>a &lt; b &amp;&amp; 😀</code><b> after</b>',
  ]);
  const windowsCode = '\tfirst();\r\n  second(\"😀\");\r\n';
  assert.equal(renderTelegramMarkdown(`\`\`\`js\r\n${windowsCode}\`\`\`\r\n`).map(chunk => decodedText(chunk)).join(''), windowsCode);
  assert.equal(renderTelegramMarkdown('```\nunterminated\t😀').map(chunk => decodedText(chunk)).join(''), 'unterminated\t😀');
});

test('raw HTML is escaped and unsafe links never become Telegram entities', () => {
  const [html] = renderTelegramMarkdown('<b>raw & text</b>\n\n[bad](javascript:alert) [file](file:///tmp/key) [relative](/private) [mail](mailto:ada@example.com)');
  assert.equal(html, '&lt;b&gt;raw &amp; text&lt;/b&gt;\n\nbad file relative <a href="mailto:ada@example.com">mail</a>');
  assert.equal(decodedText(html!), '<b>raw & text</b>\n\nbad file relative mail');
  const [attribute] = renderTelegramMarkdown('[safe](https://example.com/"quoted")');
  assert.equal(attribute, '<a href="https://example.com/%22quoted%22">safe</a>');
});

test('long rich messages split on decoded limits, reopening complete tags without splitting entities or Unicode', () => {
  const literal = '😀e\u0301<&中文'.repeat(1600);
  const chunks = renderTelegramMarkdown(`**[${literal}](https://example.com)**`);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.map(chunk => decodedText(chunk, 4000, { tags: ['b', 'a'], href: 'https://example.com' })).join(''), literal);
  const codeChunks = renderTelegramMarkdown(`\`\`\`text\n${literal}\n\`\`\``);
  assert.equal(codeChunks.map(chunk => decodedText(chunk, 4000, { tags: ['pre', 'code'] })).join(''), `${literal}\n`);
});

test('boundaries between formatting runs remain balanced and small chunk limits make progress', () => {
  const chunks = renderTelegramMarkdown('a**😀b**c', 2);
  assert.deepEqual(chunks, ['a', '<b>😀</b>', '<b>b</b>c']);
  assert.equal(chunks.map(chunk => decodedText(chunk, 2)).join(''), 'a😀bc');
  const [nested] = renderTelegramMarkdown('> outer\n>\n> > inner `code`');
  assert.equal(decodedText(nested!), 'outer\n\ninner code');
  assert.throws(() => renderTelegramMarkdown('x', 1), RangeError);
});

test('tables preserve column structure in Telegram preformatted entities; images and tasks remain readable', () => {
  const [html] = renderTelegramMarkdown('| Name | Value |\n| --- | ---: |\n| **item** | 42 |\n\n![diagram](https://example.com/image.png)\n\n- [x] done\n- [ ] pending');
  assert.equal(decodedText(html!), 'Name | Value\n-----+------\nitem |    42\n\ndiagram (https://example.com/image.png)\n\n• ☑ done\n• ☐ pending');
  assert.ok(html!.startsWith('<pre><code>Name | Value\n-----+------\nitem |    42</code></pre>'));
  assert.ok(!/<(?:table|img|ul|li|h1|p|br)\b/.test(html!));
});
