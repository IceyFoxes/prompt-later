import { expect, test } from '@playwright/test';
import { EDITOR_MESSAGE, insertTiptapText } from '../../src/page-editor.js';
import { closeExtension, dueState, openExtension, readState, tickFromPage } from './helpers.js';

const providers = [
  { id: 'gemini', label: 'Gemini', target: 'https://gemini.google.com/app/0123456789abcdef', other: 'https://gemini.google.com/app/22345678abcdef01', editor: '.ql-editor', user: 'user-query' },
  { id: 'grok', label: 'Grok', target: 'https://grok.com/c/12345678-1234-1234-1234-123456789abc', other: 'https://grok.com/c/22345678-1234-1234-1234-123456789abc', editor: '.tiptap.ProseMirror', user: '[data-testid="user-message"]' },
  { id: 'deepseek', label: 'DeepSeek', target: 'https://chat.deepseek.com/a/chat/s/12345678-1234-1234-1234-123456789abc', other: 'https://chat.deepseek.com/a/chat/s/22345678-1234-1234-1234-123456789abc', editor: '#chat-input', user: '.fbb737a4' },
  { id: 'kimi', label: 'Kimi', target: 'https://www.kimi.com/chat/12345678-1234-1234-1234-123456789abc', other: 'https://www.kimi.com/chat/22345678-1234-1234-1234-123456789abc', editor: '.chat-input-editor', user: '.segment-content' },
  { id: 'perplexity', label: 'Perplexity', target: 'https://www.perplexity.ai/search/test-question-12345678', other: 'https://www.perplexity.ai/search/other-question-22345678', editor: '#ask-input', user: '[class~="group/query"]' },
  { id: 'copilot', label: 'Microsoft Copilot', target: 'https://copilot.microsoft.com/chats/AbCdEfGh12345678', other: 'https://copilot.microsoft.com/chats/QwErTyUi22334455', editor: '#userInput', user: '[data-content="user"]' },
  { id: 'qwen', label: 'Qwen', target: 'https://chat.qwen.ai/c/12345678-1234-1234-1234-123456789abc', other: 'https://chat.qwen.ai/c/22345678-1234-1234-1234-123456789abc', editor: '.message-input-textarea', user: '.user-message-content' },
  { id: 'mistral', label: 'Mistral Le Chat', target: 'https://chat.mistral.ai/chat/12345678-1234-1234-1234-123456789abc', other: 'https://chat.mistral.ai/chat/22345678-1234-1234-1234-123456789abc', editor: '.ProseMirror', user: '[data-message-author-role="user"]' },
];
const byId = Object.fromEntries(providers.map(provider => [provider.id, provider]));
const literalMessage = 'Line one\n<b>literal text</b>';

async function withExtension(options, callback) {
  const environment = await openExtension(options);
  try {
    return await callback(environment);
  } finally {
    await closeExtension(environment);
  }
}

async function withTarget(provider, fixture, callback) {
  return withExtension({ fixture }, async environment => {
    const target = await environment.context.newPage();
    await target.goto(provider.target);
    return callback({ ...environment, target });
  });
}

async function save(page, target, message) {
  await page.locator('#url').fill(target);
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill(message);
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toContainText('Message scheduled.');
}

async function runDue(page) {
  await dueState(page, job => job.status === 'scheduled');
  await tickFromPage(page);
}

async function stored(page) {
  return readState(page);
}

async function editorText(target, selector) {
  return target.locator(selector).evaluate(element => element.value ?? element.textContent ?? '');
}

async function expectNoClicks(target) {
  expect(await target.evaluate(() => window.__sendClicks)).toBe(0);
  expect(await target.evaluate(() => window.__otherClicks)).toBe(0);
}

