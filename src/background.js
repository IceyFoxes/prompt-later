import { Scheduler } from './scheduler.js';
import { createVaultStore } from './vault.js';
import { createDelivery, inspectTarget } from './transport.js';
import { isUiSender, UI_MESSAGE } from './protocol.js';
import { parseTarget } from './targets.js';
import { EDITOR_MESSAGE, editorJobFor, insertTiptapText } from './page-editor.js';

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
  sendResponse({ ok: false, error: error?.message || 'Request failed.' });
}

function reportError() {
  console.error('Prompt Later background error.');
  Promise.resolve(api?.action?.setBadgeText?.({ text: '!' })).catch(() => {});
}

const storageReady = scheduler ? accessLevel() : Promise.resolve();
export const ready = scheduler ? storageReady.then(() => store.initialize()) : Promise.resolve();
let initialization;

async function suspendScheduler() {
  scheduler.state = null;
  scheduler.initialized = false;
  await api.alarms.clear('prompt-later:due');
  await api.action.setBadgeText({ text: '!' });
}

async function vaultStatus() {
  await storageReady;
  try {
    return await store.status();
  } catch (error) {
    await suspendScheduler();
    throw error;
  }
}

async function activeScheduler() {
  await vaultStatus();
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
      await storageReady;
      const payload = message.payload || {};
      if (message.action === 'GET_VAULT_STATUS') return reply(sendResponse, await vaultStatus());
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
        return reply(sendResponse, await inspectTarget(api, target.url, { openIfMissing: payload.openIfMissing !== false }));
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
      if (message.action === 'UPDATE_SETTINGS') {
        return reply(sendResponse, await scheduler.updateSettings(payload));
      }
      throw new Error('Unknown request.');
    })().catch(error => fail(sendResponse, error));
    return true;
  });

  const tickError = async () => {
    await suspendScheduler().catch(reportError);
    reportError();
  };
  const runTick = () => storageReady.then(async () => {
    await activeScheduler();
    await scheduler.tick();
    await api.action.setBadgeText({ text: '' });
  }).catch(tickError);
  ready.then(runTick).catch(tickError);
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'prompt-later:due') runTick();
  });
  api.runtime.onStartup.addListener(runTick);
  api.runtime.onInstalled.addListener(runTick);
}
