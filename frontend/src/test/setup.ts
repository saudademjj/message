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
