import { expect, test } from '@playwright/test';
import { closeExtension, dueState, openExtension, readState, tickFromPage } from './helpers.js';

async function withExtension(options, callback) {
  const environment = await openExtension(options);
  try {
    return await callback(environment);
  } finally {
    await closeExtension(environment);
  }
}

async function saveJob(page, url, message = 'Reliability prompt') {
  await page.locator('#url').fill(url);
  await page.locator('#when').selectOption('1m');
  await page.locator('#message').fill(message);
  await page.locator('#save').click();
  await expect(page.locator('#form-status')).toContainText('Message scheduled.');
}

test('R1 permission gate is shown before the scheduler and denial creates no job', async () => {
  await withExtension({}, async ({ page }) => {
    await page.evaluate(() => {
      const entries = [];
      const sendMessage = chrome.runtime.sendMessage;
      chrome.permissions.contains = async () => false;
      chrome.permissions.request = async details => {
        entries.push({ type: 'permission', details, active: navigator.userActivation.isActive });
        return false;
      };
      chrome.runtime.sendMessage = async message => {
        if (!['GET_STATE', 'GET_VAULT_STATUS'].includes(message.action)) entries.push({ type: 'rpc', action: message.action });
        return sendMessage.call(chrome.runtime, message);
      };
      window.__permissionEntries = entries;
    });
    await page.locator('#url').fill('https://chatgpt.com/c/permission');
    await page.locator('#url').press('Tab');
    await expect(page.locator('#permission-title')).toHaveText('Allow ChatGPT access');
    await expect(page.locator('#scheduler-view')).toBeHidden();
    expect(await page.evaluate(() => window.__permissionEntries)).toEqual([]);
    await page.locator('#permission-allow').click();
    await expect(page.locator('#permission-status')).toHaveText('Access was not granted. Nothing was scheduled or sent.');
    const entries = await page.evaluate(() => window.__permissionEntries);
    expect(entries[0]).toEqual({ type: 'permission', details: { origins: ['https://chatgpt.com/*'] }, active: true });
    expect(entries.some(entry => entry.action === 'UPSERT_JOB')).toBe(false);
    expect((await readState(page)).jobs).toHaveLength(0);
  });
});

test('R1 already granted permission saves while a new provider gates before Check page', async () => {
  await withExtension({}, async ({ page, context }) => {
    await saveJob(page, 'https://chatgpt.com/c/granted');
    const providerTabsBefore = context.pages().filter(candidate => candidate.url().startsWith('https://')).length;
    await page.evaluate(() => {
      const actions = [];
      const sendMessage = chrome.runtime.sendMessage;
      chrome.permissions.contains = async () => false;
      chrome.runtime.sendMessage = async message => {
        if (!['GET_STATE', 'GET_VAULT_STATUS'].includes(message.action)) actions.push(message.action);
        return sendMessage.call(chrome.runtime, message);
      };
      window.__permissionActions = actions;
    });
    await page.locator('#url').fill('https://claude.ai/chat/denied-check');
    await page.locator('#url').press('Tab');
    await expect(page.locator('#permission-title')).toHaveText('Allow Claude access');
    expect(await page.evaluate(() => window.__permissionActions)).not.toContain('CHECK_TARGET');
    expect(context.pages().filter(candidate => candidate.url().startsWith('https://')).length).toBe(providerTabsBefore);
  });
});

