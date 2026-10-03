/**
 * Error taxonomy (TDD §6.3). Adapters MUST map backend errors to one of these
 * codes; an unmapped backend error becomes `UNKNOWN` with the original attached
 * (never swallowed).
 */

export type StorageErrorCode =
  | 'NOT_FOUND'
  /** bot not admin / channel inaccessible. */
  | 'ACCESS_LOST'
  | 'FLOOD_WAIT_EXCEEDED'
  /** decryption / auth-tag failure (tamper, truncation, reorder, wrong key). */
  | 'INTEGRITY'
  | 'RANGE_INVALID'
  | 'CONFIG'
  | 'UNKNOWN';

export interface StorageErrorOptions {
  /** seconds to wait, for FLOOD_WAIT_EXCEEDED. */
  waitSeconds?: number;
  /** the underlying backend error, preserved for diagnostics. */
  cause?: unknown;
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly waitSeconds?: number;

  constructor(code: StorageErrorCode, message?: string, options: StorageErrorOptions = {}) {
    super(message ?? code, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'StorageError';
    this.code = code;
    if (options.waitSeconds !== undefined) this.waitSeconds = options.waitSeconds;
    // Keep prototype chain correct when targeting older runtimes.
    Object.setPrototypeOf(this, StorageError.prototype);
  }

  static is(e: unknown, code?: StorageErrorCode): e is StorageError {
    return e instanceof StorageError && (code === undefined || e.code === code);
  }
}

/** Wrap an unknown thrown value as a StorageError, preserving a mapped error as-is. */
export function toStorageError(e: unknown, fallback: StorageErrorCode = 'UNKNOWN'): StorageError {
  if (e instanceof StorageError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new StorageError(fallback, message, { cause: e });
}
