/**
 * Key-encryption-key (KEK) ring (TDD §6.4).
 *
 * `parseKeyring('id1:base64,id2:base64')` → a `KeyProvider`. The first entry is
 * the active KEK used for new objects; any listed KEK can decrypt an object whose
 * header names it, which is what enables key rotation.
 */

import { StorageError } from '../errors.js';
import { DEK_SIZE, validateKekId } from './format.js';

export interface KeyProvider {
  /** id of the KEK used to wrap new DEKs. */
  readonly activeId: string;
  /** 32-byte KEK for `id`, or undefined if this ring does not hold it. */
  get(id: string): Buffer | undefined;
  /** all known KEK ids (active first). */
  ids(): string[];
}

export function parseKeyring(spec: string): KeyProvider {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new StorageError('CONFIG', 'keyring spec is empty');
  }
  const entries = spec.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (entries.length === 0) {
    throw new StorageError('CONFIG', 'keyring spec has no entries');
  }

  const keys = new Map<string, Buffer>();
  const order: string[] = [];

  for (const entry of entries) {
    const sep = entry.indexOf(':');
    if (sep <= 0) {
      throw new StorageError('CONFIG', `keyring entry must be "id:base64": "${entry}"`);
    }
    const id = entry.slice(0, sep);
    const b64 = entry.slice(sep + 1);
    validateKekId(id);
    if (keys.has(id)) {
      throw new StorageError('CONFIG', `duplicate kekId in keyring: "${id}"`);
    }
    let key: Buffer;
    try {
      key = Buffer.from(b64, 'base64');
    } catch {
      throw new StorageError('CONFIG', `kekId "${id}" value is not valid base64`);
    }
    if (key.length !== DEK_SIZE) {
      throw new StorageError(
        'CONFIG',
        `kekId "${id}" must decode to ${DEK_SIZE} bytes, got ${key.length}`,
      );
    }
    keys.set(id, key);
    order.push(id);
  }

  const activeId = order[0]!;
  return {
    activeId,
    get: (id) => keys.get(id),
    ids: () => [...order],
  };
}

/** Build a KeyProvider from already-decoded 32-byte keys (first = active). */
export function keyringFromKeys(entries: Array<{ id: string; key: Buffer }>): KeyProvider {
  if (entries.length === 0) throw new StorageError('CONFIG', 'no keys provided');
  const keys = new Map<string, Buffer>();
  const order: string[] = [];
  for (const { id, key } of entries) {
    validateKekId(id);
    if (key.length !== DEK_SIZE) {
      throw new StorageError('CONFIG', `key "${id}" must be ${DEK_SIZE} bytes, got ${key.length}`);
    }
    if (keys.has(id)) throw new StorageError('CONFIG', `duplicate kekId: "${id}"`);
    keys.set(id, Buffer.from(key));
    order.push(id);
  }
  const activeId = order[0]!;
  return { activeId, get: (id) => keys.get(id), ids: () => [...order] };
}
