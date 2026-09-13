import test from 'node:test';
import assert from 'node:assert/strict';
import { isUiSender } from '../../src/protocol.js';

test('UI sender must be own app page', () => {
  assert.equal(isUiSender({ id: 'ext', url: 'chrome-extension://ext/app.html' }, 'ext'), true);
  assert.equal(isUiSender({ id: 'ext', url: 'chrome-extension://ext/app.html?popup=1' }, 'ext'), true);
  assert.equal(isUiSender({ id: 'ext', url: 'chrome-extension://ext/nested/app.html' }, 'ext'), false);
  assert.equal(isUiSender({ id: 'ext', url: 'https://chatgpt.com/app.html' }, 'ext'), false);
  assert.equal(isUiSender({ id: 'other', url: 'chrome-extension://other/app.html' }, 'ext'), false);
  assert.equal(isUiSender({}, 'ext'), false);
});