test('R2 editing, delay defaults, recurrence anchors, deletion, and tab switching are consistent', async () => {
  await withExtension({}, async ({ page }) => {
    const captured = Date.now();
    await page.locator('#url').fill('https://chatgpt.com/c/default');
    await page.locator('#message').fill('Default delay');
    await page.locator('#save').click();
    await expect(page.locator('#save')).toBeEnabled();
    const first = await readState(page);
    expect(first.jobs[0].schedule.at).toBeGreaterThanOrEqual(captured + 17995000);
    expect(first.jobs[0].schedule.at).toBeLessThanOrEqual(captured + 18005000);
    await page.reload();
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#custom-time-field')).toBeVisible();
    await expect(page.locator('#once-zone')).toContainText('Times use');
    await page.locator('#message').fill('Updated');
    await page.locator('#save').click();
    await expect(page.locator('#save')).toBeEnabled();
    const updated = await readState(page);
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0].message).toBe('Updated');
    await page.locator('[data-tab="recurring"]').click();
    await page.locator('#recurrence').selectOption('interval');
    await page.locator('#url').fill('https://chatgpt.com/c/interval');
    await page.locator('#message').fill('Every five hours');
    await expect(page.locator('#next-preview')).toContainText('Next occurrence');
    await page.locator('#save').click();
    await expect(page.locator('#save')).toBeEnabled();
    const withInterval = await readState(page);
    const interval = withInterval.jobs.find(job => job.url.endsWith('/interval'));
    expect(interval.nextRunAt).toBeGreaterThan(Date.now() + 17995000);
    expect(interval.nextRunAt).toBeLessThan(Date.now() + 18005000);
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#interval-hours')).toHaveValue('5');
    await page.locator('#message').fill('Every five hours edited');
    await page.locator('#save').click();
    await expect(page.locator('#save')).toBeEnabled();
    const afterEdit = await readState(page);
    expect(afterEdit.jobs.find(job => job.url.endsWith('/interval')).schedule.anchor).toBe(interval.schedule.anchor);
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.locator('[data-tab="send"]').click();
    await expect(page.locator('#save')).toHaveText('Save scheduled message');
    await saveJob(page, 'https://chatgpt.com/c/new-job', 'New job');
    const state = await readState(page);
    expect(state.jobs).toHaveLength(3);
    await page.locator('[data-tab="recurring"]').click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.locator('#confirmation-accept').click();
    await expect(page.locator('#job-list')).not.toContainText('Every five hours edited');
  });
});

test('R3 sends to the exact chosen conversation while another same-provider tab remains untouched', async () => {
  await withExtension({}, async ({ page, context }) => {
    const other = await context.newPage();
    await other.goto('https://chatgpt.com/c/other');
    const target = await context.newPage();
    await target.goto('https://chatgpt.com/c/target');
    await other.bringToFront();
    await saveJob(page, 'https://chatgpt.com/c/target');
    await dueState(page);
    await tickFromPage(page);
    await expect(target.locator('[data-message-author-role="user"]')).toHaveText('Reliability prompt');
    await expect(other.locator('[data-message-author-role="user"]')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(async () => (await chrome.tabs.query({ url: 'https://chatgpt.com/*' })).find(tab => tab.url === 'https://chatgpt.com/c/target')?.active)).toBe(false);
    await other.close();
    await target.close();
  });
});

test('R4 duplicate concurrent and post-reinjection commits produce one click and one outgoing node', async () => {
  await withExtension({}, async ({ page, context }) => {
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/duplicate');
    const result = await page.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'], world: 'ISOLATED' });
      const message = { type: 'PL_PREPARE', runId: 'duplicate-run', url: 'https://chatgpt.com/c/duplicate', message: 'Duplicate once' };
      const prepared = await chrome.tabs.sendMessage(tab.id, message);
      const commit = { type: 'PL_COMMIT', runId: 'duplicate-run', url: message.url, message: message.message };
      const outcomes = await Promise.all([chrome.tabs.sendMessage(tab.id, commit), chrome.tabs.sendMessage(tab.id, commit)]);
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'], world: 'ISOLATED' });
      const repeat = await chrome.tabs.sendMessage(tab.id, commit);
      return { prepared, outcomes, repeat };
    });
    expect(result.prepared.ready).toBe(true);
    expect(result.outcomes[0]).toEqual(result.outcomes[1]);
    expect(result.outcomes[0].outcome).toBe('sent');
    expect(result.repeat).toEqual(result.outcomes[0]);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(1);
    await provider.close();
  });
});

test('R5 missing, ambiguous, modal, read-only, and missing-send fixtures fail closed', async () => {
  test.setTimeout(120000);
  const cases = [
    { fixture: { missingEditor: true }, detail: 'Composer was not found' },
    { fixture: { editors: 2 }, detail: 'Composer controls are ambiguous', permanent: true },
    { fixture: { readOnly: true }, detail: 'Composer was not found' },
    { fixture: { missingEditor: true, modalEditor: true }, detail: 'Composer was not found' },
    { fixture: { sends: 2 }, detail: 'Send controls are ambiguous', permanent: true },
    { fixture: { missingSend: true }, detail: 'explicit send control was not found' },
  ];
  for (const [index, item] of cases.entries()) {
    await withExtension(item, async ({ page, context }) => {
      const target = `https://chatgpt.com/c/fail-${index}`;
      await saveJob(page, target, `Fail closed ${index}`);
      const provider = await context.newPage();
      await provider.goto(target);
      await dueState(page);
      await tickFromPage(page);
      await expect(page.locator('#job-list')).toContainText('Needs attention');
      await expect(page.locator('#job-list .meta')).toContainText(item.detail);
      await expect(provider.locator('#messages')).toBeEmpty();
      await provider.close();
    });
  }
});

