import { Scheduler } from './scheduler.js';
import { createVaultStore } from './vault.js';
import { attentionCount } from './store.js';
import { createDelivery, inspectTarget } from './transport.js';
import { isUiSender, UI_MESSAGE } from './protocol.js';
import { parseTarget } from './targets.js';

const api = globalThis.chrome;
const DUE_ALARM = 'prompt-later:due';
const RECOVERY_ALARM = 'prompt-later:recovery';
const store = api ? createVaultStore(api) : null;
const deliver = api ? createDelivery(api) : null;
export const scheduler = api
  ? new Scheduler({
      store,
      deliver,
      arm: epoch => epoch === null
        ? api.alarms.clear(DUE_ALARM)
        : api.alarms.create(DUE_ALARM, { when: epoch }),
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

async function refreshBadge(state) {
  state ||= await scheduler.getState();
  const count = attentionCount(state);
  await api.action.setBadgeBackgroundColor({ color: '#b42318' });
  await api.action.setBadgeText({ text: count ? count > 9 ? '9+' : String(count) : '' });
}

async function mutateAndReply(sendResponse, mutation) {
  const result = await mutation();
  try {
    await refreshBadge();
  } catch (error) {
    reportError(error);
  }
  return reply(sendResponse, result);
}

const storageReady = scheduler ? accessLevel() : Promise.resolve();
export const ready = scheduler ? storageReady.then(() => store.initialize()) : Promise.resolve();
let initialization;

const RECOVERY_DELAY = 60 * 1000;

async function suspendScheduler(allowRecovery) {
  scheduler.state = null;
  scheduler.initialized = false;
  await api.alarms.clear(DUE_ALARM);
  if (allowRecovery) {
    // One separate recovery alarm gives a transient failure another chance
    // without turning a permanently unreadable vault into a minute-by-minute loop.
    await api.alarms.create(RECOVERY_ALARM, { when: Date.now() + RECOVERY_DELAY });
  }
  await api.action.setBadgeText({ text: '!' });
}

async function vaultStatus() {
  await storageReady;
  return store.status();
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
        return mutateAndReply(sendResponse, () => scheduler.upsertJob(payload));
      }
      if (message.action === 'SET_ENABLED') {
        return mutateAndReply(sendResponse, () => scheduler.setEnabled(payload.id, payload.enabled));
      }
      if (message.action === 'DELETE_JOB') {
        return mutateAndReply(sendResponse, () => scheduler.deleteJob(payload.id));
      }
      if (message.action === 'CLEAR_ACTIVITY') {
        return mutateAndReply(sendResponse, () => scheduler.clearActivity());
      }
      if (message.action === 'DELETE_ACTIVITY') {
        return mutateAndReply(sendResponse, () => scheduler.deleteActivity(payload.id));
      }
      if (message.action === 'UPDATE_SETTINGS') {
        return mutateAndReply(sendResponse, () => scheduler.updateSettings(payload));
      }
      throw new Error('Unknown request.');
    })().catch(error => fail(sendResponse, error));
    return true;
  });

  const tickError = async allowRecovery => {
    await suspendScheduler(allowRecovery).catch(reportError);
    reportError();
  };
  const runTick = (allowRecovery = true) => storageReady.then(async () => {
    await activeScheduler();
    await scheduler.tick();
    await api.alarms.clear(RECOVERY_ALARM);
    await refreshBadge().catch(reportError);
  }).catch(() => tickError(allowRecovery));
  ready.then(() => runTick(true)).catch(() => tickError(true));
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === DUE_ALARM) runTick(true);
    if (alarm.name === RECOVERY_ALARM) runTick(false);
  });
  api.runtime.onStartup.addListener(() => runTick(true));
  api.runtime.onInstalled.addListener(() => runTick(true));
}
