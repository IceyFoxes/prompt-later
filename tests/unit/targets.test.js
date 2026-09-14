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

const newProviders = [
  ['https://gemini.google.com/app/0123456789abcdef', 'gemini'],
  ['https://gemini.google.com/u/1/app/0123456789abcdef?authuser=1&hl=en', 'gemini'],
  ['https://grok.com/c/12345678-1234-1234-1234-123456789abc', 'grok'],
  ['https://chat.deepseek.com/a/chat/s/12345678-1234-1234-1234-123456789abc', 'deepseek'],
  ['https://www.kimi.com/chat/12345678-1234-1234-1234-123456789abc?chat_enter_method=home', 'kimi'],
  ['https://kimi.com/chat/12345678-1234-1234-1234-123456789abc', 'kimi'],
  ['https://www.perplexity.ai/search/test-question-12345678', 'perplexity'],
  ['https://perplexity.ai/search/test-question-12345678', 'perplexity'],
  ['https://copilot.microsoft.com/chats/AbCdEfGh12345678', 'copilot'],
  ['https://chat.qwen.ai/c/12345678-1234-1234-1234-123456789abc', 'qwen'],
  ['https://chat.mistral.ai/chat/12345678-1234-1234-1234-123456789abc', 'mistral'],
];
for (const [url, provider] of newProviders) {
  test(`accepts experimental ${provider} ${url}`, () => {
    const target = parseTarget(url);
    assert.equal(target.provider, provider);
    assert.equal(target.experimental, true);
  });
}

for (const value of [
  'https://gemini.google.com/app',
  'https://gemini.google.com/share/id',
  'https://grok.com/share/id',
  'https://grok.com/imagine/id',
  'https://chat.deepseek.com/sign_in',
  'https://www.kimi.com/share/id',
  'https://www.kimi.com/chat/history',
  'https://www.perplexity.ai/',
  'https://www.perplexity.ai/search',
  'https://copilot.microsoft.com/chats/id/talk',
  'https://chat.qwen.ai/c/new-chat',
  'https://chat.mistral.ai/chat',
  'https://chat.mistral.ai/chat/settings',
  'https://gemini.google.com.evil.test/app/0123456789abcdef',
  'https://grok.com.evil.test/c/12345678-1234-1234-1234-123456789abc',
  'https://chat.deepseek.com.evil.test/a/chat/s/12345678-1234-1234-1234-123456789abc',
  'https://www.kimi.com.evil.test/chat/12345678-1234-1234-1234-123456789abc',
  'https://www.perplexity.ai.evil.test/search/test-question-12345678',
  'https://copilot.microsoft.com.evil.test/chats/AbCdEfGh12345678',
  'https://chat.qwen.ai.evil.test/c/12345678-1234-1234-1234-123456789abc',
  'https://chat.mistral.ai.evil.test/chat/12345678-1234-1234-1234-123456789abc',
  'https://gemini.google.com/app/0123456789abcdef?authuser=1&authuser=2',
  'https://gemini.google.com/app/0123456789abcdef?authuser=',
]) {
  test(`rejects broadened provider URL ${value}`, () => assert.throws(() => parseTarget(value)));
}

test('experimental identity queries and navigation are canonicalized precisely', () => {
  assert.equal(parseTarget('https://gemini.google.com/app/0123456789abcdef?authuser=1&hl=en').url, 'https://gemini.google.com/app/0123456789abcdef?authuser=1');
  assert.equal(parseTarget('https://kimi.com/chat/12345678-1234-1234-1234-123456789abc').url, 'https://kimi.com/chat/12345678-1234-1234-1234-123456789abc?chat_enter_method=history');
  assert.notEqual(parseTarget('https://gemini.google.com/app/0123456789abcdef').url, parseTarget('https://gemini.google.com/u/1/app/0123456789abcdef').url);
  assert.equal(sameTarget('https://www.kimi.com/chat/12345678-1234-1234-1234-123456789abc?chat_enter_method=home', 'https://www.kimi.com/chat/12345678-1234-1234-1234-123456789abc'), true);
  assert.equal(sameTarget('https://gemini.google.com/app/0123456789abcdef?authuser=1', 'https://gemini.google.com/app/0123456789abcdef?authuser=2'), false);
  assert.equal(sameTarget('https://gemini.google.com/u/1/app/0123456789abcdef', 'https://gemini.google.com/u/2/app/0123456789abcdef'), false);
  assert.equal(sameTarget('https://gemini.google.com/app/0123456789abcdef', 'https://gemini.google.com/app/22345678abcdef01'), false);
  assert.equal(sameTarget('https://grok.com/c/12345678-1234-1234-1234-123456789abc', 'https://grok.com/c/22345678-1234-1234-1234-123456789abc'), false);
});

const providerLabels = { gemini: 'Gemini', grok: 'Grok', deepseek: 'DeepSeek', kimi: 'Kimi', perplexity: 'Perplexity', copilot: 'Microsoft Copilot', qwen: 'Qwen', mistral: 'Mistral Le Chat' };
for (const [value, provider] of newProviders) {
  test(`preserves ${provider} origin and rejects unsafe URL variants`, () => {
    const original = new URL(value);
    const target = parseTarget(value);
    assert.equal(target.origin, original.origin);
    assert.equal(target.label, providerLabels[provider]);
    assert.throws(() => parseTarget(original.origin));
    for (const transform of [
      url => { url.protocol = 'http:'; },
      url => { url.username = 'fixture-user'; url.password = 'fixture-password'; },
      url => { url.port = '8443'; },
      url => { url.pathname += '/extra'; },
    ]) {
      const unsafe = new URL(value);
      transform(unsafe);
      assert.throws(() => parseTarget(unsafe.href));
    }
  });
}
