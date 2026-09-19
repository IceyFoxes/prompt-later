import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeExtension, dueState, openExtension, readState, root, tickFromPage, writeState } from './helpers.js';


function extensionFixture() {
  return async ({}, use) => {
    const environment = await openExtension();
    try {
      await use(environment);
    } finally {
      await closeExtension(environment);
    }
  };
}

const testWithExtension = test.extend({ environment: extensionFixture() });

async function withFixture(fixture, callback) {
  const environment = await openExtension({ fixture });
  try {
    await callback(environment);
  } finally {
    await closeExtension(environment);
  }
}

test('production manifest keeps declared providers optional', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  expect(manifest.optional_host_permissions).toEqual([
    'https://chatgpt.com/*', 'https://claude.ai/*', 'https://app.devin.ai/*',
    'https://gemini.google.com/*', 'https://chat.deepseek.com/*',
    'https://www.kimi.com/*', 'https://kimi.com/*', 'https://www.perplexity.ai/*',
    'https://perplexity.ai/*', 'https://copilot.microsoft.com/*', 'https://chat.qwen.ai/*',
    'https://chat.mistral.ai/*',
  ]);
  expect(manifest.host_permissions).toBeUndefined();
});

testWithExtension('saves, previews, and delivers to the chosen conversation', async ({ environment }) => {
  const { page, context, id } = environment;
  await expect(page.locator('.brand-mark img')).toHaveJSProperty('naturalWidth', 32);
  await expect(page.locator('.brand-mark img')).toHaveJSProperty('naturalHeight', 32);
  await expect(page.locator('.clock')).toHaveCount(0);
  await expect(page.locator('#target-help')).toHaveText('ChatGPT and Claude are supported; additional providers are experimental.');
  expect(await page.locator('#when option').allTextContents()).toContain('In 1 minute (test)');
  await page.locator('#url').fill('https://chatgpt.com/c/fixture');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Synthetic browser prompt');
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toContainText('Message scheduled.');
  await page.screenshot({ path: path.join(root, 'artifacts/screenshots/dashboard.png'), fullPage: true });
  await page.locator('[data-tab="recurring"]').click();
  await expect(page.locator('#recurring-fields')).toBeVisible();
  await expect(page.locator('#recurrence')).toHaveValue('daily');
  await expect(page.locator('#interval-field')).toBeHidden();
  await expect(page.locator('#recurring-time-field')).toBeVisible();
  expect(await page.locator('#recurrence option').allTextContents()).toEqual(['Daily', 'Weekdays', 'Every N hours', 'Advanced cron']);
  await page.locator('#recurrence').selectOption('daily');
  await expect(page.locator('#next-preview')).toContainText('Next occurrence');
  await page.locator('#recurrence').selectOption('cron');
  await page.locator('#cron').fill('0 7 * * 1-5');
  await expect(page.locator('#next-preview')).toContainText('Next occurrence');
  await page.screenshot({ path: path.join(root, 'artifacts/screenshots/recurring.png'), fullPage: true });
  await page.locator('[data-tab="send"]').click();
  const provider = await context.newPage();
  await provider.goto('https://chatgpt.com/c/fixture');
  await dueState(page);
  await tickFromPage(page);
  await expect(provider.locator('[data-message-author-role="user"]')).toHaveText('Synthetic browser prompt');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/app.html?popup=1`);
  await popup.setViewportSize({ width: 420, height: 600 });
  await expect(popup.locator('#save')).toBeVisible();
  await expect.poll(() => popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await popup.screenshot({ path: path.join(root, 'artifacts/screenshots/popup-size.png'), fullPage: false });
  await provider.close();
  await popup.close();
  await expect(page.locator('#job-list')).toContainText('Submitted');
  await page.locator('[data-tab="activity"]').click();
  await page.screenshot({ path: path.join(root, 'artifacts/screenshots/activity.png'), fullPage: true });
});

testWithExtension('fixture adapters succeed for Claude and experimental Devin', async ({ environment }) => {
  const { page, context } = environment;
  const cases = [
    { target: 'https://claude.ai/chat/fixture', selector: '[data-testid="user-message"]' },
    { target: 'https://app.devin.ai/sessions/fixture', selector: '[data-message-role="user"]' },
  ];
  for (const item of cases) {
    await page.locator('#url').fill(item.target);
    await page.locator('#when').selectOption('1m');
    await page.locator('#message').fill(`Synthetic ${item.target}`);
    await page.locator('#save').click();
    await expect(page.locator('#form-status')).toContainText('Message scheduled.');
    const provider = await context.newPage();
    await provider.goto(item.target);
    await dueState(page, job => job.url === item.target);
    await tickFromPage(page);
    await expect(provider.locator(item.selector)).toHaveText(`Synthetic ${item.target}`);
    await provider.close();
  }
});

testWithExtension('does not click when the selected composer already has a draft', async ({ environment }) => {
  const { page, context } = environment;
  await page.locator('#url').fill('https://chatgpt.com/c/draft');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Must not overwrite draft');
  await page.locator('#save').click();
  const provider = await context.newPage();
  await provider.goto('https://chatgpt.com/c/draft');
  await provider.locator('#prompt-textarea').fill('Existing draft');
  await dueState(page);
  await tickFromPage(page);
  await expect(page.locator('#job-list')).toContainText('Needs attention');
  await expect(provider.locator('#prompt-textarea')).toHaveValue('Existing draft');
  await provider.close();
});

testWithExtension('send-draft sends the existing draft instead of the scheduled message', async ({ environment }) => {
  const { page, context } = environment;
  await page.locator('[data-tab="info"]').click();
  await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
  await page.locator('#draft-policy').selectOption('send-draft');
  await expect(page.locator('#delivery-status')).toContainText('Saved.');
  await page.locator('[data-tab="send"]').click();
  await page.locator('#url').fill('https://chatgpt.com/c/send-draft');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Scheduled message');
  await page.locator('#save').click();
  const provider = await context.newPage();
  await provider.goto('https://chatgpt.com/c/send-draft');
  await provider.locator('#prompt-textarea').fill('Existing draft');
  await dueState(page);
  await tickFromPage(page);
  await expect(provider.locator('[data-message-author-role="user"]')).toHaveText('Existing draft');
  await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(1);
  await expect(page.locator('#job-list')).toContainText('Submitted');
  await page.locator('[data-tab="activity"]').click();
  await expect(page.locator('#activity-list')).toContainText('The existing draft was sent; the scheduled message was skipped for this occurrence.');
  await provider.close();
});

test('send-both sends the draft then the scheduled message after busy clears', async () => {
  await withFixture({ busyAfterFirstClickMs: 700 }, async ({ page, context }) => {
    await page.locator('[data-tab="info"]').click();
    await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
    await page.locator('#draft-policy').selectOption('send-both');
    await expect(page.locator('#delivery-status')).toContainText('Saved.');
    await page.locator('[data-tab="send"]').click();
    await page.locator('#url').fill('https://chatgpt.com/c/send-both');
    await page.locator('#when').selectOption('1m');
    await page.locator('#message').fill('Scheduled after draft');
    await page.locator('#save').click();
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/send-both');
    await provider.locator('#prompt-textarea').fill('Existing draft');
    await provider.evaluate(() => { window.__sendClicks = 0; });
    await dueState(page);
    await tickFromPage(page);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(2);
    await expect(provider.locator('[data-message-author-role="user"]').nth(0)).toHaveText('Existing draft');
    await expect(provider.locator('[data-message-author-role="user"]').nth(1)).toHaveText('Scheduled after draft');
    await expect(page.locator('#job-list')).toContainText('Submitted');
    await page.locator('[data-tab="activity"]').click();
    await expect(page.locator('#activity-list')).toContainText('The existing draft and scheduled message were acknowledged.');
    await page.evaluate(() => chrome.alarms.create('prompt-later:due', { when: Date.now() }));
    await provider.waitForTimeout(500);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(2);
    await provider.close();
  });
});

test('send-both preserves a new draft after the existing draft is acknowledged', async () => {
  await withFixture({}, async ({ page, context }) => {
    await page.locator('[data-tab="info"]').click();
    await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
    await page.locator('#draft-policy').selectOption('send-both');
    await expect(page.locator('#delivery-status')).toContainText('Saved.');
    await page.locator('[data-tab="recurring"]').click();
    await page.locator('#recurrence').selectOption('daily');
    await page.locator('#url').fill('https://chatgpt.com/c/send-both-partial');
    await page.locator('#message').fill('Scheduled message');
    await page.locator('#save').click();
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/send-both-partial');
    await provider.locator('#prompt-textarea').fill('First draft');
    await provider.locator('button[aria-label="Send"]').evaluate(button => {
      button.addEventListener('click', () => {
        if (button.dataset.partialScheduled) return;
        button.dataset.partialScheduled = 'true';
        setTimeout(() => {
          const composer = document.querySelector('#prompt-textarea');
          composer.value = 'New user draft';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        }, 150);
      });
    });
    await dueState(page, job => job.url === 'https://chatgpt.com/c/send-both-partial');
    await tickFromPage(page);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(1);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveText('First draft');
    await expect(provider.locator('#prompt-textarea')).toHaveValue('New user draft');
    const state = await readState(page);
    const job = state.jobs.find(item => item.url === 'https://chatgpt.com/c/send-both-partial');
    expect(state.history.at(-1).status).toBe('uncertain');
    expect(state.history.at(-1).detail).toContain('The existing draft was sent, but the scheduled message was not confirmed.');
    expect(job.enabled).toBe(true);
    expect(job.status).toBe('scheduled');
    expect(job.nextRunAt).toBeGreaterThan(Date.now());
    await page.evaluate(() => chrome.alarms.create('prompt-later:due', { when: Date.now() }));
    await provider.waitForTimeout(500);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(1);
    await provider.close();
  });
});

test('send-scheduled insertion failure blocks without clicking or a reference error', async () => {
  await withFixture({}, async ({ page, context }) => {
    await page.locator('[data-tab="info"]').click();
    await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
    await page.locator('#draft-policy').selectOption('send-scheduled');
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.locator('#confirmation-accept').click();
    await expect(page.locator('#delivery-status')).toContainText('Saved.');
    await page.locator('[data-tab="send"]').click();
    await page.locator('#url').fill('https://chatgpt.com/c/send-scheduled-failure');
    await page.locator('#when').selectOption('1m');
    await page.locator('#message').fill('Scheduled replacement');
    await page.locator('#save').click();
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/send-scheduled-failure');
    await provider.locator('#prompt-textarea').fill('First draft');
    await provider.locator('#prompt-textarea').evaluate(composer => {
      composer.addEventListener('input', () => { composer.value = 'Corrupted replacement'; }, true);
    });
    await dueState(page);
    await tickFromPage(page);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(0);
    await expect(page.locator('#job-list')).toContainText('Needs attention');
    await page.locator('[data-tab="activity"]').click();
    await expect(page.locator('#activity-list')).toContainText('Message insertion was not acknowledged');
    await expect(page.locator('#activity-list')).not.toContainText('REAS');
    await provider.close();
  });
});

test('send-scheduled confirmation cancel restores skip, then contenteditable replacement sends only the scheduled message', async () => {
  await withFixture({}, async ({ page, context }) => {
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage;
      window.__settingsRpcCalls = [];
      window.__restoreSettingsRpc = () => { chrome.runtime.sendMessage = original; };
      chrome.runtime.sendMessage = async message => {
        if (message.action === 'UPDATE_SETTINGS') window.__settingsRpcCalls.push(message);
        return original.call(chrome.runtime, message);
      };
    });
    await page.locator('[data-tab="info"]').click();
    await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
    await page.locator('#draft-policy').selectOption('send-scheduled');
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#draft-policy')).toHaveValue('skip');
    expect(await page.evaluate(() => window.__settingsRpcCalls)).toEqual([]);
    await page.locator('#draft-policy').selectOption('send-scheduled');
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.locator('#confirmation-accept').click();
    await expect(page.locator('#delivery-status')).toContainText('Saved.');
    await page.locator('[data-tab="send"]').click();
    await page.locator('#url').fill('https://claude.ai/chat/send-scheduled');
    await page.locator('#when').selectOption('1m');
    await page.locator('#message').fill('Scheduled replacement');
    await page.locator('#save').click();
    const provider = await context.newPage();
    await provider.goto('https://claude.ai/chat/send-scheduled');
    await provider.locator('[contenteditable="true"]').fill('Existing draft');
    await dueState(page);
    await tickFromPage(page);
    await expect(provider.locator('[data-testid="user-message"]')).toHaveText('Scheduled replacement');
    await expect(provider.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(provider.locator('[contenteditable="true"]')).toHaveText('');
    await page.evaluate(() => window.__restoreSettingsRpc());
    await provider.close();
  });
});

testWithExtension('saving warns when the composer already holds text', async ({ environment }) => {
  const { page, context } = environment;
  const provider = await context.newPage();
  await provider.goto('https://chatgpt.com/c/warn');
  await provider.locator('#prompt-textarea').fill('Half-written thought');
  await page.locator('#url').fill('https://chatgpt.com/c/warn');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Scheduled while mid-draft');
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toContainText('Message scheduled.');
  await expect(page.locator('#form-status')).toContainText('has text in its composer right now');
  await expect(page.locator('#form-status')).toContainText('one-off message will need your attention');
  await provider.close();
});

testWithExtension('saving does not warn or open a tab when the conversation is closed', async ({ environment }) => {
  const { page, context } = environment;
  const before = context.pages().length;
  await page.locator('#url').fill('https://chatgpt.com/c/not-open');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Nothing open yet');
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toContainText('Message scheduled.');
  await expect(page.locator('#form-status')).not.toContainText('composer right now');
  // Checking for a draft must never be the reason a conversation opens.
  expect(context.pages().length).toBe(before);
});

testWithExtension('checking a ready page turns the Check page control green', async ({ environment }) => {
  const { page, context } = environment;
  await expect(page.locator('.popup-awake-note')).toBeHidden();
  const provider = await context.newPage();
  await provider.goto('https://chatgpt.com/c/checks');
  await page.locator('#url').fill('https://chatgpt.com/c/checks');
  await page.locator('#check').click();
  await expect(page.locator('#check')).toHaveText('✓ Page ready');
  await expect(page.locator('#check')).toHaveClass(/check-success/);
  await expect(page.locator('#form-status')).toBeEmpty();
  await page.locator('#url').fill('https://chatgpt.com/c/other');
  await expect(page.locator('#check')).toHaveText('Check page');
  await expect(page.locator('#check')).not.toHaveClass(/check-success/);
  await provider.close();
});

testWithExtension('Check page warns when the selected draft policy permits an existing draft', async ({ environment }) => {
  const { page, context } = environment;
  const provider = await context.newPage();
  await provider.goto('https://chatgpt.com/c/check-draft');
  await provider.locator('#prompt-textarea').fill('Existing draft');
  await page.locator('[data-tab="info"]').click();
  await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
  await page.locator('#draft-policy').selectOption('send-draft');
  await expect(page.locator('#delivery-status')).toContainText('Saved.');
  await page.locator('[data-tab="send"]').click();
  await page.locator('#url').fill('https://chatgpt.com/c/check-draft');
  await page.locator('#check').click();
  await expect(page.locator('#form-status')).toHaveText('Page ready. The existing draft will be sent instead of the scheduled message.');
  await expect(page.locator('#form-status')).toHaveClass(/status warning/);
  await expect(page.locator('#check')).toHaveText('✓ Ready with draft');
  await expect(page.locator('#check')).toHaveClass(/check-success/);
  await page.locator('#url').fill('https://chatgpt.com/c/other');
  await expect(page.locator('#check')).toHaveText('Check page');
  await provider.close();
});

test('checking a page reports a concise failure', async () => {
  await withFixture({ missingEditor: true }, async ({ page, context }) => {
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/no-box');
    await page.locator('#url').fill('https://chatgpt.com/c/no-box');
    await page.locator('#check').click();
    await expect(page.locator('#check')).toHaveText('Check page');
    await expect(page.locator('#form-status')).toContainText('Composer was not found');
    await provider.close();
  });
});

test('a send button that appears only after typing still passes the compact check', async () => {
  await withFixture({ hydrateOnDemand: true }, async ({ page, context }) => {
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/late-send');
    await provider.evaluate(() => window.__hydrate());
    await page.locator('#url').fill('https://chatgpt.com/c/late-send');
    await page.locator('#check').click();
    await expect(page.locator('#check')).toHaveText('✓ Page ready');
    await expect(page.locator('#form-status')).toBeEmpty();
    await provider.close();
  });
});

testWithExtension('the compact popup exposes Settings & privacy', async ({ environment }) => {
  const { page, id } = environment;
  await page.goto(`chrome-extension://${id}/app.html?popup=1`);
  await page.locator('#scheduler-view').waitFor({ state: 'visible' });
  await page.locator('[data-tab="info"]').click();
  await expect(page.getByRole('tab', { name: 'Settings & privacy' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#info-title')).toHaveText('Settings & privacy');
  await expect(page.locator('#info-view')).toBeVisible();
  await expect(page.locator('#delivery-settings')).toBeVisible();
  await expect(page.locator('#privacy-settings')).toBeVisible();
  await expect(page.locator('.list-panel')).toBeHidden();
});

testWithExtension('limits saved messages to four until the queue is expanded', async ({ environment }) => {
  const { page } = environment;
  for (let index = 1; index <= 5; index += 1) {
    await page.locator('#url').fill(`https://chatgpt.com/c/queue-${index}`);
    await page.locator('#when').selectOption('1m');
    await page.locator('#message').fill(`Queued message ${index}`);
    await page.locator('#save').click();
    await expect(page.locator('#form-status')).toContainText('Message scheduled.');
  }
  await expect(page.locator('#job-count')).toHaveText('5');
  await expect(page.locator('#job-list .card')).toHaveCount(4);
  await expect(page.locator('#job-list-toggle')).toHaveText('Show all 5');
  await page.locator('#job-list-toggle').click();
  await expect(page.locator('#job-list .card')).toHaveCount(5);
  await expect(page.locator('#job-list-toggle')).toHaveText('Show fewer');
  await page.locator('#job-list-toggle').click();
  await expect(page.locator('#job-list .card')).toHaveCount(4);
});

testWithExtension('compact popup aligns recurring controls and explains invalid current tabs', async ({ environment }) => {
  const { context, id, page } = environment;
  const source = await context.newPage();
  await source.goto('https://chatgpt.com/');
  const sourceTab = await page.evaluate(async () => (await chrome.tabs.query({ url: 'https://chatgpt.com/' }))[0]);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: 600 });
  await popup.goto(`chrome-extension://${id}/app.html?popup=1&sourceTabId=${sourceTab.id}`);
  const shell = await popup.locator('.shell').boundingBox();
  expect(shell.height).toBeLessThanOrEqual(420);
  await expect(popup.locator('.popup-awake-note')).toBeVisible();
  await expect(popup.locator('.popup-awake-note')).toContainText('Keep the browser and computer awake.');
  const tabLayout = await popup.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    labels: [...document.querySelectorAll('[role="tab"]')].map(tab => ({ text: tab.textContent, nowrap: getComputedStyle(tab).whiteSpace })),
  }));
  expect(tabLayout.width).toBeLessThanOrEqual(tabLayout.clientWidth);
  expect(tabLayout.labels).toEqual([
    { text: 'Send later', nowrap: 'nowrap' },
    { text: 'Recurring', nowrap: 'nowrap' },
    { text: 'Activity', nowrap: 'nowrap' },
    { text: 'Settings & privacy', nowrap: 'nowrap' },
  ]);
  await popup.locator('[data-tab="recurring"]').click();
  await expect(popup.locator('#timezone')).toBeHidden();
  await expect(popup.locator('#next-preview')).toContainText('Open dashboard to change timezone.');
  const repeat = await popup.locator('#recurrence').boundingBox();
  const dailyTime = await popup.locator('#recurring-time').boundingBox();
  expect(Math.abs(repeat.y - dailyTime.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(repeat.width - dailyTime.width)).toBeLessThanOrEqual(2);
  await popup.locator('#recurrence').selectOption('interval');
  await expect(popup.locator('#interval-field')).toBeVisible();
  const interval = await popup.locator('#interval-hours').boundingBox();
  expect(Math.abs(repeat.y - interval.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(repeat.width - interval.width)).toBeLessThanOrEqual(2);
  const recurringShell = await popup.locator('.shell').boundingBox();
  expect(recurringShell.height).toBeLessThanOrEqual(425);
  await popup.evaluate(() => window.scrollTo(0, 0));
  await popup.screenshot({ path: path.join(root, 'artifacts/screenshots/popup-recurring.png') });
  await popup.locator('#current-tab').click();
  await expect(popup.locator('#current-tab-dialog')).toBeVisible();
  await expect(popup.locator('#current-tab-dialog')).toContainText('Start or open a conversation so it has its own conversation URL');
  await popup.close();
  await source.close();
});


