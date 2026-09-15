import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { emptyState } from '../../src/store.js';

globalThis.crypto ??= webcrypto;
const { createVaultStore } = await import('../../src/vault.js');
const { VAULT_KEY, SESSION_KEY, VaultLockedError } = await import('../../src/vault-crypto.js');
const LEGACY_KEY = 'prompt-later.v1';
const passphrase = 'Synthetic vault passphrase';
const legacy = {
  version: 1,
  jobs: [{ id: 'job', url: 'https://chatgpt.com/c/vaultfixture', provider: 'chatgpt', message: 'Secret fixture', schedule: { type: 'once', at: 5000, timeZone: 'UTC' }, missedPolicy: 'skip', createdAt: 1, updatedAt: 1, enabled: true, status: 'scheduled', nextRunAt: 5000, runId: null, lastOutcome: null, lastDetail: '' }],
  history: [{ id: 'run', jobId: 'deleted-job', url: 'https://chatgpt.com/c/vaultfixture', provider: 'chatgpt', preview: 'Private activity fixture', dueAt: 1, startedAt: 1, finishedAt: 2, status: 'sent', detail: '' }],
};

function chromeMock(initial = {}) {
  const local = structuredClone(initial);
  const session = {};
  const area = data => ({
    async get(keys) {
      if (keys === null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])]));
    },
    async set(update) { Object.assign(data, structuredClone(update)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  return { storage: { local: area(local), session: area(session) }, _local: local, _session: session };
}

function flip(value) {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

test('fresh vault is locked and stores no persistent plaintext or key after setup', async () => {
  const api = chromeMock();
  const store = createVaultStore(api);
  assert.deepEqual(await store.status(), { configured: false, locked: true, legacyData: false });
  await assert.rejects(() => store.read(), VaultLockedError);
  await assert.rejects(() => store.write(legacy), VaultLockedError);
  await store.setup(passphrase);
  await store.write(legacy);
  assert.deepEqual(await store.read(), legacy);
  for (const value of [legacy.jobs[0].message, legacy.jobs[0].url, legacy.history[0].preview, passphrase, api._session[SESSION_KEY].key]) {
    assert.equal(JSON.stringify(api._local).includes(value), false);
  }
  assert.deepEqual(Object.keys(api._local), [VAULT_KEY]);
});

test('worker instances share session unlock; losing the session requires the exact passphrase', async () => {
  const api = chromeMock({ [LEGACY_KEY]: legacy });
  const store = createVaultStore(api);
  await store.setup(passphrase);
  assert.equal(api._local[LEGACY_KEY], undefined);
  assert.deepEqual(await createVaultStore(api).read(), legacy);
  await api.storage.session.remove(SESSION_KEY);
  const before = structuredClone(api._local);
  await assert.rejects(() => store.read(), VaultLockedError);
  await assert.rejects(() => store.write(emptyState()), VaultLockedError);
  assert.equal((await store.status()).locked, true);
  await assert.rejects(() => store.unlock('Incorrect synthetic passphrase'));
  assert.deepEqual(api._local, before);
  assert.deepEqual(api._session, {});
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
});

test('concurrent setup cannot replace a vault or change its passphrase', async () => {
  const api = chromeMock();
  const store = createVaultStore(api);
  const results = await Promise.allSettled([store.setup(passphrase), store.setup('Different synthetic passphrase')]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  const before = structuredClone(api._local);
  await assert.rejects(() => store.setup(passphrase));
  await assert.rejects(() => store.unlock('Different synthetic passphrase'));
  assert.deepEqual(api._local, before);
  await store.unlock(passphrase);
});

test('failed encrypted persistence leaves legacy jobs and history intact', async () => {
  const api = chromeMock({ [LEGACY_KEY]: legacy });
  api.storage.local.set = async () => { throw new Error('Synthetic persistence failure'); };
  await assert.rejects(() => createVaultStore(api).setup(passphrase), /persistence failure/);
  assert.deepEqual(api._local, { [LEGACY_KEY]: legacy });
  assert.deepEqual(api._session, {});
});

test('failed readback authentication never deletes legacy data and is recoverable', async () => {
  const api = chromeMock({ [LEGACY_KEY]: legacy });
  const set = api.storage.local.set;
  let saved;
  api.storage.local.set = async update => {
    saved = structuredClone(update[VAULT_KEY]);
    await set(update);
    api._local[VAULT_KEY].data = flip(saved.data);
  };
  const store = createVaultStore(api);
  await assert.rejects(() => store.setup(passphrase), /damaged/);
  assert.deepEqual(api._local[LEGACY_KEY], legacy);
  assert.deepEqual(api._session, {});
  api.storage.local.set = set;
  api._local[VAULT_KEY] = saved;
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
  assert.equal(api._local[LEGACY_KEY], undefined);
});

test('interrupted legacy cleanup remains locked until verified migration finishes', async () => {
  const api = chromeMock({ [LEGACY_KEY]: legacy });
  const remove = api.storage.local.remove;
  api.storage.local.remove = async () => { throw new Error('Synthetic cleanup failure'); };
  const store = createVaultStore(api);
  await assert.rejects(() => store.setup(passphrase), /cleanup failure/);
  assert.deepEqual(api._local[LEGACY_KEY], legacy);
  assert.ok(api._local[VAULT_KEY]);
  assert.deepEqual(api._session, {});
  assert.equal((await store.status()).locked, true);
  await assert.rejects(() => store.read(), VaultLockedError);
  const encrypted = structuredClone(api._local[VAULT_KEY]);
  api.storage.local.remove = remove;
  await store.unlock(passphrase);
  assert.deepEqual(api._local[VAULT_KEY], encrypted);
  assert.equal(api._local[LEGACY_KEY], undefined);
  assert.deepEqual(await store.read(), legacy);
});

test('session persistence failure leaves a vault recoverable with the same passphrase', async () => {
  const api = chromeMock({ [LEGACY_KEY]: legacy });
  const set = api.storage.session.set;
  api.storage.session.set = async () => { throw new Error('Synthetic session failure'); };
  const store = createVaultStore(api);
  await assert.rejects(() => store.setup(passphrase), /session failure/);
  assert.equal(api._local[LEGACY_KEY], undefined);
  assert.ok(api._local[VAULT_KEY]);
  assert.equal((await store.status()).locked, true);
  api.storage.session.set = set;
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
});

test('conflicting legacy data cannot be silently discarded during unlock', async () => {
  const api = chromeMock({ [LEGACY_KEY]: legacy });
  const store = createVaultStore(api);
  await store.setup(passphrase);
  api._local[LEGACY_KEY] = { ...legacy, jobs: [] };
  const before = structuredClone(api._local);
  await assert.rejects(() => store.unlock(passphrase), /changed/);
  await assert.rejects(() => store.read(), VaultLockedError);
  await assert.rejects(() => store.write(emptyState()), VaultLockedError);
  assert.deepEqual(api._local, before);
});

test('a valid but incorrect session key cannot overwrite authenticated data', async () => {
  const api = chromeMock({ [LEGACY_KEY]: legacy });
  const store = createVaultStore(api);
  await store.setup(passphrase);
  api._session[SESSION_KEY].key = Buffer.alloc(32, 23).toString('base64');
  const before = structuredClone(api._local);
  await assert.rejects(() => store.write(emptyState()), /damaged/);
  await assert.rejects(() => store.read(), /damaged/);
  assert.deepEqual(api._local, before);
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
});

test('damaged ciphertext or unsupported headers are not reset by reads, writes, or setup', async () => {
  const api = chromeMock();
  const store = createVaultStore(api);
  await store.setup(passphrase);
  const valid = structuredClone(api._local[VAULT_KEY]);
  for (const changes of [{ data: flip(valid.data) }, { version: 2 }, { iterations: 1 }]) {
    api._local[VAULT_KEY] = { ...valid, ...changes };
    const before = structuredClone(api._local);
    await assert.rejects(() => store.read());
    await assert.rejects(() => store.write(emptyState()));
    await assert.rejects(() => store.setup(passphrase));
    if (changes.version || changes.iterations) await assert.rejects(() => store.status());
    assert.deepEqual(api._local, before);
  }
});
