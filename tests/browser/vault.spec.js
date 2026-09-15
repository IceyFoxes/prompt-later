import { expect, test } from '@playwright/test';
import path from 'node:path';
import { closeExtension, openExtension, readState, restartExtension, root, tickFromPage, writeState } from './helpers.js';

const passphrase = 'Synthetic vault passphrase';
const vaultKey = 'prompt-later.vault.v1';
const sessionKey = 'prompt-later.vault-session.v1';
const legacyKey = 'prompt-later.v1';
const targetUrl = 'https://chatgpt.com/c/vault-fixture';

function fixtureState() {
  const now = Date.now();
  return {
    version: 1,
    jobs: [{ id: 'legacy-job', url: targetUrl, provider: 'chatgpt', message: 'Legacy private prompt', schedule: { type: 'once', at: now + 3600000, timeZone: 'UTC' }, missedPolicy: 'skip', createdAt: now, updatedAt: now, enabled: true, status: 'scheduled', nextRunAt: now + 3600000, runId: null, lastOutcome: null, lastDetail: '' }],
    history: [{ id: 'legacy-run', jobId: 'legacy-job', url: targetUrl, provider: 'chatgpt', preview: 'Legacy activity', dueAt: 1, startedAt: 1, finishedAt: 2, status: 'sent', detail: '' }],
  };
}

async function withExtension(options, callback) {
  const environment = await openExtension(options);
  try { await callback(environment); } finally { await closeExtension(environment); }
}

async function enterPassphrase(page, value, setup = false) {
  await expect(page.locator('#vault-passphrase')).toBeEnabled();
  await page.locator('#vault-passphrase').fill(value);
  if (setup) await page.locator('#vault-confirm').fill(value);
  await page.locator('#vault-submit').click();
}

async function saveJob(page, message) {
  await page.locator('#url').fill(targetUrl);
  await page.locator('#message').fill(message);
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toHaveText('Message scheduled.');
  await expect(page.locator('#save')).toBeEnabled();
}

const envelope = page => page.evaluate(async key => (await chrome.storage.local.get(key))[key], vaultKey);

test('vault setup encrypts state and rejects invalid confirmation', async () => {
  await withExtension({ setupVault: false }, async ({ page }) => {
    await expect(page.locator('#scheduler-view')).toBeHidden();
    await expect(page.locator('#vault-submit')).toBeEnabled();
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/vault-setup.png'), fullPage: true });
    await page.locator('#vault-passphrase').fill('short');
    await page.locator('#vault-confirm').fill('short');
    await page.locator('#vault-submit').click();
    expect(await envelope(page)).toBeUndefined();
    await page.locator('#vault-passphrase').fill(passphrase);
    await page.locator('#vault-confirm').fill('Different synthetic phrase');
    await page.locator('#vault-submit').click();
    await expect(page.locator('#vault-status')).toContainText('do not match');
    expect(await envelope(page)).toBeUndefined();
    await enterPassphrase(page, passphrase, true);
    await expect(page.locator('#scheduler-view')).toBeVisible();
    await expect(page.locator('#vault-passphrase')).toHaveValue('');
    await expect(page.locator('#vault-confirm')).toHaveValue('');
    await saveJob(page, 'Encrypted synthetic prompt');
    const raw = await page.evaluate(async () => chrome.storage.local.get(null));
    expect(raw[vaultKey]).toBeTruthy();
    expect(raw[legacyKey]).toBeUndefined();
    for (const secret of ['Encrypted synthetic prompt', targetUrl, passphrase]) expect(JSON.stringify(raw)).not.toContain(secret);
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/vault-unlocked.png'), fullPage: true });
  });
});

test('vault migrates exact legacy jobs and activity after setup', async () => {
  await withExtension({ setupVault: false }, async ({ page }) => {
    const legacy = fixtureState();
    await page.evaluate(({ key, value }) => chrome.storage.local.set({ [key]: value }), { key: legacyKey, value: legacy });
    await page.reload();
    await expect(page.locator('#scheduler-view')).toBeHidden();
    await enterPassphrase(page, passphrase, true);
    await expect(page.locator('#scheduler-view')).toBeVisible();
    expect(await readState(page)).toEqual(legacy);
    expect(await page.evaluate(async key => (await chrome.storage.local.get(key))[key], legacyKey)).toBeUndefined();
  });
});

