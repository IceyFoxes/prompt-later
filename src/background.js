import { Scheduler } from './scheduler.js';
import { createVaultStore } from './vault.js';
import { createDelivery, inspectTarget } from './transport.js';
import { isUiSender, UI_MESSAGE } from './protocol.js';
import { parseTarget } from './targets.js';
import { EDITOR_MESSAGE, editorJobFor, insertTiptapText } from './page-editor.js';
import { VaultLockedError } from './vault-crypto.js';

const api = globalThis.chrome;
const store = api ? createVaultStore(api) : null;
const deliver = api ? createDelivery(api) : null;
export const scheduler = api
  ? new Scheduler({
      store,
      deliver,
      arm: epoch => epoch === null
        ? api.alarms.clear('prompt-later:due')
        : api.alarms.create('prompt-later:due', { when: epoch }),
    })
  : null;

async function accessLevel() {
  if (api?.storage?.local?.setAccessLevel) await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (api?.storage?.session?.setAccessLevel) await api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

async function permissionGranted(target) {
  return api.permissions.contains({ origins: [`${target.origin}/*`] });
}

function reply(sendResponse, data) {
  sendResponse({ ok: true, data });
}

function fail(sendResponse, error) {
  sendResponse({ ok: false, error: error?.message || 'Request failed.', ...(error?.code === 'VAULT_LOCKED' ? { code: error.code } : {}) });
}

function reportError() {
  console.error('Prompt Later background error.');
  Promise.resolve(api?.action?.setBadgeText?.({ text: '!' })).catch(() => {});
}

export const ready = scheduler ? accessLevel() : Promise.resolve();
let initialization;
async function activeScheduler() {
  await ready;
  if ((await store.status()).locked) {
    scheduler.state = null;
    scheduler.initialized = false;
    throw new VaultLockedError();
  }
  if (!scheduler.initialized) {
    initialization ||= scheduler.initialize().finally(() => { initialization = null; });
    await initialization;
  }
  return scheduler;
}

if (api) {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === EDITOR_MESSAGE) {
      (async () => {
        await activeScheduler();
        const job = editorJobFor(message, sender, await scheduler.getState(), api.runtime.id);
        if (!job || !(await permissionGranted(parseTarget(job.url)))) throw new Error('This editor request is not authorized for an active delivery.');
        const result = await api.scripting.executeScript({
          target: { tabId: sender.tab.id, frameIds: [0] },
          world: 'MAIN',
          func: insertTiptapText,
          args: [{ url: job.url, message: job.message, marker: message.marker }],
        });
        if (result.length !== 1 || result[0].result !== true) throw new Error('The page editor did not acknowledge insertion; nothing was submitted.');
        reply(sendResponse, true);
      })().catch(error => fail(sendResponse, error));
      return true;
    }
    if (message?.type !== UI_MESSAGE || !isUiSender(sender, api.runtime.id)) return false;
    (async () => {
      await ready;
      const payload = message.payload || {};
      if (message.action === 'GET_VAULT_STATUS') return reply(sendResponse, await store.status());
      if (message.action === 'SETUP_VAULT' || message.action === 'UNLOCK_VAULT') {
        if (message.action === 'SETUP_VAULT') await store.setup(payload.passphrase);
        else await store.unlock(payload.passphrase);
        await activeScheduler();
        reply(sendResponse, await store.status());
        runTick();
        return;
      }
      await activeScheduler();
      if (message.action === 'GET_STATE') {
        return reply(sendResponse, await scheduler.getState());
      }
      if (message.action === 'CURRENT_TAB') {
        let tab;
        if (Number.isInteger(payload.sourceTabId)) {
          try {
            tab = await api.tabs.get(payload.sourceTabId);
          } catch {
            tab = null;
          }
        }
        if (!tab) {
          const tabs = await api.tabs.query({ active: true, currentWindow: true });
          tab = tabs[0];
        }
        return reply(sendResponse, { id: tab?.id ?? null, url: tab?.url || '' });
      }
      if (message.action === 'CHECK_TARGET') {
        const target = parseTarget(payload.url);
        if (!(await permissionGranted(target))) throw new Error('Allow access to this provider before checking the page.');
        return reply(sendResponse, await inspectTarget(api, target.url));
      }
      if (message.action === 'UPSERT_JOB') {
        const target = parseTarget(payload.url);
        if (!(await permissionGranted(target))) throw new Error('Allow access to this provider before saving.');
        return reply(sendResponse, await scheduler.upsertJob(payload));
      }
      if (message.action === 'SET_ENABLED') {
        return reply(sendResponse, await scheduler.setEnabled(payload.id, payload.enabled));
      }
      if (message.action === 'DELETE_JOB') {
        return reply(sendResponse, await scheduler.deleteJob(payload.id));
      }
      throw new Error('Unknown request.');
    })().catch(error => fail(sendResponse, error));
    return true;
  });

  const runTick = () => ready.then(async () => {
    const vaultStatus = await store.status();
    if (vaultStatus.locked) {
      await api.alarms.clear('prompt-later:due');
      await api.action.setBadgeText({ text: 'LOCK' });
      scheduler.state = null;
      scheduler.initialized = false;
      return;
    }
    await activeScheduler();
    await scheduler.tick();
    await api.action.setBadgeText({ text: '' });
  }).catch(error => {
    if (error?.code === 'VAULT_LOCKED') return;
    reportError(error);
  });
  ready.then(runTick).catch(reportError);
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'prompt-later:due') runTick();
  });
  api.runtime.onStartup.addListener(runTick);
  api.runtime.onInstalled.addListener(runTick);
}