testWithExtension('popup returns to its compact height after hiding saved messages and leaving Activity', async ({ environment }) => {
  const { page, context, id } = environment;
  for (let index = 1; index <= 5; index += 1) {
    await page.locator('#url').fill(`https://chatgpt.com/c/popup-size-${index}`);
    await page.locator('#when').selectOption('1m');
    await page.locator('#message').fill(`Popup size ${index}`);
    await page.locator('#save').click();
  }
  const stored = await readState(page);
  stored.history = Array.from({ length: 8 }, (_, index) => ({
    id: `popup-run-${index}`, jobId: stored.jobs[0].id, url: stored.jobs[0].url,
    provider: 'chatgpt', preview: `Activity ${index}`, dueAt: index + 1,
    startedAt: index + 1, finishedAt: index + 2, status: 'sent', detail: 'Done',
  }));
  await writeState(page, stored);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: 600 });
  await popup.goto(`chrome-extension://${id}/app.html?popup=1`);
  const shellHeight = () => popup.locator('.shell').evaluate(node => Math.ceil(node.getBoundingClientRect().height));
  const compact = await shellHeight();
  await popup.locator('#popup-queue-toggle').click();
  await expect.poll(shellHeight).toBeGreaterThan(compact);
  await popup.locator('#popup-queue-toggle').click();
  await expect.poll(shellHeight).toBeLessThanOrEqual(compact + 2);
  await popup.locator('[data-tab="activity"]').click();
  await expect.poll(shellHeight).toBeGreaterThan(compact);
  const popupEdges = await popup.evaluate(() => {
    const panel = document.querySelector('.form-panel').getBoundingClientRect();
    return {
      gutter: getComputedStyle(document.body).scrollbarGutter,
      viewport: document.documentElement.clientWidth,
      cards: [...document.querySelectorAll('#activity-list .card')].map(card => ({
        right: card.getBoundingClientRect().right,
        panelRight: panel.right,
      })),
    };
  });
  expect(popupEdges.gutter).toContain('stable');
  expect(popupEdges.cards.every(card => card.right <= popupEdges.viewport && card.right <= card.panelRight)).toBe(true);
  await popup.locator('[data-tab="recurring"]').click();
  await expect(popup.locator('#job-list')).toBeHidden();
  await expect.poll(shellHeight).toBeLessThanOrEqual(compact + 14);
  await popup.locator('[data-tab="activity"]').click();
  await expect.poll(shellHeight).toBeGreaterThan(compact);
  await popup.locator('[data-tab="send"]').click();
  await expect(popup.locator('#job-list')).toBeHidden();
  await expect.poll(shellHeight).toBeLessThanOrEqual(compact + 2);
  expect(await popup.evaluate(() => document.documentElement.classList.contains('popup-root') && getComputedStyle(document.documentElement).minHeight === '0px')).toBe(true);
  await popup.close();
});

