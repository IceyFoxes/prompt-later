export const DEVICE_KEY_ID = 'prompt-later.device-key.v1';

export function validDeviceKey(key) {
  return Boolean(key && (typeof globalThis.CryptoKey !== 'function' || key instanceof globalThis.CryptoKey)
    && key.type === 'secret' && key.algorithm?.name === 'AES-GCM'
    && key.algorithm.length === 256 && key.extractable === false
    && Array.isArray(key.usages) && key.usages.length === 2
    && key.usages.includes('encrypt') && key.usages.includes('decrypt'));
}

export function createDeviceKeyStore(database = globalThis.indexedDB, cryptoApi = globalThis.crypto) {
  const open = () => new Promise((resolve, reject) => {
    if (!database || !cryptoApi?.subtle) return reject(new Error('Automatic encryption storage is unavailable. Nothing was reset.'));
    const request = database.open('prompt-later-keys', 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore('keys', { keyPath: 'id' });
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Automatic encryption storage is blocked. Close other Prompt Later pages and try again.'));
    };
    request.onerror = () => reject(request.error || new Error('Automatic encryption storage could not open.'));
    request.onsuccess = () => {
      if (blocked) return request.result.close();
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  const transact = async (mode, operation) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', mode, { durability: 'strict' });
        let value;
        let failure;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(failure || tx.error || new Error('Automatic encryption storage transaction failed.'));
        tx.onerror = () => { failure ||= tx.error; };
        try {
          const request = operation(tx.objectStore('keys'));
          request.onsuccess = () => { value = request.result; };
          request.onerror = () => { failure = request.error; };
        } catch (error) {
          failure = error;
          tx.abort();
        }
      });
    } finally {
      db.close();
    }
  };
  const read = async id => {
    const record = await transact('readonly', store => store.get(id));
    if (record === undefined) return null;
    if (!record || Object.keys(record).sort().join(',') !== 'id,key' || record.id !== id || !validDeviceKey(record.key)) {
      throw new Error('The saved automatic encryption key is invalid. Nothing was reset.');
    }
    return record.key;
  };
  return {
    get: (id = DEVICE_KEY_ID) => read(id),
    getOrCreate: async (id = DEVICE_KEY_ID) => {
      const existing = await read(id);
      if (existing) return existing;
      const key = await cryptoApi.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      try {
        await transact('readwrite', store => store.add({ id, key }));
      } catch (error) {
        if (error?.name !== 'ConstraintError') throw error;
      }
      const persisted = await read(id);
      if (!persisted) throw new Error('The automatic encryption key did not persist. Nothing was reset.');
      return persisted;
    },
  };
}
