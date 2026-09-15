import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { emptyState } from '../../src/store.js';

globalThis.crypto ??= webcrypto;
const { createVaultStore, STAGED_KEY } = await import('../../src/vault.js');
const { VAULT_KEY, SESSION_KEY, VaultLockedError, decryptDeviceState, deriveVaultKey, encryptState, newVaultSalt } = await import('../../src/vault-crypto.js');
const LEGACY_KEY = 'prompt-later.v1';
const passphrase = 'Synthetic vault passphrase';
const legacy = {
  version: 1,
  jobs: [{ id: 'job', url: 'https://chatgpt.com/c/vaultfixture', provider: 'chatgpt', message: 'Secret fixture', schedule: { type: 'once', at: 5000, timeZone: 'UTC' }, missedPolicy: 'skip', createdAt: 1, updatedAt: 1, enabled: true, status: 'scheduled', nextRunAt: 5000, runId: null, lastOutcome: null, lastDetail: '' }],
  history: [{ id: 'run', jobId: 'deleted-job', url: 'https://chatgpt.com/c/vaultfixture', provider: 'chatgpt', preview: 'Private activity fixture', dueAt: 1, startedAt: 1, finishedAt: 2, status: 'sent', detail: '' }],
};

function chromeClone(value) {
  if (Array.isArray(value)) return value.map(chromeClone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, chromeClone(value[key])]));
  return value;
}

