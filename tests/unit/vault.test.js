import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { emptyState } from '../../src/store.js';

globalThis.crypto ??= webcrypto;
const { BACKUP_KEY, createVaultStore, STAGED_KEY } = await import('../../src/vault.js');
const { DEVICE_KEY_ID } = await import('../../src/device-key-store.js');
const { VAULT_KEY, decryptDeviceState, encryptDeviceState } = await import('../../src/vault-crypto.js');
const LEGACY_KEY = 'prompt-later.v1';
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

function flip(value) {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

// Production code will not encrypt a state it considers invalid, which is
// correct, so a record holding an unusable job has to be built here.
async function sealPayload(payload, key) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = await webcrypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(`prompt-later:vault:2:device:${DEVICE_KEY_ID}`),
    tagLength: 128,
  }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    version: 2,
    mode: 'device',
    cipher: 'AES-GCM-256',
    keyId: DEVICE_KEY_ID,
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(new Uint8Array(data)).toString('base64'),
  };
}

function assertPrivate(api) {
  const serialized = JSON.stringify(api.writes);
  for (const value of [legacy.jobs[0].message, legacy.jobs[0].url, legacy.history[0].preview]) {
    assert.equal(serialized.includes(value), false, value);
  }
}

const deviceStatus = { configured: true, mode: 'device', legacyData: false, dropped: [] };

