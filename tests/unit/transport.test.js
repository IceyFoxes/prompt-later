import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelivery } from '../../src/transport.js';

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