testWithExtension('Settings & privacy sections use matching 13px heading typography', async ({ environment }) => {
  const { page } = environment;
  await page.locator('[data-tab="info"]').click();
  const sections = page.locator('#info-view .info-section');
  await expect(sections).toHaveCount(3);
  await expect(page.locator('.list-panel .info-section')).toHaveCount(0);
  await expect(sections.nth(0)).toContainText('Private by default');
  await expect(sections.nth(1)).toContainText('Delivery');
  await expect(sections.nth(2)).toContainText('Advanced privacy');
  await expect(page.locator('#draft-policy')).toHaveValue('skip');
  expect(await page.locator('#draft-policy option').allTextContents()).toEqual([
    'Send existing draft only',
    'Send draft, then scheduled message',
    'Send scheduled message only',
    'Do not send this occurrence',
  ]);
  await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
  await page.locator('#privacy-settings').evaluate(node => { node.open = true; });
  await expect(page.locator('#privacy-description')).not.toContainText('This does not protect against someone who controls the browser profile.');
  const styles = await page.evaluate(() => [...document.querySelectorAll('#info-view .info-section summary strong, #info-view .info-section h3')]
    .map(node => getComputedStyle(node).fontSize));
  expect(styles.length).toBe(5);
  expect(styles.every(size => size === '13px')).toBe(true);
  expect(await page.locator('#delivery-content h3').evaluate(node => getComputedStyle(node).fontSize)).toBe('13px');
  expect(await page.locator('#privacy-content h3').evaluate(node => getComputedStyle(node).fontSize)).toBe('13px');
});

