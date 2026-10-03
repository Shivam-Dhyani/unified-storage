/**
 * In-memory StorageAdapter for unit tests: supports ranged get, and exposes the
 * raw stored bytes so tests can tamper / truncate / swap them.
 */

import type { ObjectRef, PutInput, RangeRequest, StorageAdapter } from '../../src/types.js';
import { StorageError } from '../../src/errors.js';

export interface MemoryAdapter extends StorageAdapter {
  rawOf(ref: ObjectRef): Buffer;
  setRaw(ref: ObjectRef, buf: Buffer): void;
}

export function createMemoryAdapter(): MemoryAdapter {
  const store = new Map<string, Buffer>();
  let counter = 0;

  return {
    kind: 'r2',

    async put(input: PutInput): Promise<ObjectRef> {
      const key = input.key ?? `obj-${++counter}`;
      const buf = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
      const copy = Buffer.from(buf);
      store.set(key, copy);
      return { adapter: 'r2', container: input.container, key, size: copy.length };
    },

    async get(ref: ObjectRef, range?: RangeRequest): Promise<Uint8Array> {
      const buf = store.get(ref.key);
      if (!buf) throw new StorageError('NOT_FOUND', `no object ${ref.key}`);
      if (!range) return Buffer.from(buf);
      return Buffer.from(buf.subarray(range.offset, range.offset + range.length));
    },

    async delete(ref: ObjectRef): Promise<void> {
      store.delete(ref.key);
    },

    async stat(ref: ObjectRef): Promise<{ exists: boolean; size?: number }> {
      const buf = store.get(ref.key);
      return buf ? { exists: true, size: buf.length } : { exists: false };
    },

    async close(): Promise<void> {
      store.clear();
    },

    rawOf(ref: ObjectRef): Buffer {
      const buf = store.get(ref.key);
      if (!buf) throw new StorageError('NOT_FOUND', `no object ${ref.key}`);
      return buf;
    },

    setRaw(ref: ObjectRef, buf: Buffer): void {
      store.set(ref.key, Buffer.from(buf));
    },
  };
}
