import { createVaultStore } from '../../src/vault.js';
const store = createVaultStore(chrome);
export const readState = () => store.read();
export const writeState = state => store.write(state);