testWithExtension('draft policy persists across renders, tabs, reloads, and failed writes roll back', async ({ environment }) => {
  const { page } = environment;
  await page.locator('[data-tab="info"]').click();
  await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
  await expect(page.locator('#draft-policy')).toHaveValue('skip');
  await page.locator('#draft-policy').selectOption('send-draft');
  await expect(page.locator('#draft-policy')).toHaveValue('send-draft');
  await expect(page.locator('#delivery-status')).toContainText('Saved.');
  await expect(page.locator('#draft-policy')).toHaveValue('send-draft');
  await page.locator('[data-tab="send"]').click();
  await page.locator('[data-tab="info"]').click();
  await expect(page.locator('#draft-policy')).toHaveValue('send-draft');
  await page.reload();
  await page.locator('[data-tab="info"]').click();
  await expect(page.locator('#draft-policy')).toHaveValue('send-draft');
  await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    window.__restoreDraftPolicyRpc = () => { chrome.runtime.sendMessage = original; };
    chrome.runtime.sendMessage = async message => {
      if (message.action === 'UPDATE_SETTINGS') throw new Error('Synthetic settings failure');
      return original.call(chrome.runtime, message);
    };
  });
  await page.locator('#draft-policy').selectOption('send-both');
  await expect(page.locator('#delivery-status')).toContainText('Synthetic settings failure');
  await expect(page.locator('#draft-policy')).toHaveValue('send-draft');
  await page.evaluate(() => window.__restoreDraftPolicyRpc());
});

