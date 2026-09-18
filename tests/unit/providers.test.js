import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, optionalHostPermissions, providerForHost, providerLabel } from '../../src/providers.js';
import { parseTarget } from '../../src/targets.js';

const legacySelectors = {
  chatgpt: {
    editors: ['#prompt-textarea', '[data-testid="composer-text-input"]'],
    sends: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label="Send"]'],
    users: ['[data-message-author-role="user"]'],
  },
  claude: {
    editors: ['[data-testid="chat-input"][contenteditable="true"]', '[data-testid="composer"] [contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
    sends: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[data-testid="send-button"]'],
    users: ['[data-testid="user-message"]', '[data-testid="user-message-content"]'],
  },
  devin: {
    editors: ['textarea[placeholder*="Devin" i]', '[role="textbox"][contenteditable="true"]', 'main textarea'],
    sends: ['button[data-testid="send-message-button"]', 'button[aria-label="Send message"]', 'button[aria-label="Send"]'],
    users: ['[data-message-role="user"]', '[data-role="user"]', '[data-testid="user-message"]'],
  },
};

test('optional permissions have exact registry parity', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.optional_host_permissions, optionalHostPermissions());
  assert.deepEqual(optionalHostPermissions(), [
    'https://chatgpt.com/*', 'https://claude.ai/*', 'https://app.devin.ai/*',
    'https://gemini.google.com/*', 'https://chat.deepseek.com/*',
    'https://www.kimi.com/*', 'https://kimi.com/*', 'https://www.perplexity.ai/*',
    'https://perplexity.ai/*', 'https://copilot.microsoft.com/*', 'https://chat.qwen.ai/*',
    'https://chat.mistral.ai/*',
  ]);
});

test('host lookup is exact and labels mark only experimental providers', () => {
  assert.equal(providerForHost('kimi.com'), 'kimi');
  assert.equal(providerForHost('kimi.com.evil.test'), null);
  assert.equal(providerLabel('chatgpt'), 'ChatGPT');
  assert.equal(providerLabel('claude'), 'Claude');
  assert.equal(providerLabel('devin'), 'Devin (experimental)');
  assert.equal(providerLabel('unknown'), 'Unknown provider');
  assert.equal(providerLabel('constructor'), 'Unknown provider');
  for (const id of ['gemini', 'deepseek', 'kimi', 'perplexity', 'copilot', 'qwen', 'mistral']) {
    assert.equal(PROVIDERS[id].experimental, true);
    assert.match(providerLabel(id), /experimental/);
  }
});

test('legacy selectors and path regexes stay exact', () => {
  for (const [id, selectors] of Object.entries(legacySelectors)) {
    assert.deepEqual(PROVIDERS[id].selectors, selectors);
    assert.equal(PROVIDERS[id].enhanced, undefined);
    assert.equal(PROVIDERS[id].insertion, undefined);
  }
  assert.equal(PROVIDERS.chatgpt.pathPattern.source, '^(?:\\/g\\/[A-Za-z0-9_-]+)?\\/c\\/[A-Za-z0-9_-]+$');
  assert.equal(PROVIDERS.claude.pathPattern.source, '^\\/chat\\/[A-Za-z0-9_-]+$');
  assert.equal(PROVIDERS.devin.pathPattern.source, '^\\/sessions\\/[A-Za-z0-9_-]+$');
  assert.equal(parseTarget('https://chat.openai.com/c/legacy').url, 'https://chatgpt.com/c/legacy');
});
