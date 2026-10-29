import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTelegramMarkdown } from '../src/telegram-markdown.js';

test('long replies keep complete tables with neighboring blocks', () => {
  const paragraph = 'a'.repeat(32760) + '\n\n';
  const table = '| Name | Value |\n| --- | ---: |\n| **item** | 42 |\n';
  assert.deepEqual(renderTelegramMarkdown(paragraph + table), [paragraph, table]);
});

test('oversized literal code remains fenced and Unicode stays intact', () => {
  const body = '😀`<&'.repeat(10000);
  const chunks = renderTelegramMarkdown('```ts\n' + body + '\n```');
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 32768 && chunk.isWellFormed()));
  assert.equal(chunks.map(chunk => chunk.slice('```ts\n'.length, -'\n```'.length)).join(''), body);
});
