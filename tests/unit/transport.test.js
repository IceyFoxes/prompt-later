import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelivery, inspectTarget } from '../../src/transport.js';

function api(overrides = {}) {
  const calls = { query: 0, create: 0, inject: 0, send: 0 };
  const tabs = [{ id: 7, url: 'https://chatgpt.com/c/fixture', status: 'complete', active: false }];
  const chromeApi = {
    permissions: { contains: async () => true },
    tabs: {
      query: async () => { calls.query += 1; return tabs; },
      get: async () => tabs[0],
      create: async options => { calls.create += 1; return { ...tabs[0], ...options }; },
      sendMessage: async (tabId, message) => { calls.send += 1; return message.type === 'PL_PREPARE' ? { ready: true } : { outcome: 'sent' }; },
    },
    scripting: { executeScript: async () => { calls.inject += 1; } },
    ...overrides,
  };
  return { chromeApi, calls };
}

const job = { url: 'https://chatgpt.com/c/fixture', message: 'Synthetic', provider: 'chatgpt' };
const run = { id: 'run-1' };

function expectResult(result, outcome) {
  assert.equal(result.outcome, outcome);
}

test('missing permission blocks without tab, injection, or mark calls', async () => {
  const { chromeApi, calls } = api({ permissions: { contains: async () => false } });
  let marked = false;
  const result = await createDelivery(chromeApi)(job, run, async () => { marked = true; });
  assert.equal(result.outcome, 'blocked');
  assert.equal(calls.query, 0);
  assert.equal(calls.create, 0);
  assert.equal(calls.inject, 0);
  assert.equal(marked, false);
});

test('mark failure rejects before commit', async () => {
  const { chromeApi, calls } = api();
  await assert.rejects(() => createDelivery(chromeApi)(job, run, async () => { throw new Error('mark failed'); }));
  assert.equal(calls.send, 1);
});

test('lost page response after dispatch is uncertain', async () => {
  const { chromeApi, calls } = api({
    tabs: {
      query: async () => [{ id: 7, url: 'https://chatgpt.com/c/fixture', status: 'complete', active: false }],
      get: async () => ({ id: 7, url: 'https://chatgpt.com/c/fixture', status: 'complete' }),
      create: async () => { calls.create += 1; return { id: 7, url: 'https://chatgpt.com/c/fixture', status: 'complete' }; },
      sendMessage: async (tabId, message) => {
        calls.send += 1;
        return message.type === 'PL_PREPARE' ? { ready: true } : Promise.reject(new Error('response lost'));
      },
    },
  });
  let marked = false;
  const result = await createDelivery(chromeApi)(job, run, async () => { marked = true; });
  assert.equal(marked, true);
  assert.equal(result.outcome, 'uncertain');
  assert.equal(calls.send, 2);
});

for (const initial of ['missing', 'loading', 'complete']) {
  test(`${initial} tab only requests composer waiting when opening or loading`, async () => {
    const { chromeApi, calls } = api();
    const messages = [];
    const created = [];
    chromeApi.tabs.query = async () => initial === 'missing' ? [] : [{ id: 7, url: job.url, status: initial, active: false }];
    const create = chromeApi.tabs.create;
    chromeApi.tabs.create = async options => { created.push(options); return create(options); };
    chromeApi.tabs.sendMessage = async (tabId, message) => {
      messages.push(message);
      return message.type === 'PL_PREPARE' ? { ready: true } : { outcome: 'sent' };
    };
    let marked = 0;
    expectResult(await createDelivery(chromeApi)(job, run, async () => { marked += 1; }), 'sent');
    assert.equal(marked, 1);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].waitForComposer, initial !== 'complete');
    assert.equal(messages[1].type, 'PL_COMMIT');
    assert.equal(Object.hasOwn(messages[1], 'waitForComposer'), false);
    assert.deepEqual(created, initial === 'missing' ? [{ url: job.url, active: false }] : []);
    assert.equal(calls.create, initial === 'missing' ? 1 : 0);
  });
}

test('blocked preparation never marks or commits', async () => {
  const { chromeApi } = api();
  const messages = [];
  chromeApi.tabs.sendMessage = async (tabId, message) => { messages.push(message); return { ready: false, detail: 'Existing draft' }; };
  const result = await createDelivery(chromeApi)(job, run, async () => assert.fail('Must not mark'));
  assert.deepEqual(result, { outcome: 'blocked', detail: 'Existing draft' });
  assert.deepEqual(messages.map(message => message.type), ['PL_PREPARE']);
});

test('cold inspection requests waiting without preparing or committing a send', async () => {
  const { chromeApi } = api();
  chromeApi.tabs.query = async () => [];
  const messages = [];
  chromeApi.tabs.sendMessage = async (tabId, message) => { messages.push(message); return { status: 'ready' }; };
  assert.deepEqual(await inspectTarget(chromeApi, job.url), { status: 'ready' });
  assert.deepEqual(messages, [{ type: 'PL_INSPECT', url: job.url, waitForComposer: true }]);
});

test('permission revoked during preparation blocks before dispatch', async () => {
  const { chromeApi, calls } = api();
  let checks = 0;
  chromeApi.permissions.contains = async () => ++checks === 1;
  const result = await createDelivery(chromeApi)(job, run, async () => assert.fail('Must not mark'));
  assert.deepEqual(result, { outcome: 'blocked', detail: 'Site access was removed before sending.', reason: 'permission-missing' });
  assert.equal(calls.send, 1);
});

test('preparation must finish before dispatch is marked and committed once', async () => {
  const { chromeApi } = api();
  let start;
  let release;
  const started = new Promise(resolve => { start = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const messages = [];
  chromeApi.tabs.sendMessage = async (tabId, message) => {
    messages.push(message.type);
    if (message.type === 'PL_PREPARE') {
      start();
      return waiting;
    }
    return { outcome: 'sent' };
  };
  let marked = 0;
  const delivery = createDelivery(chromeApi)(job, run, async () => { marked += 1; });
  await started;
  assert.equal(marked, 0);
  assert.deepEqual(messages, ['PL_PREPARE']);
  release({ ready: true });
  assert.equal((await delivery).outcome, 'sent');
  assert.equal(marked, 1);
  assert.deepEqual(messages, ['PL_PREPARE', 'PL_COMMIT']);
});