testWithExtension('dashboard shell defaults are preserved while popup spacing is doubled', async ({ environment }) => {
  const { page, context, id } = environment;
  for (const [width, expected] of [[1024, '28px'], [700, '18px'], [500, '12px']]) {
    await page.setViewportSize({ width, height: 700 });
    expect(await page.locator('.shell').evaluate(node => getComputedStyle(node).paddingLeft)).toBe(expected);
  }
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: 600 });
  await popup.goto(`chrome-extension://${id}/app.html?popup=1`);
  await expect(popup.locator('#scheduler-view')).toBeVisible();
  expect(await popup.locator('.shell').evaluate(node => getComputedStyle(node).paddingLeft)).toBe('8px');
  await popup.close();
});

testWithExtension('activity entries can be deleted individually and cleared without deleting saved messages', async ({ environment }) => {
  const { page } = environment;
  await page.locator('#url').fill('https://chatgpt.com/c/activity-actions');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Saved activity message');
  await page.locator('#save').click();
  const stored = await readState(page);
  stored.jobs[0].status = 'running';
  stored.jobs[0].runId = 'activity-active';
  stored.history = [
    {
      id: 'activity-one', jobId: stored.jobs[0].id, url: stored.jobs[0].url, provider: 'chatgpt',
      preview: 'First activity', dueAt: 1, startedAt: 1, finishedAt: 2, status: 'sent', detail: 'Sent',
    },
    {
      id: 'activity-two', jobId: stored.jobs[0].id, url: stored.jobs[0].url, provider: 'chatgpt',
      preview: 'Second activity', dueAt: 3, startedAt: 3, finishedAt: 4, status: 'blocked', detail: 'Blocked',
    },
    {
      id: 'activity-active', jobId: stored.jobs[0].id, url: stored.jobs[0].url, provider: 'chatgpt',
      preview: 'Active activity', dueAt: 5, startedAt: 5, finishedAt: null, status: 'checking', detail: '',
    },
  ];
  await writeState(page, stored);
  await page.locator('[data-tab="activity"]').click();
  await expect(page.locator('#activity-list')).toContainText('First activity');
  await expect(page.locator('#activity-list .card')).toHaveCount(3);
  await expect(page.locator('#activity-list .card').filter({ hasText: 'Active activity' }).getByRole('button', { name: 'Delete' })).toHaveCount(0);
  const first = page.locator('#activity-list .card').filter({ hasText: 'First activity' });
  await first.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#confirmation-dialog')).toBeVisible();
  await page.locator('#confirmation-accept').click();
  await expect(page.locator('#activity-status')).toContainText('Activity deleted.');
  await expect(page.locator('#activity-list')).not.toContainText('First activity');
  await expect(page.locator('#activity-list')).toContainText('Second activity');
  expect((await readState(page)).jobs).toHaveLength(1);
  await page.locator('#clear-activity').click();
  await expect(page.locator('#confirmation-dialog')).toBeVisible();
  await page.locator('#confirmation-accept').click();
  await expect(page.locator('#activity-status')).toContainText('Activity cleared.');
  await expect(page.locator('#activity-list')).toContainText('Active activity');
  await expect(page.locator('#activity-list')).not.toContainText('Second activity');
  expect((await readState(page)).jobs).toHaveLength(1);
  expect((await readState(page)).history).toHaveLength(1);
});

