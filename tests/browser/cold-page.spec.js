import { expect, test } from '@playwright/test';
import { closeExtension, dueState, openExtension, readState, tickFromPage } from './helpers.js';

const url = 'https://chatgpt.com/c/cold-target';
const message = 'Cold startup fixture';

async function withExtension(options, callback) {
  const environment = await openExtension({ fixture: options });
  try {
    await callback(environment);
  } finally {
    await closeExtension(environment);
  }
}

async function saveDueJob(page) {
  await page.locator('#url').fill(url);
  await page.locator('#message').fill(message);
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toContainText('Message scheduled.');
  await dueState(page);
}

async function waitForLoadingTab(page) {
  await expect.poll(() => page.evaluate(async url => {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    return tabs.find(tab => tab.url === url)?.status;
  }, url)).toBe('loading');
}

async function beginReload(page, target) {
  const navigation = target.waitForEvent('load');
  void target.evaluate(() => location.reload()).catch(() => {});
  await waitForLoadingTab(page);
  return { navigation };
}

async function inject(page) {
  return page.evaluate(async url => {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    const tab = tabs.find(candidate => candidate.url === url);
    if (!tab) throw new Error('Fixture tab was not found.');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ['content.js'],
      world: 'ISOLATED',
    });
    return tab.id;
  }, url);
}

function prepare(page, tabId, runId = 'cold-run') {
  return page.evaluate(({ tabId, url, message, runId }) => chrome.tabs.sendMessage(tabId, {
    type: 'PL_PREPARE',
    waitForComposer: true,
    runId,
    url,
    message,
  }), { tabId, url, message, runId });
}

function commit(page, tabId, runId = 'cold-run') {
  return page.evaluate(({ tabId, url, message, runId }) => chrome.tabs.sendMessage(tabId, {
    type: 'PL_COMMIT',
    runId,
    url,
    message,
  }), { tabId, url, message, runId });
}

test('loading ChatGPT waits for its delayed composer without activating the target', async () => {
  await withExtension({ composerDelayMs: 1200, responseDelayMs: 2500, responseDelayPath: '/c/cold-target' }, async ({ page, context }) => {
    await saveDueJob(page);
    const other = await context.newPage();
    await other.goto('data:text/html,<p>Other tab</p>');
    const target = await context.newPage();
    await target.goto(url);
    const { navigation } = await beginReload(page, target);
    await other.bringToFront();
    const delivery = tickFromPage(page);
    await navigation;
    const stored = await delivery;
    expect(stored.history.at(-1)).toMatchObject({ status: 'sent' });
    await expect(target.locator('[data-message-author-role="user"]')).toHaveText(message);
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(1);
    expect(await page.evaluate(async url => {
      const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      return tabs.find(tab => tab.url === url)?.active;
    }, url)).toBe(false);
    await tickFromPage(page);
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(1);
  });
});

test('cold composer remount settles before the message is reserved', async () => {
  await withExtension({ composerDelayMs: 500, composerRemountMs: 200 }, async ({ page, context }) => {
    const target = await context.newPage();
    await target.goto(url);
    const tabId = await inject(page);
    expect(await prepare(page, tabId)).toMatchObject({ ready: true });
    expect(await target.evaluate(() => window.__fixtureMounts)).toBe(2);
    expect(await commit(page, tabId)).toMatchObject({ outcome: 'sent' });
    await expect(target.locator('[data-message-author-role="user"]')).toHaveText(message);
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(1);
  });
});

test('cold delayed draft is untouched and never dispatched', async () => {
  await withExtension({ composerDelayMs: 1200, draft: 'Existing cold draft' }, async ({ page, context }) => {
    const target = await context.newPage();
    await target.goto(url);
    const tabId = await inject(page);
    const result = await prepare(page, tabId);
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.detail).toContain('draft');
    await expect(target.locator('#prompt-textarea')).toHaveValue('Existing cold draft');
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(0);
  });
});

test('cold navigation while waiting blocks without inserting or sending', async () => {
  await withExtension({ composerDelayMs: 1200 }, async ({ page, context }) => {
    const target = await context.newPage();
    await target.goto(url);
    const tabId = await inject(page);
    const preparation = prepare(page, tabId);
    await target.waitForTimeout(150);
    await target.evaluate(() => history.pushState({}, '', '/c/changed-before-ready'));
    const result = await preparation;
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.detail).toContain('selected conversation');
    await expect(target.locator('#prompt-textarea')).toBeVisible();
    await expect(target.locator('#prompt-textarea')).toHaveValue('');
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(0);
  });
});

test('cold missing composer has a bounded wait and asks for attention', async () => {
  test.setTimeout(45000);
  await withExtension({ missingEditor: true, responseDelayMs: 500, responseDelayPath: '/c/cold-target' }, async ({ page, context }) => {
    await saveDueJob(page);
    const target = await context.newPage();
    await target.goto(url);
    const { navigation } = await beginReload(page, target);
    const delivery = tickFromPage(page);
    await navigation;
    const stored = await delivery;
    expect(stored.history.at(-1).status).toBe('blocked');
    expect(stored.history.at(-1).detail).toContain('did not become ready');
    expect(stored.jobs[0]).toMatchObject({ status: 'needs-attention', enabled: false });
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(0);
    await tickFromPage(page);
    expect((await readState(page)).history).toHaveLength(1);
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(0);
  });
});