test('fresh status initializes automatic encryption, and writes contain no persistent plaintext', async () => {
  const { api, keys, store } = fixture();
  assert.deepEqual(await store.status(), deviceStatus);
  assert.deepEqual(await store.read(), emptyState());
  await store.write(legacy);
  assert.deepEqual(await store.read(), legacy);
  assert.equal((await keys.get()).extractable, false);
  assert.deepEqual(Object.keys(api._local), [VAULT_KEY]);
  // Nothing is kept in session storage now that there is no derived key to cache.
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

test('failed device key persistence preserves plaintext and creates no encrypted record', async () => {
  const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
  keys.getOrCreate = async () => { throw new Error('Synthetic key failure'); };
  await assert.rejects(() => store.initialize(), /key failure/);
  assert.deepEqual(api._local, { [LEGACY_KEY]: legacy });
  assert.deepEqual(api._session, {});
});

test('failed encrypted persistence preserves legacy jobs and history', async () => {
  const { api, store } = fixture({ [LEGACY_KEY]: legacy });
  api.storage.local.set = async () => { throw new Error('Synthetic persistence failure'); };
  await assert.rejects(() => store.initialize(), /persistence failure/);
  assert.deepEqual(api._local, { [LEGACY_KEY]: legacy });
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

test('missing or wrong device key blocks status, reads and writes without regenerating', async () => {
  const { api, keys, store } = fixture({ [LEGACY_KEY]: legacy });
  await store.initialize();
  const before = structuredClone(api._local);
  const original = await keys.get();
  for (const key of [null, {}, await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])]) {
    keys.replace(key);
    for (const action of [() => store.initialize(), () => store.status(), () => store.read(), () => store.write(emptyState())]) {
      await assert.rejects(action);
      assert.deepEqual(api._local, before);
    }
  }
  assert.equal(keys.calls, 1);
  keys.replace(original);
  assert.deepEqual(await store.read(), legacy);
});

test('a conflicting legacy copy blocks reads and writes without losing either copy', async () => {
  const { api, store } = fixture({ [LEGACY_KEY]: legacy });
  await store.initialize();
  api._local[LEGACY_KEY] = emptyState();
  const before = structuredClone(api._local);
  await assert.rejects(() => store.read());
  await assert.rejects(() => store.write(emptyState()));
  await assert.rejects(() => store.status(), /changed|conflict/);
  assert.deepEqual(api._local, before);
});

test('damaged ciphertext and unsupported headers are never reset', async () => {
  const { api, store } = fixture();
  await store.initialize();
  const valid = structuredClone(api._local[VAULT_KEY]);
  for (const change of [{ data: flip(valid.data) }, { version: 3 }, { keyId: 'other' }, { extra: true }]) {
    api._local[VAULT_KEY] = { ...valid, ...change };
    const before = structuredClone(api._local);
    for (const action of [() => store.status(), () => store.initialize(), () => store.read(), () => store.write(emptyState())]) await assert.rejects(action);
    assert.deepEqual(api._local, before);
  }
});

test('a write whose stored bytes do not read back is refused', async () => {
  const { api, store } = fixture();
  await store.initialize();
  const original = structuredClone(api._local[VAULT_KEY]);
  const set = api.storage.local.set;
  api.storage.local.set = async update => {
    await set(update);
    if (update[VAULT_KEY]) api._local[VAULT_KEY].data = flip(update[VAULT_KEY].data);
  };
  await assert.rejects(() => store.write(legacy), /did not verify/);
  api.storage.local.set = set;
  // The damaged record is reported rather than trusted, and the good copy is
  // restorable by writing again.
  api._local[VAULT_KEY] = original;
  await store.write(legacy);
  assert.deepEqual(await store.read(), legacy);
});

test('a staged record left by an older version is discarded once a vault is readable', async () => {
  const { api, keys, store } = fixture();
  await store.initialize();
  const key = await keys.get();
  api._local[STAGED_KEY] = { version: 1, sourceIv: null, envelope: await encryptDeviceState(legacy, key) };
  assert.deepEqual(await store.status(), deviceStatus);
  assert.equal(api._local[STAGED_KEY], undefined);
  assert.deepEqual(await store.read(), emptyState());
});

test('a passphrase vault explains how to recover it and changes nothing', async () => {
  const passphraseEnvelope = {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: 600000,
    salt: Buffer.alloc(16, 7).toString('base64'),
    cipher: 'AES-GCM-256',
    iv: Buffer.alloc(12, 3).toString('base64'),
    data: Buffer.alloc(32, 5).toString('base64'),
  };
  const api = chromeMock({ [VAULT_KEY]: passphraseEnvelope });
  const unavailable = {
    get() { throw new Error('Device keys must not be used'); },
    getOrCreate() { throw new Error('Device keys must not be used'); },
  };
  const store = createVaultStore(api, unavailable);
  const before = structuredClone(api._local);
  for (const action of [() => store.initialize(), () => store.status(), () => store.read(), () => store.write(emptyState())]) {
    await assert.rejects(action, /passphrase.*no longer supported/s);
  }
  assert.deepEqual(api._local, before);
});


test('a job for a provider that no longer exists costs that job, not the whole queue', async () => {
  const { api, keys, store } = fixture();
  await store.initialize();
  const key = await keys.get();
  // Shaped exactly like a job saved before a provider was removed.
  const retired = { ...legacy.jobs[0], id: 'retired', url: 'https://grok.com/c/12345678-1234-1234-1234-123456789abc', provider: 'grok', message: 'Saved for a removed provider' };
  const payload = { version: 1, jobs: [legacy.jobs[0], retired], history: legacy.history };
  api._local[VAULT_KEY] = await sealPayload(payload, key);
  const original = structuredClone(api._local[VAULT_KEY]);

  const status = await store.status();
  assert.equal(status.dropped.length, 1);
  assert.equal(status.dropped[0].kind, 'job');
  assert.equal(status.dropped[0].url, retired.url);
  // Everything still usable is returned untouched.
  const state = await store.read();
  assert.deepEqual(state.jobs.map(job => job.id), ['job']);
  assert.deepEqual(state.history, legacy.history);
  // The unreadable original is preserved rather than destroyed.
  assert.deepEqual(api._local[BACKUP_KEY], original);
  // Writing the repaired state keeps working, and the backup is not overwritten.
  await store.write(state);
  assert.deepEqual(await store.read(), state);
  assert.deepEqual(api._local[BACKUP_KEY], original);
});

test('a damaged record is still refused rather than repaired', async () => {
  const { api, store } = fixture();
  await store.initialize();
  await store.write(legacy);
  api._local[VAULT_KEY].data = flip(api._local[VAULT_KEY].data);
  const before = structuredClone(api._local);
  for (const action of [() => store.status(), () => store.read(), () => store.write(emptyState())]) {
    await assert.rejects(action, /damaged|unavailable/);
  }
  // Repair must not be reachable for ciphertext problems, and nothing is stashed.
  assert.equal(api._local[BACKUP_KEY], undefined);
  assert.deepEqual(api._local, before);
});
