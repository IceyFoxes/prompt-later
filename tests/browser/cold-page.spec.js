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

test('cold missing composer has a bounded wait and is never retried', async () => {
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
    await expect(page.locator('#form-status')).toContainText('Composer is ready.');
    await expect(page.locator('#form-status')).toContainText('does not send');
    await expect(target.locator('#prompt-textarea')).toHaveValue('');
    await expect(target.locator('[data-message-author-role="user"]')).toHaveCount(0);
    expect((await readState(page)).jobs).toHaveLength(0);
  });
});