testWithExtension('popup confirmation resets after success before Escape cancellation', async ({ environment }) => {
  const { page, context, id } = environment;
  const stored = await readState(page);
  stored.history = [{
    id: 'popup-confirm-run', jobId: 'missing', url: 'https://chatgpt.com/c/popup-confirm', provider: 'chatgpt',
    preview: 'Popup confirmation', dueAt: 1, startedAt: 1, finishedAt: 2, status: 'sent', detail: 'Sent',
  }];
  await writeState(page, stored);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: 600 });
  await popup.goto(`chrome-extension://${id}/app.html?popup=1`);
  await popup.locator('#scheduler-view').waitFor({ state: 'visible' });
  await popup.locator('[data-tab="activity"]').click();
  await expect(popup.locator('#activity-list')).toContainText('Popup confirmation');
  await expect(popup.locator('#clear-activity')).toBeVisible();
  await popup.locator('#clear-activity').click();
  await expect(popup.locator('#confirmation-dialog')).toBeVisible();
  await popup.locator('#confirmation-accept').click();
  await expect(popup.locator('#activity-status')).toContainText('Activity cleared.');
  await expect(popup.locator('#activity-list')).toContainText('No activity yet.');
  expect((await readState(page)).history).toHaveLength(0);

  const reseeded = await readState(page);
  reseeded.history = [{
    id: 'popup-confirm-run-again', jobId: 'missing', url: 'https://chatgpt.com/c/popup-confirm', provider: 'chatgpt',
    preview: 'Popup confirmation again', dueAt: 3, startedAt: 3, finishedAt: 4, status: 'sent', detail: 'Sent',
  }];
  await writeState(page, reseeded);
  await expect(popup.locator('#activity-list')).toContainText('Popup confirmation again');
  await expect(popup.locator('#clear-activity')).toBeVisible();
  await popup.locator('#clear-activity').click();
  await expect(popup.locator('#confirmation-dialog')).toBeVisible();
  await popup.locator('#confirmation-dialog').press('Escape');
  await expect(popup.locator('#confirmation-dialog')).toBeHidden();
  expect((await readState(page)).history).toHaveLength(1);
  await popup.close();
});