function chromeMock(initial = {}) {
  const local = structuredClone(initial);
  const session = {};
  const writes = [];
  const area = data => ({
    async get(keys) {
      if (keys === null) return chromeClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => Object.hasOwn(data, key)).map(key => [key, chromeClone(data[key])]));
    },
    async set(update) {
      if (data === local) writes.push(structuredClone(update));
      Object.assign(data, structuredClone(update));
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  return { storage: { local: area(local), session: area(session) }, _local: local, _session: session, writes };
}

function deviceKeysMock() {
  let key = null;
  let creating;
  return {
    calls: 0,
    get: async () => key,
    async getOrCreate() {
      this.calls += 1;
      return key || (creating ||= webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']).then(value => (key = value)));
    },
    replace: value => { key = value; },
  };
}

function fixture(initial = {}) {
  const api = chromeMock(initial);
  const keys = deviceKeysMock();
  return { api, keys, store: createVaultStore(api, keys) };
}

async function oldVault(state = legacy) {
  const salt = newVaultSalt();
  const key = await deriveVaultKey(passphrase, salt);
  const envelope = await encryptState(state, key, salt);
  return { ...fixture({ [VAULT_KEY]: envelope }), envelope, key };
}

function flip(value) {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

function assertPrivate(api) {
  const serialized = JSON.stringify(api.writes);
  for (const value of [legacy.jobs[0].message, legacy.jobs[0].url, legacy.history[0].preview, passphrase, api._session[SESSION_KEY]?.key].filter(Boolean)) {
    assert.equal(serialized.includes(value), false, value);
  }
}

const deviceStatus = { configured: true, mode: 'device', locked: false, legacyData: false };
const lockedStatus = { configured: true, mode: 'passphrase', locked: true, legacyData: false };

test('fresh status initializes automatic encryption, and writes contain no persistent plaintext or raw key', async () => {
  const { api, keys, store } = fixture();
  assert.deepEqual(await store.status(), deviceStatus);
  assert.deepEqual(await store.read(), emptyState());
  await store.write(legacy);
  assert.deepEqual(await store.read(), legacy);
  assert.equal((await keys.get()).extractable, false);
  assert.deepEqual(Object.keys(api._local), [VAULT_KEY]);
  assert.deepEqual(api._session, {});
  assertPrivate(api);
});

test('concurrent store instances initialize once and retain the same device key across restarts', async () => {
  const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
  const other = createVaultStore(api, keys);
  assert.deepEqual(await Promise.all([store.initialize(), other.initialize()]), [deviceStatus, deviceStatus]);
  assert.equal(keys.calls, 1);
  const key = await keys.get();
  assert.deepEqual(await createVaultStore(api, keys).read(), legacy);
  assert.equal(await keys.get(), key);
});

test('legacy plaintext is removed only after independently authenticated device persistence', async () => {
  const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
  const remove = api.storage.local.remove;
  api.storage.local.remove = async key => {
    if (key === LEGACY_KEY) assert.deepEqual(await decryptDeviceState(api._local[VAULT_KEY], await keys.get()), legacy);
    await remove(key);
  };
  assert.deepEqual(await store.initialize(), deviceStatus);
  assert.deepEqual(await store.read(), legacy);
  assert.equal(api._local[LEGACY_KEY], undefined);
  assertPrivate(api);
});

test('existing v1 vaults initialize locked, never touch device keys, and keep their exact envelope', async () => {
  const { api, envelope } = await oldVault();
  const unavailable = { get() { throw new Error('Device keys must not be used'); }, getOrCreate() { throw new Error('Device keys must not be used'); } };
  const store = createVaultStore(api, unavailable);
  assert.deepEqual(await store.initialize(), lockedStatus);
  assert.deepEqual(api._local, { [VAULT_KEY]: envelope });
  await assert.rejects(() => store.read(), VaultLockedError);
  await assert.rejects(() => store.write(emptyState()), VaultLockedError);
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
  assert.deepEqual(api._local, { [VAULT_KEY]: envelope });
  assert.deepEqual(await createVaultStore(api).read(), legacy);
});

test('enable, session loss, wrong unlock, correct unlock, and disable preserve exact data', async () => {
  const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
  await store.initialize();
  await store.enablePassphrase(passphrase);
  assert.equal(api._local[VAULT_KEY].version, 1);
  assert.deepEqual(await createVaultStore(api, keys).read(), legacy);
  await api.storage.session.remove(SESSION_KEY);
  const before = structuredClone(api._local);
  assert.deepEqual(await store.status(), lockedStatus);
  await assert.rejects(() => store.unlock('Incorrect synthetic passphrase'), /incorrect|damaged/);
  await assert.rejects(() => store.disablePassphrase(), VaultLockedError);
  assert.deepEqual(api._local, before);
  assert.deepEqual(api._session, {});
  await store.unlock(passphrase);
  assert.deepEqual(await store.disablePassphrase(), deviceStatus);
  assert.deepEqual(await createVaultStore(api, keys).read(), legacy);
  assert.deepEqual(api._session, {});
  assertPrivate(api);
});

test('concurrent enable cannot replace a chosen passphrase and device mode cannot be unlocked', async () => {
  const { store } = fixture();
  await store.initialize();
  await assert.rejects(() => store.unlock(passphrase), /automatic|device/i);
  const results = await Promise.allSettled([store.enablePassphrase(passphrase), store.enablePassphrase('Different synthetic passphrase')]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  await assert.rejects(() => store.unlock('Different synthetic passphrase'), /incorrect|damaged/);
  await store.unlock(passphrase);
});

test('failed device key persistence preserves plaintext and creates no encrypted record', async () => {
  const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
  keys.getOrCreate = async () => { throw new Error('Synthetic key failure'); };
  await assert.rejects(() => store.initialize(), /key failure/);
  assert.deepEqual(api._local, { [LEGACY_KEY]: legacy });
  assert.deepEqual(api._session, {});
});

test('failed encrypted staging persistence preserves legacy jobs and history', async () => {
  const { api, store } = fixture({ [LEGACY_KEY]: legacy });
  api.storage.local.set = async () => { throw new Error('Synthetic persistence failure'); };
  await assert.rejects(() => store.initialize(), /persistence failure/);
  assert.deepEqual(api._local, { [LEGACY_KEY]: legacy });
});

test('failed staged readback authentication cannot overwrite active or legacy copies and can be retried', async () => {
  const { api, store } = fixture({ [LEGACY_KEY]: legacy });
  const set = api.storage.local.set;
  let saved;
  api.storage.local.set = async update => {
    await set(update);
    if (update[STAGED_KEY]) {
      saved = structuredClone(update[STAGED_KEY]);
      api._local[STAGED_KEY].envelope.data = flip(saved.envelope.data);
    }
  };
  await assert.rejects(() => store.initialize());
  assert.deepEqual(api._local[LEGACY_KEY], legacy);
  assert.equal(api._local[VAULT_KEY], undefined);
  api.storage.local.set = set;
  api._local[STAGED_KEY] = saved;
  assert.deepEqual(await store.initialize(), deviceStatus);
  assert.deepEqual(await store.read(), legacy);
});

test('legacy changes during encryption are not silently discarded', async () => {
  const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
  const create = keys.getOrCreate.bind(keys);
  keys.getOrCreate = async () => {
    const key = await create();
    api._local[LEGACY_KEY] = emptyState();
    return key;
  };
  await assert.rejects(() => store.initialize(), /changed|conflict/i);
  assert.deepEqual(api._local, { [LEGACY_KEY]: emptyState() });
});

test('interrupted legacy cleanup blocks writes and retries without re-encrypting or losing data', async () => {
  const { api, store } = fixture({ [LEGACY_KEY]: legacy });
  const remove = api.storage.local.remove;
  api.storage.local.remove = async key => {
    if (key === LEGACY_KEY) throw new Error('Synthetic cleanup failure');
    await remove(key);
  };
  await assert.rejects(() => store.initialize(), /cleanup failure/);
  const before = structuredClone(api._local);
  await assert.rejects(() => store.status(), /cleanup failure/);
  await assert.rejects(() => store.write(emptyState()), /cleanup failure/);
  assert.deepEqual(api._local, before);
  api.storage.local.remove = remove;
  await store.initialize();
  assert.deepEqual(api._local[VAULT_KEY], before[VAULT_KEY]);
  assert.deepEqual(await store.read(), legacy);
});

for (const direction of ['enable', 'disable']) {
  test(`interrupted ${direction} before final commit requires the right passphrase after restart`, async () => {
    const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
    await store.initialize();
    if (direction === 'disable') await store.enablePassphrase(passphrase);
    const original = structuredClone(api._local[VAULT_KEY]);
    const set = api.storage.local.set;
    api.storage.local.set = async update => {
      if (update[VAULT_KEY]) throw new Error('Synthetic commit failure');
      await set(update);
    };
    await assert.rejects(() => direction === 'enable' ? store.enablePassphrase(passphrase) : store.disablePassphrase(), /commit failure/);
    assert.deepEqual(api._local[VAULT_KEY], original);
    assert.ok(api._local[STAGED_KEY]);
    api.storage.local.set = set;
    await api.storage.session.remove(SESSION_KEY);
    const restarted = createVaultStore(api, keys);
    const before = structuredClone(api._local);
    assert.deepEqual(await restarted.initialize(), lockedStatus);
    await assert.rejects(() => restarted.unlock('Incorrect synthetic passphrase'), /incorrect|damaged/);
    assert.deepEqual(api._local, before);
    await restarted.unlock(passphrase);
    assert.deepEqual(await restarted.read(), legacy);
    assert.equal((await restarted.status()).mode, direction === 'enable' ? 'passphrase' : 'device');
    assert.equal(api._local[STAGED_KEY], undefined);
    assertPrivate(api);
  });
}

test('authenticated staged copy recovers corrupted final ciphertext after an interrupted enable', async () => {
  const { api, store } = fixture({ [LEGACY_KEY]: legacy });
  await store.initialize();
  const set = api.storage.local.set;
  api.storage.local.set = async update => {
    await set(update);
    if (update[VAULT_KEY]) api._local[VAULT_KEY].data = flip(update[VAULT_KEY].data);
  };
  await assert.rejects(() => store.enablePassphrase(passphrase));
  assert.ok(api._local[STAGED_KEY]);
  api.storage.local.set = set;
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
  assert.equal(api._local[STAGED_KEY], undefined);
});

test('failed staged cleanup keeps a recoverable passphrase copy and only completes after retry', async () => {
  const { api, store } = fixture();
  await store.initialize();
  await store.write(legacy);
  const remove = api.storage.local.remove;
  api.storage.local.remove = async key => {
    if (key === STAGED_KEY) throw new Error('Synthetic stage cleanup failure');
    await remove(key);
  };
  await assert.rejects(() => store.enablePassphrase(passphrase), /stage cleanup failure/);
  assert.ok(api._local[STAGED_KEY]);
  assert.deepEqual(api._session, {});
  api.storage.local.remove = remove;
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
});

test('session persistence failure leaves a vault recoverable with the same passphrase', async () => {
  const { api, store } = fixture({ [LEGACY_KEY]: legacy });
  await store.initialize();
  const set = api.storage.session.set;
  api.storage.session.set = async () => { throw new Error('Synthetic session failure'); };
  await assert.rejects(() => store.enablePassphrase(passphrase), /session failure/);
  assert.deepEqual(await store.status(), lockedStatus);
  api.storage.session.set = set;
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
});

test('missing or wrong device key blocks status, reads, writes and transitions without regenerating', async () => {
  const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
  await store.initialize();
  const before = structuredClone(api._local);
  const original = await keys.get();
  for (const key of [null, {}, await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])]) {
    keys.replace(key);
    for (const action of [() => store.initialize(), () => store.status(), () => store.read(), () => store.write(emptyState()), () => store.enablePassphrase(passphrase)]) {
      await assert.rejects(action);
      assert.deepEqual(api._local, before);
    }
  }
  assert.equal(keys.calls, 1);
  keys.replace(original);
  assert.deepEqual(await store.read(), legacy);
});

test('conflicting legacy copies block device and passphrase writes without losing either copy', async () => {
  for (const mode of ['device', 'passphrase']) {
    const { api, store } = fixture({ [LEGACY_KEY]: legacy });
    await store.initialize();
    if (mode === 'passphrase') await store.enablePassphrase(passphrase);
    api._local[LEGACY_KEY] = emptyState();
    const before = structuredClone(api._local);
    await assert.rejects(() => store.read());
    await assert.rejects(() => store.write(emptyState()));
    if (mode === 'passphrase') {
      assert.equal((await store.status()).locked, true);
      await assert.rejects(() => store.unlock(passphrase), /changed|conflict/);
    } else await assert.rejects(() => store.status(), /changed|conflict/);
    assert.deepEqual(api._local, before);
  }
});

test('existing v1 legacy cleanup requires explicit unlock even with a valid session', async () => {
  const { api, store, key, envelope } = await oldVault();
  api._local[LEGACY_KEY] = structuredClone(legacy);
  api._session[SESSION_KEY] = { key, salt: envelope.salt };
  assert.deepEqual(await store.initialize(), { ...lockedStatus, legacyData: true });
  await assert.rejects(() => store.write(emptyState()), VaultLockedError);
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
  assert.equal(api._local[LEGACY_KEY], undefined);
});

test('a syntactically valid but incorrect session key cannot report unlocked or overwrite data', async () => {
  const { api, store, envelope } = await oldVault();
  api._session[SESSION_KEY] = { salt: envelope.salt, key: Buffer.alloc(32, 23).toString('base64') };
  const before = structuredClone(api._local);
  for (const action of [() => store.status(), () => store.read(), () => store.write(emptyState()), () => store.disablePassphrase()]) await assert.rejects(action, /damaged/);
  assert.deepEqual(api._local, before);
  await store.unlock(passphrase);
  assert.deepEqual(await store.read(), legacy);
});

test('damaged ciphertext, unsupported headers, and malformed stages are never reset', async () => {
  const { api, store } = fixture();
  await store.initialize();
  const valid = structuredClone(api._local[VAULT_KEY]);
  for (const change of [{ data: flip(valid.data) }, { version: 3 }, { keyId: 'other' }, { extra: true }]) {
    api._local[VAULT_KEY] = { ...valid, ...change };
    const before = structuredClone(api._local);
    for (const action of [() => store.status(), () => store.initialize(), () => store.read(), () => store.write(emptyState())]) await assert.rejects(action);
    assert.deepEqual(api._local, before);
  }
  api._local[VAULT_KEY] = valid;
  api._local[STAGED_KEY] = { version: 9 };
  const before = structuredClone(api._local);
  await assert.rejects(() => store.initialize());
  assert.deepEqual(api._local, before);
});

test('a stage with a competing active IV never overwrites the competing record', async () => {
  const { api, store } = fixture();
  await store.initialize();
  const set = api.storage.local.set;
  api.storage.local.set = async update => {
    if (update[VAULT_KEY]) throw new Error('Synthetic commit failure');
    await set(update);
  };
  await assert.rejects(() => store.enablePassphrase(passphrase));
  api.storage.local.set = set;
  api._local[VAULT_KEY].iv = flip(api._local[VAULT_KEY].iv);
  const before = structuredClone(api._local);
  await assert.rejects(() => store.unlock(passphrase), /changed|conflict/);
  assert.deepEqual(api._local, before);
});
