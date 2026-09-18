import { emptyState, repairState, STORAGE_KEY, validateState } from './store.js';
import { createDeviceKeyStore } from './device-key-store.js';
import { VAULT_KEY, decryptDevicePayload, decryptDeviceState, encryptDeviceState, vaultMode } from './vault-crypto.js';

export const STAGED_KEY = 'prompt-later.vault-next.v1';
export const BACKUP_KEY = 'prompt-later.vault-unreadable.v1';
const queues = new WeakMap();
const has = (data, key) => Object.hasOwn(data, key);
function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && left.length !== right.length) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => has(right, key) && same(left[key], right[key]));
}
const sameState = (left, right) => same(validateState(left), validateState(right));
const conflict = () => new Error('Saved data changed or conflicts with an unfinished migration. Saved copies were preserved.');
const verificationError = () => new Error('The encrypted copy did not verify. Saved copies were preserved.');

export function createVaultStore(api, deviceKeys = createDeviceKeyStore()) {
  const serial = operation => {
    const result = (queues.get(api) || Promise.resolve()).then(() => {
      const locks = globalThis.navigator?.locks;
      return locks ? locks.request('prompt-later-vault', operation) : operation();
    });
    queues.set(api, result.catch(() => {}));
    return result;
  };
  const records = () => api.storage.local.get([VAULT_KEY, STORAGE_KEY, STAGED_KEY]);
  const readyStatus = (dropped = []) => ({ configured: true, mode: 'device', legacyData: false, dropped });

  async function unchanged(expected, keys = [VAULT_KEY, STORAGE_KEY, STAGED_KEY]) {
    const latest = await records();
    if (keys.some(key => has(latest, key) !== has(expected, key) || !same(latest[key], expected[key]))) throw conflict();
    return latest;
  }

  function checkLegacy(data, state) {
    if (has(data, STORAGE_KEY) && !sameState(data[STORAGE_KEY], state)) throw conflict();
  }

  // Encrypt, store, then prove the bytes that actually landed decrypt back to
  // what we meant to save. Every write is verified, not just migrations.
  async function publish(state, key, expected) {
    const envelope = await encryptDeviceState(state, key);
    await unchanged(expected);
    await api.storage.local.set({ [VAULT_KEY]: envelope });
    const persisted = await records();
    if (!same(persisted[VAULT_KEY], envelope) || !sameState(await decryptDeviceState(persisted[VAULT_KEY], key), state)) {
      throw verificationError();
    }
    return { envelope, persisted };
  }

  // Plaintext is removed only once the encrypted copy is confirmed to hold the
  // same data, so an interrupted migration always leaves something readable.
  async function cleanLegacy(state, envelope, key, data) {
    if (!has(data, STORAGE_KEY)) return;
    checkLegacy(data, state);
    if (!same(data[VAULT_KEY], envelope) || !sameState(await decryptDeviceState(data[VAULT_KEY], key), state)) throw verificationError();
    await api.storage.local.remove(STORAGE_KEY);
    if (has(await records(), STORAGE_KEY)) {
      throw new Error('The legacy copy could not be removed. Try again to finish migration; saved copies were preserved.');
    }
  }

  // Keep the first record that needed repair, so the entries left out of the
  // usable state are still recoverable rather than lost on the next write.
  async function keepUnreadable(envelope) {
    const existing = await api.storage.local.get(BACKUP_KEY);
    if (!has(existing, BACKUP_KEY)) await api.storage.local.set({ [BACKUP_KEY]: envelope });
  }

  // A staged record can only be left over from an interrupted migration by an
  // older version. Once a verified vault exists it holds nothing unique.
  async function dropStage(data) {
    if (has(data, STAGED_KEY)) await api.storage.local.remove(STAGED_KEY);
  }

  async function access() {
    const data = await records();
    if (has(data, VAULT_KEY)) {
      const envelope = data[VAULT_KEY];
      vaultMode(envelope);
      const key = await deviceKeys.get(envelope.keyId);
      // A damaged record or wrong key still fails here, unrepaired.
      const payload = await decryptDevicePayload(envelope, key);
      let state;
      let dropped = [];
      try {
        state = validateState(payload);
      } catch {
        ({ state, dropped } = repairState(payload));
        await keepUnreadable(envelope);
      }
      await cleanLegacy(state, envelope, key, data);
      await dropStage(data);
      return { status: readyStatus(dropped), envelope, key, state };
    }
    const key = await deviceKeys.getOrCreate();
    const state = has(data, STORAGE_KEY) ? validateState(data[STORAGE_KEY]) : emptyState();
    const { envelope, persisted } = await publish(state, key, data);
    await cleanLegacy(state, envelope, key, persisted);
    await dropStage(persisted);
    return { status: readyStatus(), envelope, key, state };
  }

  return {
    initialize: () => serial(async () => (await access()).status),
    status: () => serial(async () => (await access()).status),
    read: () => serial(async () => (await access()).state),
    write: state => serial(async () => {
      const current = await access();
      const data = await records();
      if (has(data, STAGED_KEY) || has(data, STORAGE_KEY) || !same(data[VAULT_KEY], current.envelope)) throw conflict();
      await publish(state, current.key, data);
    }),
  };
}
