import { validateState } from './store.js';
import { DEVICE_KEY_ID, validDeviceKey } from './device-key-store.js';

export const VAULT_KEY = 'prompt-later.vault.v1';
const MAX_PLAINTEXT_BYTES = 7 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const cryptoApi = globalThis.crypto;

function encode(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

function decode(value, size) {
  if (typeof value !== 'string' || value.length > Math.ceil((MAX_PLAINTEXT_BYTES + 16) / 3) * 4
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('The saved vault has an invalid encoding. Nothing was reset.');
  }
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (encode(bytes) !== value || (size !== undefined && bytes.length !== size)) {
    throw new Error('The saved vault has an invalid encoding. Nothing was reset.');
  }
  return bytes;
}

function deviceAdditionalData(keyId) {
  return encoder.encode(`prompt-later:vault:2:device:${keyId}`);
}

export function validateDeviceEnvelope(value) {
  const keys = ['cipher', 'data', 'iv', 'keyId', 'mode', 'version'];
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== keys.join(',')
      || value.version !== 2 || value.mode !== 'device' || value.cipher !== 'AES-GCM-256' || value.keyId !== DEVICE_KEY_ID) {
    throw new Error('The saved automatic vault is unreadable. Nothing was reset.');
  }
  decode(value.iv, 12);
  if (decode(value.data).length < 16) throw new Error('The saved automatic vault is incomplete. Nothing was reset.');
  return value;
}

// Passphrase protection was removed. A vault left in that form cannot be read
// here, so say exactly how to recover it rather than reporting damage.
export function isPassphraseEnvelope(value) {
  return value?.version === 1 && value?.kdf === 'PBKDF2-SHA256';
}

export function vaultMode(value) {
  if (isPassphraseEnvelope(value)) {
    throw new Error('This copy is protected by a passphrase, which is no longer supported. Reinstall the previous version, turn off passphrase protection, then update again. Nothing was reset.');
  }
  if (value?.version === 2 && value?.mode === 'device') {
    validateDeviceEnvelope(value);
    return 'device';
  }
  throw new Error('The saved vault is unreadable or unsupported. Nothing was reset.');
}

export async function encryptDeviceState(state, key, keyId = DEVICE_KEY_ID) {
  if (!validDeviceKey(key) || keyId !== DEVICE_KEY_ID) throw new Error('The automatic encryption key is invalid. Nothing was reset.');
  const plaintext = encoder.encode(JSON.stringify(validateState(state)));
  try {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Saved data is too large for the encrypted vault. Existing data was left intact.');
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: deviceAdditionalData(keyId), tagLength: 128 }, key, plaintext);
    return { version: 2, mode: 'device', cipher: 'AES-GCM-256', keyId, iv: encode(iv), data: encode(new Uint8Array(ciphertext)) };
  } finally {
    plaintext.fill(0);
  }
}

// Decryption and validation are separate so a readable vault holding one
// unusable job can be told apart from a damaged or wrongly keyed one.
export async function decryptDevicePayload(envelope, key) {
  validateDeviceEnvelope(envelope);
  let plaintext;
  try {
    if (!validDeviceKey(key)) throw new Error('Invalid device key.');
    plaintext = new Uint8Array(await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv, 12), additionalData: deviceAdditionalData(envelope.keyId), tagLength: 128 }, key, decode(envelope.data)));
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('The automatic encryption key is unavailable or the saved vault is damaged. Nothing was reset.');
  } finally {
    plaintext?.fill(0);
  }
}

export async function decryptDeviceState(envelope, key) {
  return validateState(await decryptDevicePayload(envelope, key));
}
