import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTopicUrl } from '../src/cli/topic-url.js';

// Permanent: URL-to-service coordinate translation must select the intended
// session for copied links and branch names. Lifecycle coverage checks the
// generated command but does not exercise parsing or thread selection.
test('topic URLs and branch names resolve to the same session coordinates', () => {
  for (const url of [
    'https://t.me/c/4458084428/7132',
    't.me/c/4458084428/7132',
    'http://t.me/c/4458084428/7132',
    'https://t.me/c/4458084428/7132/',
    'https://t.me/c/4458084428/7132/9000',
    't.me/c/4458084428/7132/9000',
    'https://t.me/c/4458084428/9000?thread=7132',
    't.me/c/4458084428/9000?thread=7132',
  ]) {
    assert.deepEqual(parseTopicUrl(url), { chat: -1004458084428, topic: 7132 }, url);
  }
});

// Permanent: untrusted CLI input must not produce unsafe service coordinates or
// reinterpret another site's path as a Telegram destination. The live lifecycle
// scenario only supplies a bot-generated valid link and cannot cover this boundary.
test('topic URL parsing rejects invalid destinations and unsafe IDs', () => {
  for (const url of [
    'https://example.com/c/4458084428/7132',
    'https://t.me.example.com/c/4458084428/7132',
    'ftp://t.me/c/4458084428/7132',
    'https://user@t.me/c/4458084428/7132',
    'https://t.me:8443/c/4458084428/7132',
    'https://t.me/c/4458084428',
    'https://t.me/c/4458084428/0',
    'https://t.me/c/4458084428/1',
    'https://t.me/c/4458084428/-2',
    'https://t.me/c/999999999999999999999/7132',
    'https://t.me/c/4458084428/9007199254740992',
    'https://t.me/c/4458084428/9000?thread=no',
    'https://t.me/c/4458084428/9000?thread=1',
    'https://t.me/c/4458084428/9000?thread=',
  ]) {
    assert.throws(() => parseTopicUrl(url), Error, url);
  }
});
