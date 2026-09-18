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
  await expect(page.locator('#job-list')).toContainText('Needs attention');
  await expect(provider.locator('#prompt-textarea')).toHaveValue('Existing draft');
  await provider.close();
});

testWithExtension('the stop draft setting holds the message for attention instead of waiting', async ({ environment }) => {
  const { page, context } = environment;
  await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
  await page.locator('#draft-policy').selectOption('stop');
  await expect(page.locator('#delivery-status')).toContainText('Saved.');
  await page.locator('#url').fill('https://chatgpt.com/c/draft-stop');
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill('Held for attention');
  await page.locator('#save').click();
  const provider = await context.newPage();
  await provider.goto('https://chatgpt.com/c/draft-stop');
  await provider.locator('#prompt-textarea').fill('Existing draft');
  await dueState(page);
  await tickFromPage(page);
  await expect(page.locator('#job-list')).toContainText('Needs attention');
  await expect(provider.locator('#prompt-textarea')).toHaveValue('Existing draft');
  await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(0);
  // The choice survives a reload of the dashboard.
  await page.reload();
  await expect(page.locator('#draft-policy')).toHaveValue('stop');
  await provider.close();
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
  await expect(page.locator('#form-status')).toContainText('held for your attention');
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

testWithExtension('the compact popup does not offer delivery settings', async ({ environment }) => {
  const { page, id } = environment;
  await page.goto(`chrome-extension://${id}/app.html?popup=1`);
  await page.locator('#scheduler-view').waitFor({ state: 'visible' });
  await expect(page.locator('#delivery-settings')).toBeHidden();
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
  await popup.locator('[data-tab="recurring"]').click();
  await expect(popup.locator('#job-list')).toBeHidden();
  await expect.poll(shellHeight).toBeLessThanOrEqual(compact + 2);
  await popup.locator('[data-tab="activity"]').click();
  await expect.poll(shellHeight).toBeGreaterThan(compact);
  await popup.locator('[data-tab="send"]').click();
  await expect(popup.locator('#job-list')).toBeHidden();
  await expect.poll(shellHeight).toBeLessThanOrEqual(compact + 2);
  expect(await popup.evaluate(() => document.documentElement.classList.contains('popup-root') && getComputedStyle(document.documentElement).minHeight === '0px')).toBe(true);
  await popup.close();
});

testWithExtension('Delivery and Advanced privacy use matching body typography', async ({ environment }) => {
  const { page } = environment;
  await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
  await page.locator('#privacy-settings').evaluate(node => { node.open = true; });
  const styles = await page.evaluate(() => {
    const read = selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return { fontSize: style.fontSize, color: style.color, marginBottom: style.marginBottom };
    };
    return {
      deliveryHeading: read('#delivery-content h3'), privacyHeading: read('#privacy-content h3'),
      deliveryCopy: read('#delivery-content > p'), privacyCopy: read('#privacy-content > p'),
    };
  });
  expect(styles.deliveryHeading).toEqual(styles.privacyHeading);
  expect(styles.deliveryCopy).toEqual(styles.privacyCopy);
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
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-activity').click();
  await expect(page.locator('#activity-status')).toContainText('Synthetic clear failure');
  await expect(page.locator('#clear-activity')).toBeEnabled();
  expect((await readState(page)).history).toHaveLength(1);
  await page.evaluate(() => window.__restoreClearRpc());
});
