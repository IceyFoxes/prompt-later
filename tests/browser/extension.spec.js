import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeExtension, dueState, openExtension, root, tickFromPage } from './helpers.js';


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

test('production manifest keeps declared providers optional', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  expect(manifest.optional_host_permissions).toEqual([
    'https://chatgpt.com/*', 'https://claude.ai/*', 'https://app.devin.ai/*',
    'https://gemini.google.com/*', 'https://grok.com/*', 'https://chat.deepseek.com/*',
    'https://www.kimi.com/*', 'https://kimi.com/*', 'https://www.perplexity.ai/*',
    'https://perplexity.ai/*', 'https://copilot.microsoft.com/*', 'https://chat.qwen.ai/*',
    'https://chat.mistral.ai/*',
  ]);
  expect(manifest.host_permissions).toBeUndefined();
});

testWithExtension('saves, previews, and delivers to the chosen conversation', async ({ environment }) => {
  const { page, context, id } = environment;
  await page.locator('#url').fill('https://chatgpt.com/c/fixture');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Synthetic browser prompt');
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toContainText('Message scheduled.');
  await page.screenshot({ path: path.join(root, 'artifacts/screenshots/dashboard.png'), fullPage: true });
  await page.locator('[data-tab="recurring"]').click();
  await expect(page.locator('#recurring-fields')).toBeVisible();
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
  await expect(page.locator('#job-list')).toContainText('completed');
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
  await expect(page.locator('#job-list')).toContainText('Waiting to retry');
  await expect(provider.locator('#prompt-textarea')).toHaveValue('Existing draft');
  await provider.close();
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
  expect(shell.height).toBeLessThanOrEqual(405);
  await popup.locator('[data-tab="recurring"]').click();
  const repeat = await popup.locator('#recurrence').boundingBox();
  const interval = await popup.locator('#interval-hours').boundingBox();
  expect(Math.abs(repeat.y - interval.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(repeat.width - interval.width)).toBeLessThanOrEqual(2);
  const recurringShell = await popup.locator('.shell').boundingBox();
  expect(recurringShell.height).toBeLessThanOrEqual(415);
  await popup.evaluate(() => window.scrollTo(0, 0));
  await popup.screenshot({ path: path.join(root, 'artifacts/screenshots/popup-recurring.png') });
  await popup.locator('#current-tab').click();
  await expect(popup.locator('#current-tab-dialog')).toBeVisible();
  await expect(popup.locator('#current-tab-dialog')).toContainText('fresh provider homepage');
  await popup.close();
  await source.close();
});
