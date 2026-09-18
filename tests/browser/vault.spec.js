import { expect, test } from '@playwright/test';
import path from 'node:path';
import { closeExtension, openExtension, readState, restartExtension, root, tickFromPage, writeState } from './helpers.js';

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

async function saveJob(page, message) {
  await page.locator('#url').fill(targetUrl);
  await page.locator('#message').fill(message);
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toHaveText('Message scheduled.');
  await expect(page.locator('#save')).toBeEnabled();
}

const envelope = page => page.evaluate(async key => (await chrome.storage.local.get(key))[key], vaultKey);
const status = page => page.evaluate(() => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'GET_VAULT_STATUS' }));
const keyInfo = page => page.evaluate(async () => {
  const { createDeviceKeyStore } = await import(chrome.runtime.getURL('vault-fixture.js'));
  const key = await createDeviceKeyStore().get();
  let exported = false;
  try { await crypto.subtle.exportKey('raw', key); exported = true; } catch {}
  return { type: key.type, algorithm: key.algorithm, usages: key.usages.slice().sort(), extractable: key.extractable, exported };
});

test('fresh installation schedules immediately with non-exportable device encryption and no onboarding gate', async () => {
  await withExtension({}, async ({ page }) => {
    await expect(page.locator('#scheduler-view')).toBeVisible();
    await expect(page.locator('#vault-panel')).toBeHidden();
    await expect(page.locator('input[type="password"]:visible')).toHaveCount(0);
    await expect(page.locator('#privacy-settings')).not.toHaveAttribute('open');
    expect(await keyInfo(page)).toEqual({ type: 'secret', algorithm: { name: 'AES-GCM', length: 256 }, usages: ['decrypt', 'encrypt'], extractable: false, exported: false });
    await saveJob(page, 'Encrypted synthetic prompt');
    const raw = await page.evaluate(() => chrome.storage.local.get(null));
    expect(raw[vaultKey]).toMatchObject({ version: 2, mode: 'device' });
    expect(Object.keys(raw)).toEqual([vaultKey]);
    for (const secret of ['Encrypted synthetic prompt', targetUrl]) expect(JSON.stringify(raw)).not.toContain(secret);
    expect(await page.evaluate(key => chrome.storage.session.get(key), sessionKey)).toEqual({});
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/device-scheduler.png'), fullPage: true });
  });
});

test('fresh popup can save and never displays advanced settings or password controls', async () => {
  await withExtension({ path: 'app.html?popup=1' }, async ({ page }) => {
    await expect(page.locator('#privacy-settings')).toBeHidden();
    await expect(page.locator('input[type="password"]:visible')).toHaveCount(0);
    await saveJob(page, 'Fresh popup fixture');
    expect((await readState(page)).jobs[0].message).toBe('Fresh popup fixture');
  });
});

test('legacy plaintext migrates automatically and preserves exact jobs and activity', async () => {
  await withExtension({}, async ({ page }) => {
    await tickFromPage(page);
    await page.evaluate(() => chrome.alarms.clearAll());
    const legacy = fixtureState();
    await page.evaluate(async ({ key, value, vaultKey }) => {
      await chrome.storage.local.set({ [key]: value });
      await chrome.storage.local.remove(vaultKey);
    }, { key: legacyKey, value: legacy, vaultKey });
    await page.reload();
    await expect(page.locator('#scheduler-view')).toBeVisible();
    expect(await readState(page)).toEqual(legacy);
    expect(await page.evaluate(key => chrome.storage.local.get(key), legacyKey)).toEqual({});
    expect((await envelope(page)).mode).toBe('device');
  });
});

test('device protection keeps exact data automatically available after browser restart', async () => {
  await withExtension({}, async environment => {
    const original = fixtureState();
    await writeState(environment.page, original);
    await tickFromPage(environment.page);
    await restartExtension(environment);
    const { page } = environment;
    await expect(page.locator('#scheduler-view')).toBeVisible();
    await expect(page.locator('#vault-panel')).toBeHidden();
    expect(await readState(page)).toEqual(original);
    expect((await status(page)).data).toMatchObject({ mode: 'device' });
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
    expect((await keyInfo(page)).extractable).toBe(false);
  });
});

test('worker-only restart keeps saved data usable', async () => {
  await withExtension({}, async ({ page, context, id }) => {
      await saveJob(page, 'Worker restart fixture');
      await tickFromPage(page);
      const before = await readState(page);
      const session = await context.newCDPSession(page);
      const { targetInfos } = await session.send('Target.getTargets');
      const workers = targetInfos.filter(target => target.type === 'service_worker' && target.url === `chrome-extension://${id}/worker.js`);
      expect(workers).toHaveLength(1);
      expect((await session.send('Target.closeTarget', { targetId: workers[0].targetId })).success).toBe(true);
      const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'GET_STATE' }));
      expect(response).toMatchObject({ ok: true, data: before });
      expect(await page.evaluate(async key => Boolean((await chrome.storage.session.get(key))[key]), sessionKey)).toBe(false);
      await session.detach();
  });
});

