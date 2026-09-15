import { createVaultStore } from '../../src/vault.js';
import { VAULT_KEY, SESSION_KEY, deriveVaultKey, encryptState, newVaultSalt } from '../../src/vault-crypto.js';
export { createDeviceKeyStore, DEVICE_KEY_ID } from '../../src/device-key-store.js';
const store = createVaultStore(chrome);
export const readState = () => store.read();
export const writeState = state => store.write(state);
export async function seedPassphraseState(state, passphrase) {
  const salt = newVaultSalt();
  const key = await deriveVaultKey(passphrase, salt);
  await chrome.storage.local.set({ [VAULT_KEY]: await encryptState(state, key, salt) });
  await chrome.storage.session.remove(SESSION_KEY);
}