testWithExtension('preserves meaningful spaces and indentation in a scheduled prompt', async ({ environment }) => {
  const { page, context } = environment;
  const message = '  line  one\n    indented  line  ';
  await page.locator('#url').fill('https://chatgpt.com/c/whitespace');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill(message);
  await page.locator('#save').click();
  const provider = await context.newPage();
  await provider.goto('https://chatgpt.com/c/whitespace');
  await dueState(page);
  await tickFromPage(page);
  const delivered = await provider.locator('[data-message-author-role="user"]').evaluate(node => node.textContent);
  expect(delivered).toBe(message);
  await provider.close();
});


testWithExtension('programmatic conversation changes reset the compact page check', async ({ environment }) => {
  const { page, context } = environment;
  await page.locator('#url').fill('https://chatgpt.com/c/edit-target');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Editable job');
  await page.locator('#save').click();
  const checked = await context.newPage();
  await checked.goto('https://chatgpt.com/c/checked-target');
  await page.locator('#url').fill('https://chatgpt.com/c/checked-target');
  await page.locator('#check').click();
  await expect(page.locator('#check')).toHaveText('✓ Page ready');
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#url')).toHaveValue('https://chatgpt.com/c/edit-target');
  await expect(page.locator('#check')).toHaveText('Check page');
  await page.locator('#cancel-edit').click();
  await page.locator('#url').fill('https://chatgpt.com/c/checked-target');
  await page.locator('#check').click();
  await expect(page.locator('#check')).toHaveText('✓ Page ready');
  const current = await context.newPage();
  await current.goto('https://chatgpt.com/c/current-target');
  await current.bringToFront();
  await page.locator('#current-tab').click();
  await expect(page.locator('#url')).toHaveValue('https://chatgpt.com/c/current-target');
  await expect(page.locator('#check')).toHaveText('Check page');
  await current.close();
  await checked.close();
});

