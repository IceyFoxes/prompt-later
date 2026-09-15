import { validateState } from './store.js';

export const VAULT_KEY = 'prompt-later.vault.v1';
export const SESSION_KEY = 'prompt-later.vault-session.v1';
export const KDF_ITERATIONS = 600000;
const MAX_PLAINTEXT_BYTES = 7 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const cryptoApi = globalThis.crypto;

export class VaultLockedError extends Error {
  constructor(message = 'Unlock Prompt Later to resume scheduling.') {
    super(message);
    this.code = 'VAULT_LOCKED';
  }
}

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

export function newVaultSalt() {
  return encode(cryptoApi.getRandomValues(new Uint8Array(16)));
}

export function validSession(session, salt) {
  try {
    return session?.salt === salt && decode(session.key, 32).length === 32;
  } catch {
    return false;
  }
}

export function validateEnvelope(value) {
  const keys = ['cipher', 'data', 'iterations', 'iv', 'kdf', 'salt', 'version'];
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== keys.join(',')
      || value.version !== 1 || value.kdf !== 'PBKDF2-SHA256' || value.iterations !== KDF_ITERATIONS
      || value.cipher !== 'AES-GCM-256') {
    throw new Error('The saved vault is unreadable or unsupported. Nothing was reset.');
  }
  decode(value.salt, 16);
  decode(value.iv, 12);
  if (decode(value.data).length < 16) throw new Error('The saved vault is incomplete. Nothing was reset.');
  return value;
}

function additionalData(salt) {
  return encoder.encode(`prompt-later:vault:1:PBKDF2-SHA256:${KDF_ITERATIONS}:${salt}`);
}

export async function deriveVaultKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024 || !passphrase.trim()) {
    throw new Error('Use a passphrase of 12–1,024 characters. A unique multi-word passphrase is recommended.');
  }
  const saltBytes = decode(salt, 16);
  const password = encoder.encode(passphrase);
  try {
    const material = await cryptoApi.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
    const bytes = new Uint8Array(await cryptoApi.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: KDF_ITERATIONS }, material, 256));
    try {
      return encode(bytes);
    } finally {
      bytes.fill(0);
    }
  } finally {
    password.fill(0);
  }
}

async function importAesKey(rawKey, usage) {
  const bytes = decode(rawKey, 32);
  try {
    return await cryptoApi.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage]);
  } finally {
    bytes.fill(0);
  }
}

export async function encryptState(state, rawKey, salt) {
  decode(salt, 16);
  const plaintext = encoder.encode(JSON.stringify(validateState(state)));
  try {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Saved data is too large for the encrypted vault. Existing data was left intact.');
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const key = await importAesKey(rawKey, 'encrypt');
    const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(salt), tagLength: 128 }, key, plaintext);
    return {
      version: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: KDF_ITERATIONS,
      salt,
      cipher: 'AES-GCM-256',
      iv: encode(iv),
      data: encode(new Uint8Array(ciphertext)),
    };
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptState(envelope, rawKey) {
  validateEnvelope(envelope);
  const key = await importAesKey(rawKey, 'decrypt');
  let plaintext;
  try {
    plaintext = new Uint8Array(await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv, 12), additionalData: additionalData(envelope.salt), tagLength: 128 }, key, decode(envelope.data)));
    return validateState(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw new Error('The passphrase is incorrect or the saved vault is damaged. Nothing was reset.');
  } finally {
    plaintext?.fill(0);
  }
}
