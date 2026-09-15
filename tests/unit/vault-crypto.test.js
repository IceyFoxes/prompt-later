import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, pbkdf2Sync, webcrypto } from 'node:crypto';
import { emptyState } from '../../src/store.js';

globalThis.crypto ??= webcrypto;
const { decryptState, deriveVaultKey, encryptState, KDF_ITERATIONS, newVaultSalt, validSession, validateEnvelope } = await import('../../src/vault-crypto.js');

const passphrase = 'A unique synthetic vault passphrase';
const salt = Buffer.alloc(16, 7).toString('base64');
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

test('vault derivation agrees with independent PBKDF2-HMAC-SHA256', async () => {
  assert.equal(KDF_ITERATIONS, 600000);
  const expected = pbkdf2Sync(passphrase, Buffer.from(salt, 'base64'), 600000, 32, 'sha256').toString('base64');
  assert.equal(await deriveVaultKey(passphrase, salt), expected);
  assert.notEqual(await deriveVaultKey(`${passphrase} `, salt), expected);
});

test('vault encryption is independently readable as AES-256-GCM with bound metadata', async () => {
  const envelope = await encryptState(state, rawKey, salt);
  assert.deepEqual(Object.keys(envelope).sort(), ['cipher', 'data', 'iterations', 'iv', 'kdf', 'salt', 'version']);
  const ciphertext = Buffer.from(envelope.data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(rawKey, 'base64'), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(`prompt-later:vault:1:PBKDF2-SHA256:600000:${salt}`));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.deepEqual(JSON.parse(plaintext.toString('utf8')), state);
  assert.deepEqual(await decryptState(envelope, rawKey), state);
  for (const secret of [passphrase, rawKey, state.jobs[0].message, state.jobs[0].url]) {
    assert.equal(JSON.stringify(envelope).includes(secret), false);
  }
});

test('each vault write uses a fresh nonce, and fresh vaults use distinct salts', async () => {
  const first = await encryptState(emptyState(), rawKey, salt);
  const second = await encryptState(emptyState(), rawKey, salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
  assert.equal(Buffer.from(first.iv, 'base64').length, 12);
  const generated = newVaultSalt();
  assert.equal(Buffer.from(generated, 'base64').length, 16);
  assert.notEqual(generated, newVaultSalt());
});

test('wrong keys and changed authenticated ciphertext, nonce, or salt are rejected', async () => {
  const envelope = await encryptState(state, rawKey, salt);
  await assert.rejects(() => decryptState(envelope, flip(rawKey)), /incorrect|damaged/);
  for (const field of ['data', 'iv', 'salt']) {
    await assert.rejects(() => decryptState({ ...envelope, [field]: flip(envelope[field]) }, rawKey), /incorrect|damaged/);
  }
  assert.deepEqual(await decryptState(envelope, rawKey), state);
});

test('vault headers, encodings, session keys, and passphrase bounds are validated', async () => {
  const envelope = await encryptState(emptyState(), rawKey, salt);
  for (const change of [{ version: 2 }, { iterations: 1 }, { iterations: 600001 }, { kdf: 'SHA256' }, { cipher: 'AES-CBC' }, { salt: 'invalid' }, { iv: Buffer.alloc(11).toString('base64') }, { data: '' }, { extra: 'secret' }]) {
    assert.throws(() => validateEnvelope({ ...envelope, ...change }));
  }
  for (const value of ['', 'short', ' '.repeat(12), 'x'.repeat(1025), null]) {
    await assert.rejects(() => deriveVaultKey(value, salt), /passphrase/);
  }
  assert.equal(validSession({ key: rawKey, salt }, salt), true);
  assert.equal(validSession({ key: rawKey, salt }, flip(salt)), false);
  assert.equal(validSession({ key: 'bad', salt }, salt), false);
  assert.equal(validSession(undefined, salt), false);
  await assert.rejects(() => encryptState({ version: 9 }, rawKey, salt));
});
