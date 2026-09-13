import { Scheduler } from './scheduler.js';
import { createChromeStore } from './store.js';
import { createDelivery, inspectTarget } from './transport.js';
import { isUiSender, UI_MESSAGE } from './protocol.js';
import { parseTarget } from './targets.js';

const api = globalThis.chrome;
const store = api ? createChromeStore(api) : null;
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
  if (api?.storage?.local?.setAccessLevel) {
    await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
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

export const ready = scheduler
  ? (async () => {
      await accessLevel();
      await scheduler.initialize();
    })()
  : Promise.resolve();

if (api) {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== UI_MESSAGE || !isUiSender(sender, api.runtime.id)) return false;
    (async () => {
      await ready;
      const payload = message.payload || {};
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

  const runTick = () => ready.then(() => scheduler.tick()).catch(reportError);
  ready.then(runTick).catch(reportError);
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'prompt-later:due') runTick();
  });
  api.runtime.onStartup.addListener(runTick);
  api.runtime.onInstalled.addListener(runTick);
}