for (const provider of providers) {
  test(`experimental ${provider.id} sends only to its selected background fixture`, async () => {
    await withTarget(provider, {}, async ({ page, context, target }) => {
      const message = provider.id === 'grok' ? literalMessage : `Provider test: ${provider.id}`;
      const other = await context.newPage();
      await other.goto(provider.other);
      await save(page, provider.target, message);
      await expect(page.locator('#job-list')).toContainText(`${provider.label} (experimental)`);
      await other.bringToFront();
      await runDue(page);
      await expect(target.locator(provider.user)).toHaveText(message);
      await expect(target.locator(provider.user)).toHaveCount(1);
      await expect(other.locator(provider.user)).toHaveCount(0);
      const tabs = await page.evaluate(async () => chrome.tabs.query({}));
      expect(tabs.find(tab => tab.url === provider.other)?.active).toBe(true);
      expect(tabs.find(tab => tab.url === provider.target)?.active).toBe(false);
      const state = await stored(page);
      expect(state.jobs[0]).toMatchObject({ status: 'completed', enabled: false, runId: null });
      expect(state.history.at(-1).status).toBe('sent');
      expect(await target.evaluate(() => window.__sendClicks)).toBe(1);
      expect(await target.evaluate(() => window.__otherClicks)).toBe(0);
      await page.locator('[data-tab="activity"]').click();
      await expect(page.locator('#activity-list')).toContainText('Sent');
      await expect(page.locator('#activity-list')).toContainText(`${provider.label} (experimental)`);
      await page.locator('[data-tab="send"]').click();
      await tickFromPage(page);
      await expect(target.locator(provider.user)).toHaveCount(1);
      expect(await target.evaluate(() => window.__sendClicks)).toBe(1);
      if (provider.id === 'grok') {
        expect(await target.evaluate(() => window.__tiptapCalls)).toBe(1);
        expect(await target.evaluate(() => window.__tiptapPayload)).toEqual([
          { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '<b>literal text</b>' }] },
        ]);
        await expect(target.locator('#messages b')).toHaveCount(0);
        await expect(target.locator('[data-prompt-later-editor]')).toHaveCount(0);
        await save(page, provider.target, 'Second Grok run');
        await other.bringToFront();
        await runDue(page);
        await expect(target.locator(provider.user)).toHaveCount(2);
        await expect(target.locator(provider.user).last()).toHaveText('Second Grok run');
        expect(await target.evaluate(() => window.__tiptapCalls)).toBe(2);
        expect(await target.evaluate(() => window.__sendClicks)).toBe(2);
        expect((await stored(page)).history.at(-1).status).toBe('sent');
      }
    });
  });

  test(`experimental ${provider.id} preserves an existing draft`, async () => {
    await withTarget(provider, { draft: 'Do not overwrite' }, async ({ page, target }) => {
      await save(page, provider.target, `Provider test: ${provider.id}`);
      await runDue(page);
      await expect(page.locator('#job-list')).toContainText('Needs attention');
      expect(await editorText(target, provider.editor)).toBe('Do not overwrite');
      await expect(target.locator(provider.user)).toHaveCount(0);
      await expectNoClicks(target);
      expect((await stored(page)).history.at(-1).status).toBe('blocked');
    });
  });
}

const blockedCases = [
  { name: 'Kimi stop control', id: 'kimi', fixture: { busy: true }, remaining: '' },
  { name: 'Qwen stop rectangle', id: 'qwen', fixture: { busy: true }, remaining: '' },
  { name: 'DeepSeek stop rectangle', id: 'deepseek', fixture: { busy: true }, remaining: '' },
  { name: 'disabled Qwen nested button', id: 'qwen', fixture: { disabledSend: true }, remaining: 'Blocked provider test' },
  { name: 'duplicate Gemini send controls', id: 'gemini', fixture: { duplicateSend: true }, remaining: 'Blocked provider test' },
  { name: 'hidden Gemini editor', id: 'gemini', fixture: { editorState: 'hidden' }, remaining: '' },
  { name: 'modal Kimi editor', id: 'kimi', fixture: { editorState: 'modal' }, remaining: '' },
  { name: 'read-only Mistral editor', id: 'mistral', fixture: { editorState: 'readonly' }, remaining: '' },
  { name: 'unavailable Grok editor API', id: 'grok', fixture: { noEditorApi: true }, remaining: '' },
  { name: 'Grok draft introduced during focus', id: 'grok', fixture: { focusDraft: 'User started typing' }, remaining: 'User started typing' },
  { name: 'Grok navigation during focus', id: 'grok', fixture: { focusNavigate: '/c/22345678-1234-1234-1234-123456789abc' }, remaining: '' },
];
for (const item of blockedCases) {
  test(`${item.name} blocks without clicking`, async () => {
    const provider = byId[item.id];
    await withTarget(provider, item.fixture, async ({ page, target }) => {
      await save(page, provider.target, 'Blocked provider test');
      await runDue(page);
      await expect(page.locator('#job-list')).toContainText('Needs attention');
      expect(await editorText(target, provider.editor)).toBe(item.remaining);
      await expect(target.locator(provider.user)).toHaveCount(0);
      await expectNoClicks(target);
      expect((await stored(page)).history.at(-1).status).toBe('blocked');
      if (item.fixture.disabledSend) await expect(target.locator('.message-input-right-button-send button')).toBeDisabled();
      if (item.id === 'grok') {
        expect(await target.evaluate(() => window.__tiptapCalls)).toBe(0);
        await expect(target.locator('[data-prompt-later-editor]')).toHaveCount(0);
      }
    });
  });
}

test('Perplexity assistant echo is uncertain and never retried', async () => {
  test.setTimeout(45000);
  const provider = byId.perplexity;
  await withTarget(provider, { noAck: true, assistantEcho: true }, async ({ page, target }) => {
    const message = 'Provider test: perplexity';
    await save(page, provider.target, message);
    await runDue(page);
    await expect(target.locator('[data-role="assistant"]')).toHaveText(message);
    await expect(target.locator(provider.user)).toHaveCount(0);
    expect(await editorText(target, provider.editor)).toBe('');
    expect((await stored(page)).history.at(-1).status).toBe('uncertain');
    await expect(page.locator('#job-list')).toContainText('Needs attention');
    expect(await target.evaluate(() => window.__sendClicks)).toBe(1);
    await tickFromPage(page);
    expect(await target.evaluate(() => window.__sendClicks)).toBe(1);
    await expect(target.locator(provider.user)).toHaveCount(0);
  });
});

