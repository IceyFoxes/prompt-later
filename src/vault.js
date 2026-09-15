import { emptyState, STORAGE_KEY, validateState } from './store.js';
import { createDeviceKeyStore } from './device-key-store.js';
import { VAULT_KEY, SESSION_KEY, VaultLockedError, decryptDeviceState, decryptState, deriveVaultKey, encryptDeviceState, encryptState, newVaultSalt, validSession, vaultMode } from './vault-crypto.js';

export const STAGED_KEY = 'prompt-later.vault-next.v1';
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
  const session = async () => (await api.storage.session.get(SESSION_KEY))[SESSION_KEY];
  const statusFor = (mode, locked, data) => ({ configured: true, mode, locked, legacyData: has(data, STORAGE_KEY) });
  const decrypt = (envelope, key) => vaultMode(envelope) === 'device' ? decryptDeviceState(envelope, key) : decryptState(envelope, key);

  function checkLegacy(data, state) {
    if (has(data, STORAGE_KEY) && !sameState(data[STORAGE_KEY], state)) throw conflict();
  }

  async function unchanged(expected, keys = [VAULT_KEY, STORAGE_KEY, STAGED_KEY]) {
    const latest = await records();
    if (keys.some(key => has(latest, key) !== has(expected, key) || !same(latest[key], expected[key]))) throw conflict();
    return latest;
  }

  async function passphraseKey(envelope, passphrase) {
    if (passphrase !== undefined) return deriveVaultKey(passphrase, envelope.salt);
    const cached = await session();
    return validSession(cached, envelope.salt) ? cached.key : null;
  }

  async function cleanLegacy(state, envelope, key) {
    const data = await records();
    if (!has(data, STORAGE_KEY)) return;
    checkLegacy(data, state);
    if (!same(data[VAULT_KEY], envelope) || !sameState(await decrypt(data[VAULT_KEY], key), state)) throw verificationError();
    await unchanged(data);
    await api.storage.local.remove(STORAGE_KEY);
    if (has(await records(), STORAGE_KEY)) throw new Error('The legacy copy could not be removed. Try again to finish migration; saved copies were preserved.');
  }

  function stageInfo(data) {
    const stage = data[STAGED_KEY];
    if (!stage || Object.keys(stage).sort().join(',') !== 'envelope,sourceIv,version' || stage.version !== 1
        || (stage.sourceIv !== null && (typeof stage.sourceIv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(stage.sourceIv)))) {
      throw new Error('The unfinished encrypted migration is unreadable. Saved copies were preserved.');
    }
    const mode = vaultMode(stage.envelope);
    const source = data[VAULT_KEY];
    const committed = has(data, VAULT_KEY) && source?.iv === stage.envelope.iv;
    if (!committed && (stage.sourceIv === null ? has(data, VAULT_KEY) : !source || source.iv !== stage.sourceIv)) throw conflict();
    if (!committed && source && vaultMode(source) === mode) throw conflict();
    if (!source && mode !== 'device') throw conflict();
    return { stage, mode, source, committed };
  }

  async function finishStage(data, passphrase, suppliedKey) {
    const { stage, mode, source, committed } = stageInfo(data);
    const envelope = stage.envelope;
    const passwordEnvelope = mode === 'passphrase' ? envelope : !committed && source ? source : null;
    const passwordKey = passwordEnvelope ? suppliedKey || await passphraseKey(passwordEnvelope, passphrase) : null;
    if (passwordEnvelope && !passwordKey) return { status: statusFor('passphrase', true, data) };
    const key = mode === 'device' ? await deviceKeys.get(envelope.keyId) : passwordKey;
    const state = await decrypt(envelope, key);
    if (source && !committed) {
      const sourceKey = mode === 'device' ? passwordKey : await deviceKeys.get(source.keyId);
      if (!sameState(await decrypt(source, sourceKey), state)) throw conflict();
    }
    checkLegacy(data, state);
    await unchanged(data);
    if (!same(source, envelope)) await api.storage.local.set({ [VAULT_KEY]: envelope });
    const persisted = await records();
    if (!same(persisted[STAGED_KEY], stage) || !same(persisted[VAULT_KEY], envelope)
        || !sameState(await decrypt(persisted[VAULT_KEY], key), state)) throw verificationError();
    checkLegacy(persisted, state);
    await api.storage.local.remove(STAGED_KEY);
    const cleaned = await records();
    if (has(cleaned, STAGED_KEY) || !same(cleaned[VAULT_KEY], envelope)) throw verificationError();
    await cleanLegacy(state, envelope, key);
    if (mode === 'passphrase') await api.storage.session.set({ [SESSION_KEY]: { salt: envelope.salt, key } });
    else await api.storage.session.remove(SESSION_KEY);
    return { status: statusFor(mode, false, {}), envelope, key, state };
  }

  async function stageTransition(data, envelope, state, key) {
    await unchanged(data);
    const stage = { version: 1, sourceIv: data[VAULT_KEY]?.iv ?? null, envelope };
    await api.storage.local.set({ [STAGED_KEY]: stage });
    const persisted = await records();
    if (!same(persisted[STAGED_KEY], stage) || !sameState(await decrypt(persisted[STAGED_KEY]?.envelope, key), state)) throw verificationError();
    await unchanged(data, [VAULT_KEY, STORAGE_KEY]);
    return finishStage(persisted, undefined, vaultMode(envelope) === 'passphrase' ? key : undefined);
  }

  async function access(passphrase) {
    const data = await records();
    if (has(data, STAGED_KEY)) return finishStage(data, passphrase);
    if (!has(data, VAULT_KEY)) {
      const state = has(data, STORAGE_KEY) ? validateState(data[STORAGE_KEY]) : emptyState();
      const key = await deviceKeys.getOrCreate();
      return stageTransition(data, await encryptDeviceState(state, key), state, key);
    }
    const envelope = data[VAULT_KEY];
    const mode = vaultMode(envelope);
    if (mode === 'passphrase' && passphrase === undefined && has(data, STORAGE_KEY)) {
      return { status: statusFor(mode, true, data) };
    }
    const key = mode === 'device' ? await deviceKeys.get(envelope.keyId) : await passphraseKey(envelope, passphrase);
    if (mode === 'passphrase' && !key) return { status: statusFor(mode, true, data) };
    const state = await decrypt(envelope, key);
    await cleanLegacy(state, envelope, key);
    if (mode === 'passphrase' && passphrase !== undefined) await api.storage.session.set({ [SESSION_KEY]: { salt: envelope.salt, key } });
    return { status: statusFor(mode, false, {}), envelope, key, state };
  }

  async function unlocked() {
    const current = await access();
    if (current.status.locked) throw new VaultLockedError();
    return current;
  }

  async function sourceRecords(current) {
    const data = await records();
    if (has(data, STAGED_KEY) || has(data, STORAGE_KEY) || !same(data[VAULT_KEY], current.envelope)) throw conflict();
    return data;
  }

  return {
    initialize: () => serial(async () => (await access()).status),
    status: () => serial(async () => (await access()).status),
    unlock: passphrase => serial(async () => {
      const data = await records();
      let passwordMode;
      if (has(data, STAGED_KEY)) {
        const { mode, source, committed } = stageInfo(data);
        passwordMode = mode === 'passphrase' || (!committed && source && vaultMode(source) === 'passphrase');
      } else passwordMode = has(data, VAULT_KEY) && vaultMode(data[VAULT_KEY]) === 'passphrase';
      if (!passwordMode) throw new Error('Automatic device protection does not require a passphrase. Nothing was reset.');
      if (typeof passphrase !== 'string') throw new Error('Enter your passphrase to unlock.');
      return (await access(passphrase)).status;
    }),
    enablePassphrase: passphrase => serial(async () => {
      const current = await unlocked();
      if (current.status.mode !== 'device') throw new Error('Passphrase protection is already enabled. Nothing was replaced.');
      const data = await sourceRecords(current);
      const salt = newVaultSalt();
      const key = await deriveVaultKey(passphrase, salt);
      const envelope = await encryptState(current.state, key, salt);
      return (await stageTransition(data, envelope, current.state, key)).status;
    }),
    disablePassphrase: () => serial(async () => {
      const current = await unlocked();
      if (current.status.mode !== 'passphrase') throw new Error('Passphrase protection is not enabled.');
      const data = await sourceRecords(current);
      const key = await deviceKeys.getOrCreate();
      const envelope = await encryptDeviceState(current.state, key);
      return (await stageTransition(data, envelope, current.state, key)).status;
    }),
    read: () => serial(async () => (await unlocked()).state),
    write: state => serial(async () => {
      const current = await unlocked();
      const data = await sourceRecords(current);
      const envelope = current.status.mode === 'device'
        ? await encryptDeviceState(state, current.key, current.envelope.keyId)
        : await encryptState(state, current.key, current.envelope.salt);
      await unchanged(data);
      await api.storage.local.set({ [VAULT_KEY]: envelope });
    }),
  };
}
