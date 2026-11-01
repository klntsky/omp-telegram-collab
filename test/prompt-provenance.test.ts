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
    store.recordPromptSubmission(id, 'omp-fixture', sender, content, 100);
    const boundary = store.beginPromptReceiptSnapshot(id, 'omp-fixture');
    store.recordPromptSubmission(id, 'omp-fixture', sender, content, 101);
    assert.equal(
      store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'old-recovered',parentEntryId:null}, sender, content, boundary).messageId,
      100,
    );
    assert.equal(store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'new-live',parentEntryId:null}, sender, content).messageId, 101);
    assert.deepEqual(store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'old-recovered',parentEntryId:null}, sender, content), {
      fresh: false,
      messageId: 100,
    });
    const emptyBoundary = store.beginPromptReceiptSnapshot(id, 'omp-fixture');
    store.recordPromptSubmission(id, 'omp-fixture', sender, content, 102);
    assert.equal(
      store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'older-unseen',parentEntryId:null}, sender, content, emptyBoundary).messageId,
      undefined,
    );
    assert.equal(
      store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'foreign',parentEntryId:null}, 'Mini App member', content).messageId,
      undefined,
    );
    assert.equal(store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'current-live',parentEntryId:null}, sender, content).messageId, 102);
    const rejected = store.recordPromptSubmission(id, 'omp-fixture', sender, content, 103);
    store.rejectPromptSubmission(rejected);
    store.recordPromptSubmission(id, 'omp-fixture', sender, content, 104);
    assert.equal(
      store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'accepted-after-rejection',parentEntryId:null}, sender, content).messageId,
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
    store.recordPromptSubmission(id, 'omp-fixture', sender, image, 200);
    store.recordPromptSubmission(id, 'omp-fixture', sender, otherImage, 201);
    assert.equal(store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'full-image',parentEntryId:null}, sender, otherImage).messageId, 201);
    assert.equal(
      store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'partial-image',parentEntryId:null}, sender, { text: '' }).messageId,
      200,
    );
    store.recordPromptSubmission(id, 'omp-fixture', sender, image, 202);
    store.beginPromptReceiptSnapshot(id, 'omp-fixture');
    store.recordPromptSubmission(id, 'omp-fixture', sender, image, 203);
    const first = store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'ambiguous-one',parentEntryId:null}, sender, image);
    assert.equal(first.messageId, undefined);
    assert.equal(first.submissionId, undefined);
    assert.deepEqual(store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'ambiguous-one',parentEntryId:null}, sender, image), {
      fresh: false,
    });
    assert.equal(
      store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'ambiguous-two',parentEntryId:null}, sender, image).messageId,
      undefined,
    );
    store.recordPromptSubmission(id, 'omp-fixture', sender, image, 204);
    assert.equal(store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'unambiguous-again',parentEntryId:null}, sender, image).messageId, 204);
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
    store.recordPromptSubmission(id, 'omp-fixture', sender, image, 300);
    assert.equal(
      store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'shrunk-image',parentEntryId:null}, sender, shrunk).messageId,
      undefined,
    );
    store.recordPromptSubmission(id, 'omp-fixture', sender, { text: image.text }, 301);
    assert.equal(
      store.recordPromptReceipt(id, {ompSessionId:'omp-fixture',entryId:'subsequent-text',parentEntryId:null}, sender, { text: image.text }).messageId,
      301,
    );
  } finally {
    store.close();
  }
});