test('cold Check page waits for the composer but never types or sends', async () => {
  await withExtension({ composerDelayMs: 1200, responseDelayMs: 2000, responseDelayPath: '/c/cold-target' }, async ({ page, context }) => {
    await page.locator('#url').fill(url);
    const target = await context.newPage();
    await target.goto(url);
    const { navigation } = await beginReload(page, target);
    await page.locator('#check').click();
    await navigation;
    await expect(page.locator('#check')).toHaveText('✓ Page ready');
    await expect(page.locator('#check')).toHaveClass(/check-success/);
    await expect(target.locator('#prompt-textarea')).toHaveValue('');
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(0);
    expect((await readState(page)).jobs).toHaveLength(0);
  });
});



function injectInto(page, target) {
  return page.evaluate(async target => {
    const tabs = await chrome.tabs.query({ url: `${new URL(target).origin}/*` });
    const tab = tabs.find(candidate => candidate.url === target);
    if (!tab) throw new Error('Fixture tab was not found.');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ['content.js'],
      world: 'ISOLATED',
    });
    return tab.id;
  }, target);
}

function call(page, tabId, type, target, text, extra = {}) {
  return page.evaluate(({ tabId, type, target, text, extra }) => chrome.tabs.sendMessage(tabId, {
    type,
    runId: 'late-hydration-run',
    url: target,
    message: text,
    ...extra,
  }), { tabId, type, target, text, extra });
}

// Regression for a reopened tab: the composer paints and accepts text before its
// framework attaches, so the framework's state stays empty and the send control
// it renders from that state never appears. Waiting alone cannot fix this - the
// insertion has to be replayed once the framework is listening.
for (const provider of [
  { name: 'ChatGPT', target: 'https://chatgpt.com/c/late-hydration', user: '[data-message-author-role="user"]', draft: () => document.querySelector('#prompt-textarea').value },
  { name: 'Claude', target: 'https://claude.ai/chat/late-hydration', user: '[data-testid="user-message"]', draft: () => document.querySelector('[data-testid="chat-input"]').innerText },
]) {
  test(`${provider.name} sends when its composer framework attaches after insertion`, async () => {
    await withExtension({ hydrateOnDemand: true }, async ({ page, context }) => {
      const text = `Late hydration ${provider.name}`;
      const target = await context.newPage();
      await target.goto(provider.target);
      const tabId = await injectInto(page, provider.target);
      expect(await call(page, tabId, 'PL_PREPARE', provider.target, text, { waitForComposer: true })).toMatchObject({ ready: true });
      const committing = call(page, tabId, 'PL_COMMIT', provider.target, text);
      await expect.poll(() => target.evaluate(provider.draft)).toContain(text);
      // The text is in the DOM, the framework is still absent, no send control.
      expect(await target.evaluate(() => window.__fixtureHydrated)).toBeUndefined();
      await expect(target.locator('#composer-actions button')).toHaveCount(0);
      await target.evaluate(() => window.__hydrate());
      expect(await target.evaluate(() => window.__fixtureHydrated)).toBe(true);
      expect(await committing).toMatchObject({ outcome: 'sent' });
      await expect(target.locator(provider.user)).toHaveText(text);
      await expect(target.locator(provider.user)).toHaveCount(1);
    });
  });

  test(`${provider.name} finds a send control that sits outside the composer subtree`, async () => {
    await withExtension({ detachedComposer: true }, async ({ page, context }) => {
      const text = `Detached composer ${provider.name}`;
      const target = await context.newPage();
      await target.goto(provider.target);
      expect(await target.evaluate(() => !document.querySelector('#composer-input').closest('form, main'))).toBe(true);
      const tabId = await injectInto(page, provider.target);
      expect(await call(page, tabId, 'PL_PREPARE', provider.target, text, { waitForComposer: true })).toMatchObject({ ready: true });
      expect(await call(page, tabId, 'PL_COMMIT', provider.target, text)).toMatchObject({ outcome: 'sent' });
      await expect(target.locator(provider.user)).toHaveText(text);
      await expect(target.locator(provider.user)).toHaveCount(1);
    });
  });
}

test('a composer framework that never attaches fails closed and keeps the message', async () => {
  await withExtension({ hydrateOnDemand: true }, async ({ page, context }) => {
    const text = 'Never hydrated prompt';
    const target = await context.newPage();
    await target.goto(url);
    const tabId = await injectInto(page, url);
    expect(await call(page, tabId, 'PL_PREPARE', url, text, { waitForComposer: true })).toMatchObject({ ready: true });
    const result = await call(page, tabId, 'PL_COMMIT', url, text);
    expect(result).toMatchObject({ outcome: 'blocked' });
    expect(result.detail).toContain('explicit send control was not found');
    // Fail closed: nothing sent, and the replayed insertion left the text intact.
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(0);
    await expect(target.locator('#prompt-textarea')).toHaveValue(text);
  });
});