for (const action of ['GET_VAULT_STATUS', 'GET_STATE']) {
  test(`vault clears decrypted UI on failed ${action} RPC and offers retry`, async () => {
    await withExtension({}, async ({ page }) => {
      await saveJob(page, 'Private saved fixture text');
      await page.locator('#message').fill('Private unsaved fixture text');
      await page.evaluate(async ({ action, key }) => {
        const original = chrome.runtime.sendMessage;
        window.__restoreVaultRpc = () => { chrome.runtime.sendMessage = original; };
        chrome.runtime.sendMessage = async message => {
          if (message.action === action) {
            if (action === 'GET_VAULT_STATUS') throw new Error('Synthetic vault status failure');
            return { ok: false, error: 'Synthetic vault state failure' };
          }
          return original.call(chrome.runtime, message);
        };
        await chrome.storage.session.set({ [key]: { testRevision: 1 } });
      }, { action, key: sessionKey });
      await expect(page.locator('#vault-panel')).toBeVisible();
      await expect(page.locator('#scheduler-view')).toBeHidden();
      await expect(page.locator('#vault-status')).toContainText('Synthetic vault');
      await expect(page.locator('#message')).toHaveValue('');
      await expect(page.locator('#url')).toHaveValue('');
      expect(await page.locator('body').textContent()).not.toContain('Private saved fixture text');
      for (const selector of ['#save', '#check', '#current-tab']) await expect(page.locator(selector)).toBeDisabled();
      await expect(page.locator('#vault-retry')).toBeVisible();
      await page.evaluate(() => window.__restoreVaultRpc());
      await page.locator('#vault-retry').click();
      await expect(page.locator('#scheduler-view')).toBeVisible();
      await expect(page.locator('#job-list')).toContainText('Private saved fixture text');
    });
  });
}

test('content contexts cannot read state, change settings, or access extension storage', async () => {
  await withExtension({}, async ({ page, context }) => {
    await tickFromPage(page);
    const before = await envelope(page);
    const provider = await context.newPage();
    await provider.goto(targetUrl);
    const result = await page.evaluate(async ({ url }) => {
      const [tab] = await chrome.tabs.query({ url });
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED',
        func: async () => {
          const rpc = [];
          for (const action of ['GET_STATE', 'UPDATE_SETTINGS', 'DELETE_JOB']) {
            try { rpc.push(Boolean((await chrome.runtime.sendMessage({ type: 'PL_UI', action, payload: {} }))?.ok)); } catch { rpc.push(false); }
          }
          const storage = {};
          for (const area of ['local', 'session']) {
            try { await chrome.storage[area].get(null); storage[area] = 'allowed'; } catch { storage[area] = 'denied'; }
          }
          return { rpc, storage };
        },
      });
      return execution.result;
    }, { url: targetUrl });
    expect(result).toEqual({ rpc: [false, false, false], storage: { local: 'denied', session: 'denied' } });
    expect(await envelope(page)).toEqual(before);
  });
});

test('concurrent IndexedDB getOrCreate calls reuse one non-exportable working key', async () => {
  await withExtension({}, async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createDeviceKeyStore } = await import(chrome.runtime.getURL('vault-fixture.js'));
      const keys = await Promise.all(Array.from({ length: 8 }, () => createDeviceKeyStore().getOrCreate('concurrent-fixture')));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys[0], new TextEncoder().encode('Same persisted key'));
      const values = await Promise.all(keys.map(async key => new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed))));
      return { values, extractable: keys.map(key => key.extractable) };
    });
    expect(result.values).toEqual(Array(8).fill('Same persisted key'));
    expect(result.extractable).toEqual(Array(8).fill(false));
  });
});

test('malformed and extractable IndexedDB records are rejected without replacement', async () => {
  await withExtension({}, async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createDeviceKeyStore } = await import(chrome.runtime.getURL('vault-fixture.js'));
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('prompt-later-keys', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const results = [];
      try {
        for (const record of [{ id: 'invalid-fixture' }, { id: 'invalid-fixture', key: null }, { id: 'invalid-fixture', key }]) {
          await new Promise((resolve, reject) => {
            const tx = db.transaction('keys', 'readwrite');
            tx.objectStore('keys').put(record);
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
          });
          let error;
          try { await createDeviceKeyStore().getOrCreate(record.id); } catch (failure) { error = failure.message; }
          const after = await new Promise(resolve => {
            const request = db.transaction('keys').objectStore('keys').get(record.id);
            request.onsuccess = () => resolve(request.result);
          });
          results.push({ error, fields: Object.keys(after).sort(), extractable: after.key?.extractable ?? null });
        }
      } finally { db.close(); }
      return results;
    });
    expect(result.map(item => item.error)).toEqual(Array(3).fill('The saved automatic encryption key is invalid. Nothing was reset.'));
    expect(result.map(item => item.fields)).toEqual([['id'], ['id', 'key'], ['id', 'key']]);
    expect(result.map(item => item.extractable)).toEqual([null, null, true]);
  });
});

