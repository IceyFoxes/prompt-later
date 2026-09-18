import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, webcrypto } from 'node:crypto';
import { emptyState } from '../../src/store.js';

globalThis.crypto ??= webcrypto;
const { decryptDeviceState, encryptDeviceState, isPassphraseEnvelope, validateDeviceEnvelope, vaultMode } = await import('../../src/vault-crypto.js');

const rawKey = Buffer.alloc(32, 11).toString('base64');
const state = {
  version: 1,
  jobs: [{ id: 'vault-job', url: 'https://chatgpt.com/c/private-vault-fixture', provider: 'chatgpt', message: 'Private synthetic message kept only in ciphertext', schedule: { type: 'once', at: 5000, timeZone: 'UTC' }, missedPolicy: 'skip', createdAt: 1, updatedAt: 1, enabled: true, status: 'scheduled', nextRunAt: 5000, runId: null, lastOutcome: null, lastDetail: '' }],
  history: [],
};

function flip(value) {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

const deviceKey = (raw = rawKey, extractable = false, usages = ['encrypt', 'decrypt']) => webcrypto.subtle.importKey('raw', Buffer.from(raw, 'base64'), { name: 'AES-GCM' }, extractable, usages);

test('device ciphertext is independently readable as AES-256-GCM with exact v2 metadata', async () => {
  const key = await deviceKey();
  const envelope = await encryptDeviceState(state, key);
  assert.deepEqual(Object.keys(envelope).sort(), ['cipher', 'data', 'iv', 'keyId', 'mode', 'version']);
  assert.equal(vaultMode(envelope), 'device');
  const ciphertext = Buffer.from(envelope.data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(rawKey, 'base64'), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from('prompt-later:vault:2:device:prompt-later.device-key.v1'));
  decipher.setAuthTag(ciphertext.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8')), state);
  assert.deepEqual(await decryptDeviceState(envelope, key), state);
  assert.equal(key.extractable, false);
  await assert.rejects(() => webcrypto.subtle.exportKey('raw', key));
  for (const secret of [rawKey, state.jobs[0].message, state.jobs[0].url]) assert(!JSON.stringify(envelope).includes(secret));
});

test('device writes use fresh IVs and reject wrong keys and tampered metadata/ciphertext', async () => {
  const key = await deviceKey();
  const first = await encryptDeviceState(state, key);
  const second = await encryptDeviceState(state, key);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
  assert.equal(Buffer.from(first.iv, 'base64').length, 12);
  await assert.rejects(() => decryptDeviceState(first, deviceKey()), /damaged/);
  const wrong = await deviceKey(flip(rawKey));
  await assert.rejects(() => decryptDeviceState(first, wrong), /damaged/);
  for (const field of ['iv', 'data']) await assert.rejects(() => decryptDeviceState({ ...first, [field]: flip(first[field]) }, key), /damaged/);
  for (const change of [{ version: 1 }, { mode: 'passphrase' }, { cipher: 'AES-CBC' }, { keyId: 'other' }, { iv: 'bad' }, { data: '' }, { extra: true }]) {
    assert.throws(() => validateDeviceEnvelope({ ...first, ...change }));
    await assert.rejects(() => decryptDeviceState({ ...first, ...change }, key));
  }
});

test('device encryption enforces non-exportability, usages, key ID and the plaintext size limit', async () => {
  const key = await deviceKey();
  const envelope = await encryptDeviceState(state, key);
  for (const invalid of [null, {}, await deviceKey(rawKey, true), await deviceKey(rawKey, false, ['encrypt'])]) {
    await assert.rejects(() => encryptDeviceState(state, invalid), /invalid/);
    await assert.rejects(() => decryptDeviceState(envelope, invalid), /damaged/);
  }
  await assert.rejects(() => encryptDeviceState(state, key, 'other'), /invalid/);
  const oversized = structuredClone(state);
  oversized.jobs[0].lastDetail = 'x'.repeat(7 * 1024 * 1024);
  await assert.rejects(() => encryptDeviceState(oversized, key), /too large/);
  assert.deepEqual(await decryptDeviceState(envelope, key), state);
  assert.deepEqual(await decryptDeviceState(await encryptDeviceState(emptyState(), key), key), emptyState());
});

test('a passphrase vault is refused with instructions instead of being called damaged', () => {
  // Written by an older version; unreadable here, but recoverable by the user.
  const legacy = {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: 600000,
    salt: Buffer.alloc(16, 7).toString('base64'),
    cipher: 'AES-GCM-256',
    iv: Buffer.alloc(12, 3).toString('base64'),
    data: Buffer.alloc(32, 5).toString('base64'),
  };
  assert.equal(isPassphraseEnvelope(legacy), true);
  assert.throws(() => vaultMode(legacy), /passphrase.*no longer supported/s);
  assert.throws(() => vaultMode(legacy), /turn off passphrase protection/);
  assert.throws(() => vaultMode(legacy), /Nothing was reset/);
  assert.equal(isPassphraseEnvelope({ version: 2, mode: 'device' }), false);
  assert.throws(() => vaultMode({ version: 3 }), /unreadable or unsupported/);
});