for (const action of ['GET_VAULT_STATUS', 'GET_STATE']) {
  test(`vault clears decrypted UI on failed ${action} RPC`, async () => {
    await withExtension({}, async ({ page }) => {
      await saveJob(page, 'Private saved fixture text');
      await page.locator('#message').fill('Private unsaved fixture text');
      await page.evaluate(async ({ action, key }) => {
        const original = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = async message => {
          if (message.action === action) {
            if (action === 'GET_VAULT_STATUS') throw new Error('Synthetic vault status failure');
            return { ok: false, error: 'Synthetic vault state failure' };
          }
          return original.call(chrome.runtime, message);
        };
        const cached = (await chrome.storage.session.get(key))[key];
        await chrome.storage.session.set({ [key]: { ...cached, testRevision: 1 } });
      }, { action, key: sessionKey });
      await expect(page.locator('#vault-panel')).toBeVisible();
      await expect(page.locator('#scheduler-view')).toBeHidden();
      await expect(page.locator('#vault-status')).toContainText('Synthetic vault');
      await expect(page.locator('#message')).toHaveValue('');
      await expect(page.locator('#url')).toHaveValue('');
      expect(await page.locator('body').textContent()).not.toContain('Private saved fixture text');
      for (const selector of ['#save', '#check', '#current-tab']) await expect(page.locator(selector)).toBeDisabled();
      if (action === 'GET_VAULT_STATUS') await expect(page.locator('#vault-submit')).toBeDisabled();
      else await expect(page.locator('#vault-submit')).toBeEnabled();
    });
  });
}

test('vault browser restart locks and applies both late policies once', async () => {
  test.setTimeout(60000);
  await withExtension({}, async environment => {
    await tickFromPage(environment.page);
    await environment.page.evaluate(() => chrome.alarms.clearAll());
    const original = fixtureState().jobs[0];
    const due = Date.now() - 400000;
    const jobs = ['run-once', 'skip'].map(policy => ({ ...original, id: `${policy}-job`, message: `Restart ${policy} fixture`, missedPolicy: policy, schedule: { ...original.schedule, at: due }, nextRunAt: due }));
    await writeState(environment.page, { version: 1, jobs, history: [] });
    await restartExtension(environment);
    const { page, context } = environment;
    await expect(page.locator('#vault-submit')).toHaveText('Unlock and resume');
    await expect(page.locator('#scheduler-view')).toBeHidden();
    expect(await page.evaluate(async key => (await chrome.storage.session.get(key))[key], sessionKey)).toBeUndefined();
    const blocked = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'GET_STATE' }));
    expect(blocked).toMatchObject({ ok: false, code: 'VAULT_LOCKED' });
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('LOCK');
    expect(await page.locator('body').textContent()).not.toContain('Restart run-once fixture');
    const provider = await context.newPage();
    await provider.goto(targetUrl);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(0);
    const before = await envelope(page);
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/vault-locked.png'), fullPage: true });
    await enterPassphrase(page, 'Incorrect synthetic passphrase');
    await expect(page.locator('#vault-status')).toContainText('incorrect');
    expect(await envelope(page)).toEqual(before);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(0);
    await enterPassphrase(page, passphrase);
    await expect(page.locator('#scheduler-view')).toBeVisible();
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveText('Restart run-once fixture');
    await tickFromPage(page);
    const stored = await readState(page);
    expect(stored.history.map(run => run.status).sort()).toEqual(['sent', 'skipped']);
    expect(stored.jobs.every(job => job.status === 'completed' && !job.enabled)).toBe(true);
    await tickFromPage(page);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(1);
  });
});

