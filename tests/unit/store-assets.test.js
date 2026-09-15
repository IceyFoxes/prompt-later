import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateState } from '../../src/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const store = path.join(root, 'store');
const listing = JSON.parse(fs.readFileSync(path.join(store, 'listing.json'), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

test('generated store pages preserve approved source text without external executable content', () => {
  const policy = fs.readFileSync(path.join(store, 'privacy.html'), 'utf8');
  const index = fs.readFileSync(path.join(store, 'index.html'), 'utf8');
  for (const section of listing.privacySections) {
    assert(policy.includes(escape(section.heading)));
    for (const paragraph of section.paragraphs) assert(policy.includes(escape(paragraph)));
  }
  for (const value of [listing.description, listing.singlePurpose, listing.remoteCode, ...Object.values(listing.permissionJustifications), ...listing.testInstructions]) {
    assert(index.includes(escape(value)));
  }
  for (const [html, status] of [[policy, listing.privacyStatus], [index, listing.status]]) {
    assert.doesNotMatch(html, /<script\b|<iframe\b|\bsrc=["']https?:/i);
    assert.equal(html.includes('Draft — not ready for submission.'), status !== 'ready');
    if (listing.supportEmail) {
      assert(html.includes(escape(listing.supportEmail)));
      assert(!html.includes('A public support email has not been set.'));
    } else assert(html.includes('A public support email has not been set.'));
  }
});

test('store disclosures describe automatic encryption and optional dashboard-only protection without weakening release gates', () => {
  assert(['draft', 'ready'].includes(listing.status));
  assert(['draft', 'ready'].includes(listing.privacyStatus));
  assert.equal(listing.visibility, 'unlisted');
  assert.match(listing.description, /No passphrase is required/);
  assert.match(listing.description, /Advanced privacy in the full dashboard/);
  assert.match(listing.permissionJustifications.storage, /non-exportable.*IndexedDB/);
  const policy = listing.privacySections.flatMap(section => section.paragraphs).join('\n');
  assert.match(policy, /not hardware-backed/);
  assert.match(policy, /someone controlling the browser or profile/);
  assert.match(policy, /600,000 iterations/);
  assert.match(policy, /existing passphrase-protected vaults remain protected unless you explicitly disable/);
  assert.match(policy, /recoverable copies are preserved/);
  assert.doesNotMatch(policy, /paused until you create a passphrase/);
  assert.match(listing.testInstructions[0], /scheduler opens without a passphrase/);
});

test('store images have the required PNG dimensions', () => {
  for (const [name, width, height] of [
    ['icon128.png', 128, 128], ['small-promo.png', 440, 280],
    ['send-later.png', 1280, 800], ['recurring.png', 1280, 800], ['vault-unlock.png', 1280, 800],
  ]) {
    const image = fs.readFileSync(path.join(store, 'images', name));
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', name);
    assert.equal(image.readUInt32BE(16), width, name);
    assert.equal(image.readUInt32BE(20), height, name);
  }
});

test('frozen demo schedules are valid synthetic data with no unlock material', () => {
  const capture = JSON.parse(fs.readFileSync(path.join(store, 'demo-state.json'), 'utf8'));
  assert(Number.isSafeInteger(capture.capturedAt));
  assert.deepEqual(validateState(capture.state), capture.state);
  assert.equal(capture.state.jobs.length, 2);
  const [once, weekdays] = capture.state.jobs;
  assert.equal(once.schedule.at - capture.capturedAt, 5 * 3600000);
  assert.equal(once.url, 'https://chatgpt.com/c/demo-conversation');
  assert.equal(weekdays.url, 'https://claude.ai/chat/demo-morning');
  assert.equal(weekdays.schedule.expression, '0 7 * * 1-5');
  const next = new Date(weekdays.nextRunAt);
  assert(weekdays.nextRunAt > capture.capturedAt);
  assert([1, 2, 3, 4, 5].includes(next.getUTCDay()));
  assert.equal(next.getUTCHours(), 7);
  assert.equal(next.getUTCMinutes(), 0);
  assert.doesNotMatch(JSON.stringify(capture), /passphrase|vault-session|access.token/i);
});
