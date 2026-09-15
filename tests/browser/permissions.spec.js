import { expect, test } from '@playwright/test';
import path from 'node:path';
import { closeExtension, openExtension, readState, root } from './helpers.js';

const chatgptUrl = 'https://chatgpt.com/c/permission-gate';

async function withExtension(callback) {
  const environment = await openExtension();
  try {
    await callback(environment);
  } finally {
    await closeExtension(environment);
  }
}

async function openPermissionPage(environment, options = {}) {
  const sourceUrl = options.sourceUrl || chatgptUrl;
  const source = await environment.context.newPage();
  await source.goto(sourceUrl);
  const sourceTab = await environment.page.evaluate(async sourceUrl => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url === sourceUrl);
  }, sourceUrl);
  if (!sourceTab) throw new Error('Permission fixture source tab was not found.');
  const popup = await environment.context.newPage();
  await popup.addInitScript(({ initiallyGranted, requestResult }) => {
    const key = 'permission-fixture-granted';
    const callsKey = 'permission-fixture-calls';
    if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, initiallyGranted ? '1' : '0');
    if (sessionStorage.getItem(callsKey) === null) sessionStorage.setItem(callsKey, '[]');
    window.__setPermission = value => sessionStorage.setItem(key, value ? '1' : '0');
    window.__permissionCalls = () => JSON.parse(sessionStorage.getItem(callsKey));
    chrome.permissions.contains = async () => sessionStorage.getItem(key) === '1';
    chrome.permissions.request = async details => {
      const calls = JSON.parse(sessionStorage.getItem(callsKey));
      calls.push({ details, active: navigator.userActivation.isActive });
      sessionStorage.setItem(callsKey, JSON.stringify(calls));
      if (requestResult) sessionStorage.setItem(key, '1');
      return requestResult;
    };
  }, { initiallyGranted: options.initiallyGranted ?? false, requestResult: options.requestResult ?? true });
  const query = options.dashboard ? '' : `?popup=1&sourceTabId=${sourceTab.id}`;
  await popup.goto(`chrome-extension://${environment.id}/app.html${query}`);
  return { popup, source };
}

test('provider gate requests only ChatGPT before showing the scheduler', async () => {
  await withExtension(async environment => {
    const { popup } = await openPermissionPage(environment);
    await expect(popup.locator('#permission-panel')).toBeVisible();
    await expect(popup.locator('#permission-title')).toHaveText('Allow ChatGPT access');
    await expect(popup.locator('#permission-description')).toHaveText('Prompt Later needs access to https://chatgpt.com to check this conversation and send scheduled messages. Access is limited to this site and can be removed in Chrome settings.');
    await expect(popup.locator('#scheduler-view')).toBeHidden();
    expect(await popup.evaluate(() => window.__permissionCalls())).toEqual([]);
    await popup.screenshot({ path: path.join(root, 'artifacts/screenshots/permission-gate.png') });
    await popup.locator('#permission-allow').click();
    await expect(popup.locator('#scheduler-view')).toBeVisible();
    await expect(popup.locator('#url')).toHaveValue(chatgptUrl);
    await expect(popup.locator('#form-status')).toContainText('ChatGPT access granted');
    expect(await popup.evaluate(() => window.__permissionCalls())).toEqual([{ details: { origins: ['https://chatgpt.com/*'] }, active: true }]);
    await popup.locator('#when').selectOption('1m');
    await popup.locator('#message').fill('Permission gate fixture');
    await popup.locator('#save').click();
    await expect(popup.locator('#form-status')).toContainText('Message scheduled.');
    expect(await popup.evaluate(() => window.__permissionCalls())).toHaveLength(1);
    expect((await readState(popup)).jobs).toHaveLength(1);
    await popup.reload();
    await expect(popup.locator('#permission-panel')).toBeHidden();
    await expect(popup.locator('#scheduler-view')).toBeVisible();
    await expect(popup.locator('#url')).toHaveValue(chatgptUrl);
    expect(await popup.evaluate(() => window.__permissionCalls())).toHaveLength(1);
  });
});

test('permission denial leaves the gate visible and creates no job', async () => {
  await withExtension(async environment => {
    const { popup } = await openPermissionPage(environment, { requestResult: false });
    await expect(popup.locator('#permission-title')).toHaveText('Allow ChatGPT access');
    await popup.locator('#permission-allow').click();
    await expect(popup.locator('#permission-status')).toHaveText('Access was not granted. Nothing was scheduled or sent.');
    await expect(popup.locator('#permission-panel')).toBeVisible();
    await expect(popup.locator('#scheduler-view')).toBeHidden();
    expect(await popup.evaluate(() => window.__permissionCalls())).toEqual([{ details: { origins: ['https://chatgpt.com/*'] }, active: true }]);
    expect((await readState(popup)).jobs).toHaveLength(0);
    await popup.locator('#permission-dismiss').click();
    await expect(popup.locator('#scheduler-view')).toBeVisible();
    await expect(popup.locator('#url')).toHaveValue('');
  });
});

test('permission removed after form entry is reacquired without losing the form', async () => {
  await withExtension(async environment => {
    const { popup } = await openPermissionPage(environment, { initiallyGranted: true });
    await expect(popup.locator('#scheduler-view')).toBeVisible();
    await popup.locator('#when').selectOption('1m');
    await popup.locator('#message').fill('Preserve this unsaved message');
    await popup.locator('.options > summary').click();
    await popup.locator('#missed-policy').selectOption('run-once');
    await popup.evaluate(() => window.__setPermission(false));
    await popup.locator('#save').click();
    await expect(popup.locator('#permission-title')).toHaveText('Allow ChatGPT access');
    expect(await popup.evaluate(() => window.__permissionCalls())).toEqual([]);
    expect((await readState(popup)).jobs).toHaveLength(0);
    await popup.locator('#permission-allow').click();
    await expect(popup.locator('#scheduler-view')).toBeVisible();
    await expect(popup.locator('#url')).toHaveValue(chatgptUrl);
    await expect(popup.locator('#when')).toHaveValue('1m');
    await expect(popup.locator('#message')).toHaveValue('Preserve this unsaved message');
    await expect(popup.locator('#missed-policy')).toHaveValue('run-once');
    expect((await readState(popup)).jobs).toHaveLength(0);
    await popup.locator('#save').click();
    await expect(popup.locator('#form-status')).toContainText('Message scheduled.');
    expect(await popup.evaluate(() => window.__permissionCalls())).toHaveLength(1);
    expect((await readState(popup)).jobs[0].message).toBe('Preserve this unsaved message');
  });
});

test('manual dashboard URL selection gates before message entry', async () => {
  await withExtension(async environment => {
    const { popup: dashboard } = await openPermissionPage(environment, { dashboard: true, sourceUrl: 'https://claude.ai/chat/permission-gate' });
    await expect(dashboard.locator('#scheduler-view')).toBeVisible();
    await dashboard.locator('#url').fill('https://claude.ai/chat/permission-gate');
    await dashboard.locator('#url').press('Tab');
    await expect(dashboard.locator('#permission-title')).toHaveText('Allow Claude access');
    await expect(dashboard.locator('#scheduler-view')).toBeHidden();
    expect(await dashboard.evaluate(() => window.__permissionCalls())).toEqual([]);
    await dashboard.locator('#permission-dismiss').click();
    await expect(dashboard.locator('#scheduler-view')).toBeVisible();
    await expect(dashboard.locator('#url')).toHaveValue('');
  });
});