test('Grok MAIN-world helper rejects a changed target before touching the editor', async () => {
  const provider = byId.grok;
  await withTarget(provider, {}, async ({ target }) => {
    await target.locator(provider.editor).evaluate(element => element.setAttribute('data-prompt-later-editor', 'test-marker'));
    const result = await target.evaluate(insertTiptapText, { url: provider.other, message: 'Wrong target test', marker: 'test-marker' });
    expect(result).toBe(false);
    expect(await target.evaluate(() => window.__tiptapCalls)).toBe(0);
    expect(await editorText(target, provider.editor)).toBe('');
    await expectNoClicks(target);
  });
});

test('extension UI cannot invoke the page editor RPC and normal UI RPC still works', async () => {
  await withExtension({}, async ({ page }) => {
    const result = await page.evaluate(async payload => chrome.runtime.sendMessage(payload), {
      type: EDITOR_MESSAGE, runId: 'fake-run', url: byId.grok.target, message: 'Unauthorized fixture', marker: 'test-marker',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not authorized');
    const state = await page.evaluate(async () => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'GET_STATE' }));
    expect(state.ok).toBe(true);
    expect(state.data.jobs).toHaveLength(0);
    expect(state.data.history).toHaveLength(0);
  });
});

for (const provider of [
  { ...byId.kimi, target: 'https://kimi.com/chat/12345678-1234-1234-1234-123456789abc' },
  { ...byId.perplexity, target: 'https://perplexity.ai/search/test-question-12345678' },
]) {
  test(`${new URL(provider.target).hostname} retains its origin and delivers`, async () => {
    await withTarget(provider, {}, async ({ page, target }) => {
      await save(page, provider.target, 'Additional host test');
      await runDue(page);
      await expect(target.locator(provider.user)).toHaveText('Additional host test');
      expect(new URL((await stored(page)).jobs[0].url).origin).toBe(new URL(provider.target).origin);
      expect((await stored(page)).history.at(-1).status).toBe('sent');
      expect(await target.evaluate(() => window.__sendClicks)).toBe(1);
    });
  });
}

test('Copilot never borrows an unrelated submit button through document body', async () => {
  const provider = byId.copilot;
  await withTarget(provider, {}, async ({ page, target }) => {
    await target.evaluate(() => {
      const editor = document.querySelector('#userInput');
      const send = document.querySelector('button[aria-label="Submit"]');
      const editorContainer = document.createElement('div');
      const unrelated = document.createElement('div');
      editorContainer.append(editor);
      unrelated.append(send);
      document.body.append(editorContainer, unrelated, document.querySelector('#messages'));
      document.querySelector('main').remove();
    });
    await save(page, provider.target, 'Unrelated submit test');
    await runDue(page);
    await expect(page.locator('#job-list')).toContainText('Needs attention');
    await expectNoClicks(target);
    await expect(target.locator(provider.user)).toHaveCount(0);
    expect((await stored(page)).history.at(-1).status).toBe('blocked');
  });
});

test('legacy ChatGPT contenteditable still sends literal multiline text', async () => {
  const url = 'https://chatgpt.com/c/rich-editor';
  await withExtension({}, async ({ page, context }) => {
    const target = await context.newPage();
    await target.goto(url);
    await target.evaluate(() => {
      const original = document.querySelector('#prompt-textarea');
      const editor = document.createElement('div');
      editor.id = 'prompt-textarea';
      editor.contentEditable = 'true';
      editor.style.cssText = 'display:block;min-height:60px;width:500px;border:1px solid black';
      original.replaceWith(editor);
      const oldSend = document.querySelector('button[aria-label="Send"]');
      const send = oldSend.cloneNode(true);
      oldSend.replaceWith(send);
      send.disabled = true;
      window.__sendClicks = 0;
      editor.addEventListener('input', () => { send.disabled = !editor.innerText.trim(); });
      send.addEventListener('click', event => {
        event.preventDefault();
        window.__sendClicks += 1;
        const user = document.createElement('div');
        user.dataset.messageAuthorRole = 'user';
        user.textContent = editor.innerText;
        document.querySelector('#messages').append(user);
        editor.innerText = '';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
    await save(page, url, literalMessage);
    await runDue(page);
    await expect(target.locator('[data-message-author-role="user"]')).toHaveText(literalMessage);
    await expect(target.locator('#messages b')).toHaveCount(0);
    expect(await target.evaluate(() => window.__sendClicks)).toBe(1);
    expect((await stored(page)).history.at(-1).status).toBe('sent');
    await expect(page.locator('#job-list')).toContainText('completed');
  });
});