test('R6 URL and attachment races block without clicking and retain the draft', async () => {
  await withExtension({ fixture: { urlChangeOnInput: true } }, async ({ page, context }) => {
    await saveJob(page, 'https://chatgpt.com/c/race', 'Race prompt');
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/race');
    await dueState(page);
    await tickFromPage(page);
    await expect(page.locator('#job-list')).toContainText('Needs attention');
    await expect(provider.locator('#messages')).toBeEmpty();
    await expect(provider.locator('#prompt-textarea')).toHaveValue('Race prompt');
    await provider.close();
  });
  await withExtension({ fixture: { pendingAttachmentOnInput: true } }, async ({ page, context }) => {
    await saveJob(page, 'https://chatgpt.com/c/attachment', 'Attachment prompt');
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/attachment');
    await dueState(page);
    await tickFromPage(page);
    await expect(page.locator('#job-list')).toContainText('Needs attention');
    await expect(provider.locator('#messages')).toBeEmpty();
    await expect(provider.locator('#prompt-textarea')).toHaveValue('Attachment prompt');
    await provider.close();
  });
});

test('R7 alert after click is uncertain and the next tick does not retry', async () => {
  test.setTimeout(45000);
  await withExtension({ fixture: { postClickAlert: true } }, async ({ page, context }) => {
    await saveJob(page, 'https://chatgpt.com/c/alert', 'Alert prompt');
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/alert');
    await dueState(page);
    await tickFromPage(page);
    await expect(page.locator('#job-list')).toContainText('Needs attention');
    const before = await provider.locator('#messages [data-message-author-role="user"]').count();
    const state = await readState(page);
    expect(state.history.at(-1).status).toBe('uncertain');
    expect(before).toBe(1);
    await tickFromPage(page);
    expect(await provider.locator('#messages [data-message-author-role="user"]').count()).toBe(1);
    await provider.close();
  });
});

test('R8 protects existing textarea and contenteditable drafts', async () => {
  for (const item of [
    { target: 'https://chatgpt.com/c/draft-textarea', selector: '#prompt-textarea', kind: 'textarea' },
    { target: 'https://claude.ai/chat/draft-contenteditable', selector: '[contenteditable="true"]', kind: 'contenteditable' },
  ]) {
    await withExtension({}, async ({ page, context }) => {
      await saveJob(page, item.target, 'Do not overwrite');
      const provider = await context.newPage();
      await provider.goto(item.target);
      await provider.locator(item.selector).fill('Existing user draft');
      await dueState(page);
      await tickFromPage(page);
      await expect(page.locator('#job-list')).toContainText('Needs attention');
      if (item.kind === 'textarea') await expect(provider.locator(item.selector)).toHaveValue('Existing user draft');
      else await expect(provider.locator(item.selector)).toHaveText('Existing user draft');
      await provider.close();
    });
  }
});

test('R9 nested Claude user selectors do not fake acknowledgement and enabled send succeeds separately', async () => {
  await withExtension({ fixture: { noAck: true } }, async ({ page, context }) => {
    await saveJob(page, 'https://claude.ai/chat/no-ack', 'No acknowledgement');
    const provider = await context.newPage();
    await provider.goto('https://claude.ai/chat/no-ack');
    await provider.evaluate(() => {
      const outer = document.createElement('div');
      outer.dataset.testid = 'user-message';
      const inner = document.createElement('span');
      inner.dataset.testid = 'user-message-content';
      inner.textContent = 'No acknowledgement';
      outer.append(inner);
      document.querySelector('#messages').append(outer);
    });
    await dueState(page);
    await tickFromPage(page);
    await expect(page.locator('#job-list')).toContainText('Needs attention');
    expect(await provider.locator('[data-testid="user-message"]').count()).toBe(1);
    await provider.close();
  });
  await withExtension({}, async ({ page, context }) => {
    await saveJob(page, 'https://claude.ai/chat/enabled-send', 'Enabled after input');
    const provider = await context.newPage();
    await provider.goto('https://claude.ai/chat/enabled-send');
    await dueState(page);
    await tickFromPage(page);
    await expect(provider.locator('[data-testid="user-message"]')).toHaveText('Enabled after input');
    await provider.close();
  });
});

