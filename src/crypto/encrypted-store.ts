/**
 * `createEncryptedStore(adapter, keyProvider)` wraps any `StorageAdapter` so that
 * `put` encrypts and `get(ref, range)` takes **plaintext** offsets and decrypts
 * only the chunks that cover them (TDD §6.4).
 *
 * Envelope encryption: a fresh random 32-byte DEK per object, AES-256-GCM, wrapped
 * with the active KEK. Headers (incl. the unwrapped DEK) are cached per ref in a
 * small in-memory LRU so ranged reads do not re-fetch/unwrap on every call.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { StorageError } from '../errors.js';
import type { ObjectRef, PutInput, RangeRequest, StorageAdapter } from '../types.js';
import {
  chunkAad,
  chunkCount,
  chunkNonce,
  chunkPlainLen,
  chunkStoredLen,
  chunkStoredOffset,
  DEFAULT_CHUNK_SIZE_LOG2,
  DEK_SIZE,
  HEADER_SIZE,
  KEK_ID_SIZE,
  MAGIC,
  NONCE_PREFIX_SIZE,
  OFF,
  parseHeader,
  type ParsedHeader,
  TAG_SIZE,
  totalStoredSize,
  VERSION,
  WRAP_AAD_END,
  WRAP_NONCE_SIZE,
} from './format.js';
import type { KeyProvider } from './keyring.js';

export interface EncryptedStoreOptions {
  /** max parsed headers to cache (default 1000, TDD §6.4). */
  headerCacheMax?: number;
}

/** A parsed header plus its unwrapped DEK, ready to decrypt chunks. */
interface OpenHeader {
  header: ParsedHeader;
  dek: Buffer;
}

function refCacheKey(ref: ObjectRef): string {
  return `${ref.adapter}:${ref.container}:${ref.key}`;
}