test('an IndexedDB transaction abort after request success does not report persisted key creation', async () => {
  await withExtension({}, async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createDeviceKeyStore } = await import(chrome.runtime.getURL('vault-fixture.js'));
      let requestSucceeded = false;
      const database = {
        open(...args) {
          const request = indexedDB.open(...args);
          request.addEventListener('success', () => {
            const db = request.result;
            const transaction = db.transaction.bind(db);
            db.transaction = (...args) => {
              const tx = transaction(...args);
              if (args[1] === 'readwrite') {
                const objectStore = tx.objectStore.bind(tx);
                tx.objectStore = name => {
                  const store = objectStore(name);
                  const add = store.add.bind(store);
                  store.add = record => {
                    const write = add(record);
                    write.addEventListener('success', () => { requestSucceeded = true; tx.abort(); });
                    return write;
                  };
                  return store;
                };
              }
              return tx;
            };
          });
          return request;
        },
      };
      let rejected = false;
      try { await createDeviceKeyStore(database).getOrCreate('abort-fixture'); } catch { rejected = true; }
      return { requestSucceeded, rejected, missing: await createDeviceKeyStore().get('abort-fixture') === null };
    });
    expect(result).toEqual({ requestSucceeded: true, rejected: true, missing: true });
  });
});

test('popup captures its exact source conversation once without any setup', async () => {
  await withExtension({}, async ({ page, context, id }) => {
    const provider = await context.newPage();
    await provider.goto(targetUrl);
    const tab = await page.evaluate(async url => (await chrome.tabs.query({ url }))[0], targetUrl);
    const popup = await context.newPage();
    await popup.addInitScript(() => {
      if (!globalThis.chrome?.runtime?.sendMessage) return;
      window.__vaultActions = [];
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = message => {
        window.__vaultActions.push(message.action);
        return original.call(chrome.runtime, message);
      };
    });
    await popup.goto(`chrome-extension://${id}/app.html?popup=1&sourceTabId=${tab.id}`);
    await expect(popup.locator('#url')).toHaveValue(targetUrl);
    expect(await popup.evaluate(() => window.__vaultActions.filter(action => action === 'CURRENT_TAB').length)).toBe(1);
  });
});

test('asynchronous save does not reuse a previous success message', async () => {
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

test('a passphrase vault from an older version explains how to recover it', async () => {
  await withExtension({}, async ({ page }) => {
    await tickFromPage(page);
    await page.evaluate(() => chrome.alarms.clearAll());
    // Shaped like a v1 record but never readable here; the point is the wording.
    await page.evaluate(async key => {
      await chrome.storage.local.set({
        [key]: {
          version: 1,
          kdf: 'PBKDF2-SHA256',
          iterations: 600000,
          salt: btoa(String.fromCharCode(...new Uint8Array(16).fill(7))),
          cipher: 'AES-GCM-256',
          iv: btoa(String.fromCharCode(...new Uint8Array(12).fill(3))),
          data: btoa(String.fromCharCode(...new Uint8Array(32).fill(5))),
        },
      });
    }, vaultKey);
    const before = await envelope(page);
    await page.reload();
    await expect(page.locator('#vault-panel')).toBeVisible();
    await expect(page.locator('#vault-status')).toContainText('no longer supported');
    await expect(page.locator('#vault-status')).toContainText('turn off passphrase protection');
    await expect(page.locator('#scheduler-view')).toBeHidden();
    // Nothing is reset, so the previous version can still open it.
    expect(await envelope(page)).toEqual(before);
  });
});

test('overdue jobs apply both late policies exactly once without any unlock', async () => {
  test.setTimeout(60000);
  await withExtension({}, async ({ page, context }) => {
    await tickFromPage(page);
    await page.evaluate(() => chrome.alarms.clearAll());
    const original = fixtureState().jobs[0];
    const due = Date.now() - 400000;
    const jobs = ['run-once', 'skip'].map(policy => ({ ...original, id: `${policy}-job`, message: `Overdue ${policy} fixture`, missedPolicy: policy, schedule: { ...original.schedule, at: due }, nextRunAt: due }));
    await writeState(page, { version: 1, jobs, history: [] });
    const provider = await context.newPage();
    await provider.goto(targetUrl);
    await tickFromPage(page);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveText('Overdue run-once fixture');
    const stored = await readState(page);
    expect(stored.history.map(run => run.status).sort()).toEqual(['sent', 'skipped']);
    expect(stored.jobs.every(job => job.status === 'completed' && !job.enabled)).toBe(true);
    // A second tick must not deliver either job again.
    await tickFromPage(page);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(1);
    await provider.close();
  });
});