test('R10 text, activity, Devin badge, source-tab dashboard, timezone, and popup layout are correct', async () => {
  await withExtension({}, async ({ page, context, id }) => {
    await saveJob(page, 'https://chatgpt.com/c/html', '<b>not executable</b>');
    await expect(page.locator('.card .message')).toContainText('<b>not executable</b>');
    expect(await page.locator('.card .message b').count()).toBe(0);
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/html');
    await dueState(page);
    await tickFromPage(page);
    await page.locator('[data-tab="activity"]').click();
    await expect(page.locator('#activity-list')).toContainText('Sent');
    await expect(page.locator('#activity-list')).toContainText('https://chatgpt.com/c/html');
    await expect(page.locator('#activity-list')).toContainText('<b>not executable</b>');
    await provider.close();
    await page.locator('[data-tab="send"]').click();
    await page.locator('#url').fill('https://app.devin.ai/sessions/badge');
    await expect(page.locator('#provider-chip')).toContainText('Experimental');
    const source = await context.newPage();
    await source.goto('https://chatgpt.com/c/source');
    const sourceTab = await page.evaluate(async () => (await chrome.tabs.query({ url: 'https://chatgpt.com/*' })).find(tab => tab.url === 'https://chatgpt.com/c/source'));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/app.html?popup=1&sourceTabId=${sourceTab.id}`);
    await expect(popup.locator('#url')).toHaveValue('https://chatgpt.com/c/source');
    await expect.poll(() => popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const capturedZone = await popup.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    await popup.clock.install();
    await popup.clock.fastForward(31000);
    await popup.locator('#popup-queue-toggle').click();
    await expect(popup.locator('#job-list .meta')).toContainText(capturedZone);
    const popupBox = await popup.locator('body').boundingBox();
    const saveBottom = await popup.locator('#save').evaluate(element => element.getBoundingClientRect().bottom);
    expect(popupBox.width).toBe(320);
    expect(saveBottom).toBeLessThanOrEqual(600);
    const dashboardPromise = context.waitForEvent('page');
    await popup.locator('#dashboard-link').click();
    const dashboard = await dashboardPromise;
    await expect(dashboard.locator('#url')).toHaveValue('https://chatgpt.com/c/source');
    expect(new URL(dashboard.url()).searchParams.get('sourceTabId')).toBe(String(sourceTab.id));
    await dashboard.close();
    await popup.close();
    await source.close();
  });
});

test('attention badge counts distinct affected jobs and clears as activity resolves', async () => {
  await withExtension({}, async ({ page }) => {
    await saveJob(page, 'https://chatgpt.com/c/attention-one', 'Attention one');
    await saveJob(page, 'https://chatgpt.com/c/attention-two', 'Attention two');
    let state = await readState(page);
    const first = state.jobs[0];
    const second = state.jobs[1];
    state.jobs = [{ ...first, status: 'needs-attention', enabled: false, nextRunAt: null, runId: null, lastOutcome: 'blocked', lastDetail: 'Needs review.' }, second];
    state.history = [];
    await page.evaluate(async value => {
      const module = await import(chrome.runtime.getURL('vault-fixture.js'));
      await module.writeState(value);
    }, state);
    const updateSettings = () => page.evaluate(async () => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'UPDATE_SETTINGS', payload: { draftPolicy: 'skip' } }));
    await updateSettings();
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');

    state = await readState(page);
    state.history = [
      { id: 'attention-run-a', jobId: second.id, url: second.url, provider: second.provider, preview: second.message, dueAt: 1, startedAt: 1, finishedAt: 2, status: 'uncertain', detail: 'Uncertain.' },
      { id: 'attention-run-b', jobId: second.id, url: second.url, provider: second.provider, preview: second.message, dueAt: 3, startedAt: 3, finishedAt: 4, status: 'uncertain', detail: 'Uncertain again.' },
    ];
    await page.evaluate(async value => {
      const module = await import(chrome.runtime.getURL('vault-fixture.js'));
      await module.writeState(value);
    }, state);
    await updateSettings();
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('2');

    const firstRun = state.history[0];
    const secondRun = state.history[1];
    await page.evaluate(async id => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'SET_ENABLED', payload: { id, enabled: true } }), first.id);
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
    await page.evaluate(async id => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'DELETE_ACTIVITY', payload: { id } }), firstRun.id);
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
    await page.evaluate(async id => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'DELETE_ACTIVITY', payload: { id } }), secondRun.id);
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('');

    state = await readState(page);
    state.history = Array.from({ length: 10 }, (_, index) => ({
      id: `orphan-uncertain-${index}`,
      jobId: `orphan-job-${index}`,
      url: second.url,
      provider: second.provider,
      preview: 'Orphan uncertain activity',
      dueAt: index + 1,
      startedAt: index + 2,
      finishedAt: index + 3,
      status: 'uncertain',
      detail: 'Orphan uncertain detail',
    }));
    await page.evaluate(async value => {
      const module = await import(chrome.runtime.getURL('vault-fixture.js'));
      await module.writeState(value);
    }, state);
    await updateSettings();
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('9+');
    const clearResult = await page.evaluate(async () => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'CLEAR_ACTIVITY', payload: {} }));
    expect(clearResult.ok).toBe(true);
    await expect.poll(() => page.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  });
});

test('send-both idle timeout records partial send and does not retry the first draft', async () => {
  await withExtension({ fixture: { busyAfterFirstClickMs: 20 * 60 * 1000 } }, async ({ page, context }) => {
    await page.locator('[data-tab="info"]').click();
    await page.locator('#delivery-settings').evaluate(node => { node.open = true; });
    await page.locator('#draft-policy').selectOption('send-both');
    await expect(page.locator('#delivery-status')).toContainText('Saved.');
    await page.locator('[data-tab="recurring"]').click();
    await page.locator('#recurrence').selectOption('daily');
    await page.locator('#url').fill('https://chatgpt.com/c/send-both-timeout');
    await page.locator('#message').fill('Scheduled after timeout');
    await page.locator('#save').click();
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/send-both-timeout');
    await provider.locator('#prompt-textarea').fill('First draft');
    await provider.clock.install();
    await dueState(page, job => job.url === 'https://chatgpt.com/c/send-both-timeout');
    await page.evaluate(() => chrome.alarms.create('prompt-later:due', { when: Date.now() }));
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(1);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveText('First draft');
    for (let index = 0; index <= 600; index += 1) await provider.clock.fastForward(1000);
    const jumpedAt = await provider.evaluate(() => Date.now());
    const providerTabId = await page.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, 'https://chatgpt.com/c/send-both-timeout');
    await page.evaluate(async ({ tabId, time }) => chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: value => { Date.now = () => value; },
      args: [time],
    }), { tabId: providerTabId, time: jumpedAt });
    await expect.poll(async () => (await readState(page)).history.at(-1)?.status).toBe('uncertain');
    const state = await readState(page);
    const job = state.jobs.find(item => item.url === 'https://chatgpt.com/c/send-both-timeout');
    expect(state.history.at(-1).detail).toContain('The existing draft was sent, but the scheduled message was not confirmed.');
    expect(state.history.at(-1).detail).toContain('The provider did not become idle within 10 minutes after the existing draft was sent.');
    expect(job.enabled).toBe(true);
    expect(job.status).toBe('scheduled');
    expect(job.nextRunAt).toBeGreaterThan(Date.now());
    await page.evaluate(() => chrome.alarms.create('prompt-later:due', { when: Date.now() }));
    await provider.waitForTimeout(500);
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(1);
    await provider.close();
  });
});

test('R11 real MV3 alarm delivers after extension UI closes and deletion preserves activity', async () => {
  test.setTimeout(60000);
  await withExtension({}, async ({ page, context, worker, id }) => {
    const provider = await context.newPage();
    await provider.goto('https://chatgpt.com/c/alarm');
    const message = 'Real alarm prompt';
    const at = Date.now() + 2000;
    const response = await page.evaluate(async payload => chrome.runtime.sendMessage({ type: 'PL_UI', action: 'UPSERT_JOB', payload }), {
      url: 'https://chatgpt.com/c/alarm',
      message,
      schedule: { type: 'once', at, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
      missedPolicy: 'run-once',
    });
    expect(response.ok).toBe(true);
    for (const candidate of context.pages()) {
      if (candidate.url().startsWith(`chrome-extension://${id}/`)) await candidate.close();
    }
    await expect(provider.locator('[data-message-author-role="user"]')).toHaveText(message, { timeout: 45000 });
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${id}/app.html`);
    await expect(dashboard.locator('#job-list')).toContainText(message);
    const delivered = await readState(dashboard);
    expect(delivered.jobs[0].status).toBe('completed');
    expect(delivered.jobs[0].enabled).toBe(false);
    expect(delivered.history.at(-1).status).toBe('sent');
    const completedStyle = await dashboard.locator('.job-status-completed').evaluate(node => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      probe.style.color = root.getPropertyValue('--success');
      probe.style.backgroundColor = root.getPropertyValue('--success-soft');
      document.body.append(probe);
      const expected = getComputedStyle(probe);
      const actual = getComputedStyle(node);
      const result = { text: node.textContent, color: actual.color, background: actual.backgroundColor, expectedColor: expected.color, expectedBackground: expected.backgroundColor };
      probe.remove();
      return result;
    });
    expect(completedStyle.text).toBe('Submitted');
    expect(completedStyle.color).toBe(completedStyle.expectedColor);
    expect(completedStyle.background).toBe(completedStyle.expectedBackground);
    await dashboard.getByRole('button', { name: 'Delete' }).click();
    await expect(dashboard.locator('#confirmation-dialog')).toBeVisible();
    await dashboard.locator('#confirmation-accept').click();
    await dashboard.reload();
    await expect(dashboard.locator('#job-list')).not.toContainText(message);
    await dashboard.locator('[data-tab="activity"]').click();
    await expect(dashboard.locator('#activity-list')).toContainText('Sent');
    await expect(dashboard.locator('#clear-activity')).toBeVisible();
    await dashboard.locator('#clear-activity').click();
    await expect(dashboard.locator('#confirmation-dialog')).toBeVisible();
    await dashboard.locator('#confirmation-accept').click();
    await expect(dashboard.locator('#activity-status')).toContainText('Activity cleared.');
    await expect(dashboard.locator('#activity-list')).toContainText('No activity yet.');
    await expect(dashboard.locator('#clear-activity')).toBeHidden();
    await dashboard.reload();
    await dashboard.locator('[data-tab="activity"]').click();
    await expect(dashboard.locator('#activity-list')).toContainText('No activity yet.');
    await dashboard.locator('[data-tab="send"]').click();
    await dashboard.locator('#url').fill('https://chatgpt.com/c/second');
    await dashboard.locator('#when').selectOption('1m');
    await dashboard.locator('#message').fill('Second usable job');
    await dashboard.locator('#save').click();
    await expect(dashboard.locator('#form-status')).toContainText('Message scheduled.');
    await dashboard.close();
    await provider.close();
  });
});


test('meaningful trailing newlines and non-breaking spaces are not accepted after page mutation', async () => {
  for (const [index, message] of ['trailing newline\n', 'non\u00a0breaking'].entries()) {
    await withExtension({}, async ({ page, context }) => {
      const targetUrl = `https://chatgpt.com/c/text-mutation-${index}`;
      const provider = await context.newPage();
      await provider.goto(targetUrl);
      await provider.locator('#prompt-textarea').evaluate((editor, index) => {
        editor.addEventListener('input', () => {
          editor.value = index === 0 ? editor.value.replace(/\n$/, '') : editor.value.replace(/\u00a0/g, ' ');
        }, { capture: true });
      }, index);
      await saveJob(page, targetUrl, message);
      await dueState(page);
      await tickFromPage(page);
      await expect(page.locator('#job-list')).toContainText('Needs attention');
      await expect(provider.locator('[data-message-author-role="user"]')).toHaveCount(0);
      expect(await provider.evaluate(() => window.__sendClicks || 0)).toBe(0);
      await provider.close();
    });
  }
});