/** Minimal insertion-ordered LRU. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  delete(k: string): void {
    this.map.delete(k);
  }
}

function gcmDecrypt(key: Buffer, nonce: Buffer, aad: Buffer, ct: Buffer, tag: Buffer): Buffer {
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch (e) {
    throw new StorageError('INTEGRITY', 'authentication failed while decrypting', { cause: e });
  }
}

export function createEncryptedStore(
  adapter: StorageAdapter,
  keyProvider: KeyProvider,
  options: EncryptedStoreOptions = {},
): StorageAdapter {
  const headerCache = new Lru<OpenHeader>(options.headerCacheMax ?? 1000);

  function buildEncrypted(data: Uint8Array): Buffer {
    const chunkSizeLog2 = DEFAULT_CHUNK_SIZE_LOG2;
    const C = 1 << chunkSizeLog2;
    const plaintext = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const plaintextSize = plaintext.length;

    const kekId = keyProvider.activeId;
    const kek = keyProvider.get(kekId);
    if (!kek) throw new StorageError('CONFIG', `active KEK "${kekId}" not available`);

    const dek = randomBytes(DEK_SIZE);
    const noncePrefix = randomBytes(NONCE_PREFIX_SIZE);
    const wrapNonce = randomBytes(WRAP_NONCE_SIZE);

    // Assemble the header. Everything except the wrapped DEK/tag is written first
    // because the wrap AAD covers bytes [0, 42) (which already includes wrapNonce).
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, OFF.magic);
    header[OFF.version] = VERSION;
    header[OFF.chunkSizeLog2] = chunkSizeLog2;
    header.write(kekId, OFF.kekId, KEK_ID_SIZE, 'ascii');
    noncePrefix.copy(header, OFF.noncePrefix);
    wrapNonce.copy(header, OFF.wrapNonce);
    header.writeBigUInt64BE(BigInt(plaintextSize), OFF.plaintextSize);

    // Wrap the DEK under the KEK.
    const wrap = createCipheriv('aes-256-gcm', kek, wrapNonce);
    wrap.setAAD(header.subarray(0, WRAP_AAD_END));
    const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
    const wrapTag = wrap.getAuthTag();
    wrappedDek.copy(header, OFF.wrappedDek);
    wrapTag.copy(header, OFF.wrapTag);

    // Encrypt chunks. The header is now final, so it can serve as chunk AAD.
    const n = chunkCount(plaintextSize, C);
    const out: Buffer[] = [header];
    for (let i = 0; i < n; i++) {
      const start = i * C;
      const end = Math.min(start + C, plaintextSize);
      const slice = plaintext.subarray(start, end);
      const isFinal = i === n - 1;
      const c = createCipheriv('aes-256-gcm', dek, chunkNonce(noncePrefix, i));
      c.setAAD(chunkAad(header, i, isFinal));
      const ct = Buffer.concat([c.update(slice), c.final()]);
      out.push(ct, c.getAuthTag());
    }
    return Buffer.concat(out);
  }

  /** Fetch (or reuse) the parsed header and unwrapped DEK for a ref. */
  async function openHeader(ref: ObjectRef): Promise<OpenHeader> {
    const cacheKey = refCacheKey(ref);
    const cached = headerCache.get(cacheKey);
    if (cached) return cached;

    const raw = await adapter.get(ref, { offset: 0, length: HEADER_SIZE });
    const header = parseHeader(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));

    const kek = keyProvider.get(header.kekId);
    if (!kek) {
      throw new StorageError('CONFIG', `KEK "${header.kekId}" named in object is not in the keyring`);
    }
    const dek = gcmDecrypt(
      kek,
      header.wrapNonce,
      header.raw.subarray(0, WRAP_AAD_END),
      header.wrappedDek,
      header.wrapTag,
    );
    if (dek.length !== DEK_SIZE) {
      throw new StorageError('INTEGRITY', 'unwrapped DEK has wrong length');
    }
    const open: OpenHeader = { header, dek };
    headerCache.set(cacheKey, open);
    return open;
  }

  function decryptChunk(open: OpenHeader, i: number, stored: Buffer, atOffset: number): Buffer {
    const { header, dek } = open;
    const C = header.chunkSize;
    const n = chunkCount(header.plaintextSize, C);
    const plainLen = chunkPlainLen(i, header.plaintextSize, C);
    const ct = stored.subarray(atOffset, atOffset + plainLen);
    const tag = stored.subarray(atOffset + plainLen, atOffset + plainLen + TAG_SIZE);
    if (ct.length !== plainLen || tag.length !== TAG_SIZE) {
      throw new StorageError('INTEGRITY', `chunk ${i} truncated`);
    }
    return gcmDecrypt(dek, chunkNonce(header.noncePrefix, i), chunkAad(header.raw, i, i === n - 1), ct, tag);
  }

  return {
    kind: adapter.kind,

    async put(input: PutInput): Promise<ObjectRef> {
      const encrypted = buildEncrypted(input.data);
      const ref = await adapter.put({ ...input, data: encrypted });
      return { ...ref, meta: { ...ref.meta, encrypted: '1' } };
    },

    async get(ref: ObjectRef, range?: RangeRequest): Promise<Uint8Array> {
      const open = await openHeader(ref);
      const { header } = open;
      const C = header.chunkSize;
      const n = chunkCount(header.plaintextSize, C);
      const total = header.plaintextSize;

      const offset = range ? range.offset : 0;
      const length = range ? range.length : total;

      if (offset < 0 || length < 0) {
        throw new StorageError('RANGE_INVALID', `negative range offset=${offset} length=${length}`);
      }
      if (offset + length > total) {
        throw new StorageError(
          'RANGE_INVALID',
          `range [${offset}, ${offset + length}) exceeds plaintext size ${total}`,
        );
      }
      if (length === 0) return Buffer.alloc(0);

      const i0 = Math.floor(offset / C);
      const i1 = Math.floor((offset + length - 1) / C);

      const startByte = chunkStoredOffset(i0, C);
      const endByte = chunkStoredOffset(i1, C) + chunkStoredLen(i1, total, C);
      const storedChunks = Buffer.from(
        await adapter.get(ref, { offset: startByte, length: endByte - startByte }),
      );

      const plains: Buffer[] = [];
      let local = 0;
      for (let i = i0; i <= i1; i++) {
        plains.push(decryptChunk(open, i, storedChunks, local));
        local += chunkStoredLen(i, total, C);
      }
      const joined = Buffer.concat(plains);
      const sliceStart = offset - i0 * C;
      return joined.subarray(sliceStart, sliceStart + length);
    },

    async delete(ref: ObjectRef): Promise<void> {
      headerCache.delete(refCacheKey(ref));
      await adapter.delete(ref);
    },

    async stat(ref: ObjectRef): Promise<{ exists: boolean; size?: number }> {
      return adapter.stat(ref);
    },

    async close(): Promise<void> {
      await adapter.close();
    },
  };
}

/** Exposed for callers that need to size an encrypted object before storing it. */
export function encryptedSize(plaintextSize: number): number {
  return totalStoredSize(plaintextSize, 1 << DEFAULT_CHUNK_SIZE_LOG2);
}

/** Constant-time compare helper (re-exported for adapters that verify tokens). */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
