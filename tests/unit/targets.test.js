import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, sameTarget } from '../../src/targets.js';

const valid = [
  ['https://chatgpt.com/c/chat-id', 'chatgpt'],
  ['https://chatgpt.com/g/g-example/c/chat-id/?x=1#part', 'chatgpt'],
  ['https://chat.openai.com/c/legacy', 'chatgpt'],
  ['https://claude.ai/chat/conversation-1?x=1#y', 'claude'],
  ['https://app.devin.ai/sessions/devin-id/', 'devin'],
];
for (const [url, provider] of valid) {
  test(`accepts ${provider} ${url}`, () => assert.equal(parseTarget(url).provider, provider));
}

test('canonicalizes target URLs', () => {
  assert.equal(parseTarget('https://chatgpt.com/g/g-example/c/chat-id/?x=1#part').url, 'https://chatgpt.com/g/g-example/c/chat-id');
  assert.equal(sameTarget('https://chat.openai.com/c/abc/?q=1', 'https://chatgpt.com/c/abc'), true);
  assert.equal(sameTarget('https://chatgpt.com/c/abc', 'https://chatgpt.com/c/other'), false);
});
for (const value of ['http://chatgpt.com/c/id', 'javascript:alert(1)', 'https://user:pass@chatgpt.com/c/id', 'https://chatgpt.com.evil.test/c/id', 'https://chatgpt.com/', 'https://chatgpt.com/share/id', 'https://chatgpt.com/login', 'https://example.test/c/id']) {
  test(`rejects ${value}`, () => assert.throws(() => parseTarget(value)));
}
