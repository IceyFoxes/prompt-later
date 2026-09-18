import { createVaultStore } from '../../src/vault.js';
export { createDeviceKeyStore, DEVICE_KEY_ID } from '../../src/device-key-store.js';
const store = createVaultStore(chrome);
export const readState = () => store.read();
export const writeState = state => store.write(state);
