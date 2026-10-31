import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.js';

const sender = 'Telegram @fixture_bot';
function fixture() {
  const store = new Store(':memory:');
  const session = store.createSession(
    { botId: 1, chatId: -100, threadId: 42, instancePath: '/fixture' },
    'Provenance',
  );
  return { store, id: session.id };
}

test('receipt replay respects its submission boundary, sender, entry identity and explicit rejection', () => {
  const { store, id } = fixture();
  try {
    const content = { text: 'Repeated request' };
    store.recordPromptSubmission(id, sender, content, 100);
    const boundary = store.beginPromptReceiptSnapshot(id);
    store.recordPromptSubmission(id, sender, content, 101);
    assert.equal(
      store.recordPromptReceipt(id, 'old-recovered', sender, content, boundary).messageId,
      100,
    );
    assert.equal(store.recordPromptReceipt(id, 'new-live', sender, content).messageId, 101);
    assert.deepEqual(store.recordPromptReceipt(id, 'old-recovered', sender, content), {
      fresh: false,
      messageId: 100,
    });
    const emptyBoundary = store.beginPromptReceiptSnapshot(id);
    store.recordPromptSubmission(id, sender, content, 102);
    assert.equal(
      store.recordPromptReceipt(id, 'older-unseen', sender, content, emptyBoundary).messageId,
      undefined,
    );
    assert.equal(
      store.recordPromptReceipt(id, 'foreign', 'Mini App member', content).messageId,
      undefined,
    );
    assert.equal(store.recordPromptReceipt(id, 'current-live', sender, content).messageId, 102);
    const rejected = store.recordPromptSubmission(id, sender, content, 103);
    store.rejectPromptSubmission(rejected);
    store.recordPromptSubmission(id, sender, content, 104);
    assert.equal(
      store.recordPromptReceipt(id, 'accepted-after-rejection', sender, content).messageId,
      104,
    );
  } finally {
    store.close();
  }
});

test('image provenance supports partial receipts and refuses ambiguous interrupted duplicates', () => {
  const { store, id } = fixture();
  const image = {
    text: '',
    images: [{ type: 'image' as const, mimeType: 'image/png', data: 'AAAA' }],
  };
  const otherImage = {
    text: '',
    images: [{ type: 'image' as const, mimeType: 'image/png', data: 'BBBB' }],
  };
  try {
    store.recordPromptSubmission(id, sender, image, 200);
    store.recordPromptSubmission(id, sender, otherImage, 201);
    assert.equal(store.recordPromptReceipt(id, 'full-image', sender, otherImage).messageId, 201);
    assert.equal(
      store.recordPromptReceipt(id, 'partial-image', sender, { text: '' }).messageId,
      200,
    );
    store.recordPromptSubmission(id, sender, image, 202);
    store.beginPromptReceiptSnapshot(id);
    store.recordPromptSubmission(id, sender, image, 203);
    const first = store.recordPromptReceipt(id, 'ambiguous-one', sender, image);
    assert.equal(first.messageId, undefined);
    assert.equal(first.submissionId, undefined);
    assert.deepEqual(store.recordPromptReceipt(id, 'ambiguous-one', sender, image), {
      fresh: false,
    });
    assert.equal(
      store.recordPromptReceipt(id, 'ambiguous-two', sender, image).messageId,
      undefined,
    );
    store.recordPromptSubmission(id, sender, image, 204);
    assert.equal(store.recordPromptReceipt(id, 'unambiguous-again', sender, image).messageId, 204);
  } finally {
    store.close();
  }
});

test('an uncorrelated shrunk image receipt cannot steal a later text-only destination', () => {
  const { store, id } = fixture();
  try {
    const image = {
      text: 'Shared caption',
      images: [{ type: 'image' as const, mimeType: 'image/png', data: 'original-image-data' }],
    };
    const shrunk = {
      text: image.text,
      images: [{ ...image.images[0]!, data: 'truncated-image-data' }],
    };
    store.recordPromptSubmission(id, sender, image, 300);
    assert.equal(
      store.recordPromptReceipt(id, 'shrunk-image', sender, shrunk).messageId,
      undefined,
    );
    store.recordPromptSubmission(id, sender, { text: image.text }, 301);
    assert.equal(
      store.recordPromptReceipt(id, 'subsequent-text', sender, { text: image.text }).messageId,
      301,
    );
  } finally {
    store.close();
  }
});