testWithExtension('a failed activity clear reports the error and restores the bin', async ({ environment }) => {
  const { page } = environment;
  const stored = await readState(page);
  stored.history = [{
    id: 'clear-failure-run', jobId: 'deleted', url: 'https://chatgpt.com/c/clear-failure',
    provider: 'chatgpt', preview: 'Clear failure', dueAt: 1, startedAt: 1,
    finishedAt: 2, status: 'sent', detail: 'Sent',
  }];
  await writeState(page, stored);
  await page.locator('[data-tab="activity"]').click();
  await expect(page.locator('#clear-activity')).toBeVisible();
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    window.__restoreClearRpc = () => { chrome.runtime.sendMessage = original; };
    chrome.runtime.sendMessage = async message => {
      if (message.action === 'CLEAR_ACTIVITY') throw new Error('Synthetic clear failure');
      return original.call(chrome.runtime, message);
    };
  });
  await page.locator('#clear-activity').click();
  await expect(page.locator('#confirmation-dialog')).toBeVisible();
  await page.locator('#confirmation-accept').click();
  await expect(page.locator('#activity-status')).toContainText('Synthetic clear failure');
  await expect(page.locator('#clear-activity')).toBeEnabled();
  expect((await readState(page)).history).toHaveLength(1);
  await page.evaluate(() => window.__restoreClearRpc());
});
