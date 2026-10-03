/**
 * `@shivam-dhyani/unified-storage` — one storage API over many backends with
 * built-in encryption (TDD §6).
 */

// Core contracts
export type {
  AdapterKind,
  ObjectRef,
  PutInput,
  RangeRequest,
  StorageAdapter,
  MetricEvent,
  MetricOp,
  MetricsHook,
} from './types.js';

// Errors
export { StorageError, toStorageError } from './errors.js';
export type { StorageErrorCode, StorageErrorOptions } from './errors.js';

// Encryption layer
export {
  createEncryptedStore,
  encryptedSize,
  constantTimeEqual,
} from './crypto/encrypted-store.js';
export type { EncryptedStoreOptions } from './crypto/encrypted-store.js';
export { parseKeyring, keyringFromKeys } from './crypto/keyring.js';
export type { KeyProvider } from './crypto/keyring.js';

// R2 adapter
export { createR2Adapter } from './adapters/r2/index.js';
export type { R2Adapter, R2AdapterOptions, Presigner } from './adapters/r2/index.js';

// Telegram adapter
export { createTelegramAdapter } from './adapters/telegram/index.js';
export type { TelegramAdapter, TelegramAdapterOptions } from './adapters/telegram/index.js';
export type {
  TelegramBackend,
  TgDocument,
  ChannelHandle,
} from './adapters/telegram/backend.js';
export { planGetFileRequests, isCompliant } from './adapters/telegram/range.js';
