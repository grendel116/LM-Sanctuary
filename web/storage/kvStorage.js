/**
 * Compatibility facade forwarding all persistence helpers to web/storage/nativeStore.js.
 * Local SQLite and OS Keychain / Android Keystore handle storage — zero browser IDB.
 */

export * from './nativeStore.js';
