import { emptyState, STORAGE_KEY, validateState } from './store.js';
import { VAULT_KEY, SESSION_KEY, VaultLockedError, decryptState, deriveVaultKey, encryptState, newVaultSalt, validSession, validateEnvelope } from './vault-crypto.js';

export function createVaultStore(api) {
  let queue = Promise.resolve();
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const records = () => api.storage.local.get([VAULT_KEY, STORAGE_KEY]);
  const session = async () => (await api.storage.session.get(SESSION_KEY))[SESSION_KEY];
  const has = (data, key) => Object.hasOwn(data, key);
  const sameState = (left, right) => JSON.stringify(validateState(left)) === JSON.stringify(validateState(right));
  async function status() {
    const data = await records();
    const legacyData = has(data, STORAGE_KEY);
    if (!has(data, VAULT_KEY)) return { configured: false, locked: true, legacyData };
    const envelope = validateEnvelope(data[VAULT_KEY]);
    return { configured: true, locked: legacyData || !validSession(await session(), envelope.salt), legacyData };
  }
  async function keyFor(envelope) {
    const cached = await session();
    if (!validSession(cached, envelope.salt)) throw new VaultLockedError();
    return cached.key;
  }
  async function cleanLegacy(state) {
    const data = await records();
    if (!has(data, STORAGE_KEY)) return;
    if (!sameState(data[STORAGE_KEY], state)) throw new Error('Legacy schedules changed during migration. Both copies were left intact.');
    await api.storage.local.remove(STORAGE_KEY);
    if (has(await records(), STORAGE_KEY)) throw new Error('The legacy copy could not be removed. Unlock again to finish migration.');
  }
  return {
    status: () => serial(status),
    setup: passphrase => serial(async () => {
      const data = await records();
      if (has(data, VAULT_KEY)) throw new Error('A vault already exists. Unlock it instead; nothing was replaced.');
      const state = has(data, STORAGE_KEY) ? validateState(data[STORAGE_KEY]) : emptyState();
      const salt = newVaultSalt();
      const key = await deriveVaultKey(passphrase, salt);
      const envelope = await encryptState(state, key, salt);
      const latest = await records();
      if (has(latest, VAULT_KEY)) throw new Error('A vault already exists. Nothing was replaced.');
      const latestState = has(latest, STORAGE_KEY) ? validateState(latest[STORAGE_KEY]) : emptyState();
      if (!sameState(latestState, state)) throw new Error('Saved schedules changed during setup. Try again; existing data was left intact.');
      await api.storage.local.set({ [VAULT_KEY]: envelope });
      const persisted = (await records())[VAULT_KEY];
      if (!sameState(await decryptState(persisted, key), state)) throw new Error('The encrypted copy did not verify. Existing data was left intact.');
      await cleanLegacy(state);
      await api.storage.session.set({ [SESSION_KEY]: { salt, key } });
      return status();
    }),
    unlock: passphrase => serial(async () => {
      const data = await records();
      if (!has(data, VAULT_KEY)) throw new VaultLockedError('Set up a passphrase before scheduling messages.');
      const envelope = validateEnvelope(data[VAULT_KEY]);
      const key = await deriveVaultKey(passphrase, envelope.salt);
      const state = await decryptState(envelope, key);
      await cleanLegacy(state);
      await api.storage.session.set({ [SESSION_KEY]: { salt: envelope.salt, key } });
      return status();
    }),
    read: () => serial(async () => {
      const data = await records();
      if (!has(data, VAULT_KEY)) throw new VaultLockedError('Set up a passphrase before scheduling messages.');
      if (has(data, STORAGE_KEY)) throw new VaultLockedError('Unlock to finish migrating your saved messages.');
      const envelope = validateEnvelope(data[VAULT_KEY]);
      return decryptState(envelope, await keyFor(envelope));
    }),
    write: state => serial(async () => {
      const data = await records();
      if (!has(data, VAULT_KEY) || has(data, STORAGE_KEY)) throw new VaultLockedError();
      const previous = validateEnvelope(data[VAULT_KEY]);
      const key = await keyFor(previous);
      await decryptState(previous, key);
      const envelope = await encryptState(state, key, previous.salt);
      await api.storage.local.set({ [VAULT_KEY]: envelope });
    }),
  };
}
