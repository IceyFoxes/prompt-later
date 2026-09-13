import { parseTarget, sameTarget } from './targets.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function hasPermission(chromeApi, origin) {
  if (!chromeApi.permissions?.contains) return false;
  return chromeApi.permissions.contains({ origins: [`${origin}/*`] });
}

async function waitForTab(chromeApi, tabId, url, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chromeApi.tabs.get(tabId);
    if (tab?.status === 'complete' && sameTarget(tab.url, url)) return tab;
    if (tab?.url && tab.status === 'complete' && !sameTarget(tab.url, url)) {
      throw new Error('The target tab opened a different conversation.');
    }
    await delay(250);
  }
  throw new Error('The target conversation did not finish loading in time.');
}

async function findTab(chromeApi, target) {
  const tabs = await chromeApi.tabs.query({ url: `${target.origin}/*` });
  const matches = tabs.filter(tab => sameTarget(tab.url, target.url));
  return matches.sort((left, right) => Number(right.active) - Number(left.active))[0] || null;
}

async function callPage(chromeApi, tabId, message, timeout = 20000) {
  let timer;
  try {
    return await Promise.race([
      chromeApi.tabs.sendMessage(tabId, message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The page did not respond in time.')), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pageForTarget(chromeApi, target) {
  let tab = await findTab(chromeApi, target);
  if (!tab) tab = await chromeApi.tabs.create({ url: target.url, active: false });
  await waitForTab(chromeApi, tab.id, target.url);
  await chromeApi.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    files: ['content.js'],
    world: 'ISOLATED',
  });
  return tab;
}

export function createDelivery(chromeApi) {
  return async function deliver(job, run, markDispatching) {
    const target = parseTarget(job.url);
    if (!(await hasPermission(chromeApi, target.origin))) {
      return { outcome: 'blocked', detail: 'Allow access to this provider before sending.' };
    }
    const tab = await pageForTarget(chromeApi, target);
    const prepared = await callPage(chromeApi, tab.id, {
      type: 'PL_PREPARE',
      runId: run.id,
      url: target.url,
      message: job.message,
    });
    if (!prepared?.ready) {
      return { outcome: 'blocked', detail: prepared?.detail || 'The page is not ready to receive this message.' };
    }
    await markDispatching();
    try {
      const committed = await callPage(chromeApi, tab.id, {
        type: 'PL_COMMIT',
        runId: run.id,
        url: target.url,
        message: job.message,
      });
      if (committed?.outcome === 'sent') {
        return { outcome: 'sent', detail: committed.detail || 'The site acknowledged submission.' };
      }
      return {
        outcome: committed?.outcome === 'blocked' ? 'blocked' : 'uncertain',
        detail: committed?.detail || 'Submission was not acknowledged.',
      };
    } catch (error) {
      return { outcome: 'uncertain', detail: error.message || 'The page response was lost after dispatch.' };
    }
  };
}

export async function inspectTarget(chromeApi, url) {
  const target = parseTarget(url);
  if (!(await hasPermission(chromeApi, target.origin))) {
    return { status: 'blocked', detail: 'Allow access to this provider to check the page.' };
  }
  const tab = await pageForTarget(chromeApi, target);
  return callPage(chromeApi, tab.id, { type: 'PL_INSPECT', url: target.url });
}