test('vault worker-only restart retains the unlock key and saved jobs', async () => {
  await withExtension({}, async ({ page, context, id }) => {
    await saveJob(page, 'Worker restart fixture');
    await tickFromPage(page);
    const before = await readState(page);
    const session = await context.newCDPSession(page);
    const { targetInfos } = await session.send('Target.getTargets');
    const workers = targetInfos.filter(target => target.type === 'service_worker' && target.url === `chrome-extension://${id}/worker.js`);
    expect(workers).toHaveLength(1);
    const result = await session.send('Target.closeTarget', { targetId: workers[0].targetId });
    expect(result.success).toBe(true);
    const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'GET_STATE' }));
    expect(response.ok).toBe(true);
    expect(response.data).toEqual(before);
    expect(await page.evaluate(async key => Boolean((await chrome.storage.session.get(key))[key]), sessionKey)).toBe(true);
    await expect(page.locator('#scheduler-view')).toBeVisible();
    await session.detach();
  });
});

test('vault content contexts cannot unlock or read extension storage', async () => {
  await withExtension({}, async ({ page, context }) => {
    await tickFromPage(page);
    const before = await envelope(page);
    const provider = await context.newPage();
    await provider.goto(targetUrl);
    const result = await page.evaluate(async ({ url, passphrase }) => {
      const [tab] = await chrome.tabs.query({ url });
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', args: [passphrase],
        func: async passphrase => {
          const rpc = [];
          for (const action of ['SETUP_VAULT', 'UNLOCK_VAULT']) {
            try { rpc.push(Boolean((await chrome.runtime.sendMessage({ type: 'PL_UI', action, payload: { passphrase } }))?.ok)); } catch { rpc.push(false); }
          }
          const storage = {};
          for (const area of ['local', 'session']) {
            try { await chrome.storage[area].get(null); storage[area] = 'allowed'; } catch { storage[area] = 'denied'; }
          }
          return { rpc, storage };
        },
      });
      return execution.result;
    }, { url: targetUrl, passphrase });
    expect(result).toEqual({ rpc: [false, false], storage: { local: 'denied', session: 'denied' } });
    expect(await envelope(page)).toEqual(before);
  });
});

test('vault popup captures its source conversation after setup', async () => {
  await withExtension({ setupVault: false }, async ({ page, context, id }) => {
    const provider = await context.newPage();
    await provider.goto(targetUrl);
    const tab = await page.evaluate(async url => (await chrome.tabs.query({ url }))[0], targetUrl);
    await page.goto(`chrome-extension://${id}/app.html?popup=1&sourceTabId=${tab.id}`);
    await page.evaluate(() => {
      window.__vaultActions = [];
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = message => {
        window.__vaultActions.push(message.action);
        return original.call(chrome.runtime, message);
      };
    });
    await enterPassphrase(page, passphrase, true);
    await expect(page.locator('#scheduler-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__vaultActions)).toContain('CURRENT_TAB');
    await expect(page.locator('#url')).toHaveValue(targetUrl);
    expect(await page.evaluate(() => window.__vaultActions.filter(action => action === 'CURRENT_TAB').length)).toBe(1);
  });
});

test('vault asynchronous save does not reuse a previous success message', async () => {
  await withExtension({}, async ({ page }) => {
    await saveJob(page, 'First saved fixture');
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage;
      const held = new Promise(resolve => { window.__finishFixtureSave = resolve; });
      chrome.runtime.sendMessage = async message => {
        if (message.action === 'UPSERT_JOB') await held;
        return original.call(chrome.runtime, message);
      };
    });
    await page.locator('#url').fill(targetUrl);
    await page.locator('#message').fill('Second saved fixture');
    await page.locator('#save').click();
    await expect(page.locator('#save')).toBeDisabled();
    await expect(page.locator('#form-status')).not.toHaveText('Message scheduled.');
    expect((await readState(page)).jobs).toHaveLength(1);
    await page.evaluate(() => window.__finishFixtureSave());
    await expect(page.locator('#form-status')).toHaveText('Message scheduled.');
    await expect(page.locator('#save')).toBeEnabled();
    expect((await readState(page)).jobs).toHaveLength(2);
  });
});
