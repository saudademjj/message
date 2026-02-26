import { webcrypto } from 'node:crypto';
import 'fake-indexeddb/auto';

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

if (!globalThis.window) {
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    configurable: true,
  });
}

Object.defineProperty(globalThis.window, 'isSecureContext', {
  value: true,
  configurable: true,
});

if (!globalThis.window.crypto) {
  Object.defineProperty(globalThis.window, 'crypto', {
    value: globalThis.crypto,
    configurable: true,
  });
}

if (!globalThis.window.indexedDB) {
  Object.defineProperty(globalThis.window, 'indexedDB', {
    value: globalThis.indexedDB,
    configurable: true,
  });
}

if (
  !('localStorage' in globalThis.window)
  || typeof globalThis.window.localStorage?.getItem !== 'function'
  || typeof globalThis.window.localStorage?.setItem !== 'function'
  || typeof globalThis.window.localStorage?.removeItem !== 'function'
  || typeof globalThis.window.localStorage?.clear !== 'function'
) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis.window, 'localStorage', {
    value: {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        return store.has(key) ? store.get(key)! : null;
      },
      key(index: number) {
        if (index < 0 || index >= store.size) {
          return null;
        }
        return [...store.keys()][index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
    } as Storage,
    configurable: true,
  });
}

if (!globalThis.btoa) {
  Object.defineProperty(globalThis, 'btoa', {
    value: (input: string) => Buffer.from(input, 'binary').toString('base64'),
    configurable: true,
  });
}

if (!globalThis.atob) {
  Object.defineProperty(globalThis, 'atob', {
    value: (input: string) => Buffer.from(input, 'base64').toString('binary'),
    configurable: true,
  });
}
