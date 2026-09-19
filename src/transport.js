import { parseTarget, sameTarget } from './targets.js';
import { REASONS, withReason } from './outcomes.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Keep the wire shape compact when a page did not provide a machine-readable
// reason; user-facing detail is still returned.
const result = (outcome, detail, reason) => (reason === undefined ? { outcome, detail } : { outcome, detail, reason });

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
      throw withReason('The target tab opened a different conversation.', REASONS.TARGET_MISMATCH);
    }
    await delay(250);
  }
  throw withReason('The target conversation did not finish loading in time.', REASONS.TAB_LOAD_TIMEOUT);
}

async function findTab(chromeApi, target) {
  const tabs = await chromeApi.tabs.query({ url: `${target.origin}/*` });
  const matches = tabs.filter(tab => sameTarget(tab.url, target.url));
  return matches.sort((left, right) => Number(right.active) - Number(left.active))[0] || null;
}

async function callPage(chromeApi, tabId, message, timeout = 20000) {
  if (timeout === null) return chromeApi.tabs.sendMessage(tabId, message);
  let timer;
  try {
    return await Promise.race([
      chromeApi.tabs.sendMessage(tabId, message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(withReason('The page did not respond in time.', REASONS.PAGE_UNRESPONSIVE)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pageForTarget(chromeApi, target, { openIfMissing = true } = {}) {
  let tab = await findTab(chromeApi, target);
  const waitForComposer = !tab || tab.status !== 'complete';
  // Checking a page must never be the reason a tab appears.
  if (!tab && !openIfMissing) return null;
  if (!tab) tab = await chromeApi.tabs.create({ url: target.url, active: false });
  await waitForTab(chromeApi, tab.id, target.url);
  await chromeApi.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    files: ['content.js'],
    world: 'ISOLATED',
  });
  return { tab, waitForComposer };
}

export function createDelivery(chromeApi) {
  return async function deliver(job, run, markDispatching, draftPolicy = 'skip') {
    const target = parseTarget(job.url);
    if (!(await hasPermission(chromeApi, target.origin))) {
      return { outcome: 'blocked', detail: 'Allow access to this provider before sending.', reason: REASONS.PERMISSION_MISSING };
    }
    const { tab, waitForComposer } = await pageForTarget(chromeApi, target);
    const prepared = await callPage(chromeApi, tab.id, {
      type: 'PL_PREPARE',
      waitForComposer,
      runId: run.id,
      url: target.url,
      message: job.message,
      draftPolicy,
    });
    if (!prepared?.ready) {
      return result('blocked', prepared?.detail || 'The page is not ready to receive this message.', prepared?.reason);
    }
    if (!(await hasPermission(chromeApi, target.origin))) {
      return { outcome: 'blocked', detail: 'Site access was removed before sending.', reason: REASONS.PERMISSION_MISSING };
    }
    await markDispatching();
    try {
      const committed = await callPage(chromeApi, tab.id, {
        type: 'PL_COMMIT',
        runId: run.id,
        url: target.url,
        message: job.message,
        draftPolicy,
      }, prepared?.draft === true && draftPolicy === 'send-both' ? null : 20000);
      if (committed?.outcome === 'sent') {
        return { outcome: 'sent', detail: committed.detail || 'The site acknowledged submission.' };
      }
      return result(
        committed?.outcome === 'blocked' ? 'blocked' : 'uncertain',
        committed?.detail || 'Submission was not acknowledged.',
        committed?.reason,
      );
    } catch (error) {
      return result('uncertain', error.message || 'The page response was lost after dispatch.', error.reason);
    }
  };
}

export async function inspectTarget(chromeApi, url, options = {}) {
  const target = parseTarget(url);
  if (!(await hasPermission(chromeApi, target.origin))) {
    return { status: 'blocked', detail: 'Allow access to this provider to check the page.' };
  }
  const page = await pageForTarget(chromeApi, target, options);
  if (!page) return { status: 'unopened', detail: 'The conversation is not open in a tab.' };
  return callPage(chromeApi, page.tab.id, { type: 'PL_INSPECT', url: target.url, waitForComposer: page.waitForComposer });
}
