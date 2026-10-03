/**
 * Encrypted object layout, version 1 (TDD §6.4).
 *
 * Header (128 bytes), then chunks. Each chunk is AES-256-GCM ciphertext of up to
 * `C` plaintext bytes, followed by its 16-byte tag.
 *
 * ```
 *  offset  size  field
 *   0       4    magic "USE1"
 *   4       1    version = 1
 *   5       1    chunkSizeLog2 = 16   (C = 64 KiB)
 *   6      16    kekId (ASCII, NUL-padded)
 *  22       8    noncePrefix (random)
 *  30      12    wrapNonce (random)
 *  42      32    wrapped DEK (AES-256-GCM ciphertext of the DEK under the KEK)
 *  74      16    wrap tag
 *  90       8    plaintextSize (uint64 BE)
 *  98      30    reserved (zeros)
 * 128       —    chunk 0, chunk 1, ...
 * ```
 */

import { StorageError } from '../errors.js';

export const MAGIC = Buffer.from('USE1', 'ascii');
export const VERSION = 1;
export const HEADER_SIZE = 128;
export const TAG_SIZE = 16;
export const DEK_SIZE = 32;
export const WRAP_NONCE_SIZE = 12;
export const NONCE_PREFIX_SIZE = 8;
export const KEK_ID_SIZE = 16;
export const DEFAULT_CHUNK_SIZE_LOG2 = 16; // 64 KiB plaintext chunks

export const OFF = {
  magic: 0,
  version: 4,
  chunkSizeLog2: 5,
  kekId: 6,
  noncePrefix: 22,
  wrapNonce: 30,
  wrappedDek: 42,
  wrapTag: 74,
  plaintextSize: 90,
  reserved: 98,
} as const;

/** Bytes 0..42 of the header authenticate the DEK wrap (magic..wrapNonce). */
export const WRAP_AAD_END = 42;

export interface ParsedHeader {
  /** the raw 128-byte header, needed verbatim as chunk AAD. */
  raw: Buffer;
  version: number;
  chunkSizeLog2: number;
  /** plaintext chunk size `C`. */
  chunkSize: number;
  kekId: string;
  noncePrefix: Buffer;
  wrapNonce: Buffer;
  wrappedDek: Buffer;
  wrapTag: Buffer;
  plaintextSize: number;
}

/** Number of chunks for a plaintext of `plaintextSize` bytes (>=1; size 0 => one empty final chunk). */
export function chunkCount(plaintextSize: number, chunkSize: number): number {
  if (plaintextSize <= 0) return 1;
  return Math.ceil(plaintextSize / chunkSize);
}

/** Plaintext length of chunk `i`. */
export function chunkPlainLen(i: number, plaintextSize: number, chunkSize: number): number {
  const n = chunkCount(plaintextSize, chunkSize);
  if (i < 0 || i >= n) throw new StorageError('RANGE_INVALID', `chunk index ${i} out of range`);
  if (plaintextSize === 0) return 0;
  if (i < n - 1) return chunkSize;
  return plaintextSize - (n - 1) * chunkSize;
}

/** Stored (ciphertext+tag) length of chunk `i`. */
export function chunkStoredLen(i: number, plaintextSize: number, chunkSize: number): number {
  return chunkPlainLen(i, plaintextSize, chunkSize) + TAG_SIZE;
}

/** Byte offset of chunk `i` within the stored object (header occupies [0, HEADER_SIZE)). */
export function chunkStoredOffset(i: number, chunkSize: number): number {
  return HEADER_SIZE + i * (chunkSize + TAG_SIZE);
}

/** Total stored object size for a given plaintext size. */
export function totalStoredSize(plaintextSize: number, chunkSize: number): number {
  const n = chunkCount(plaintextSize, chunkSize);
  return HEADER_SIZE + plaintextSize + n * TAG_SIZE;
}

/** 12-byte GCM nonce for chunk `i`: noncePrefix(8) || uint32BE(i). */
export function chunkNonce(noncePrefix: Buffer, i: number): Buffer {
  const nonce = Buffer.allocUnsafe(NONCE_PREFIX_SIZE + 4);
  noncePrefix.copy(nonce, 0, 0, NONCE_PREFIX_SIZE);
  nonce.writeUInt32BE(i >>> 0, NONCE_PREFIX_SIZE);
  return nonce;
}

/** Chunk AAD: full 128-byte header || uint32BE(i) || finalFlag(1). */
export function chunkAad(header: Buffer, i: number, isFinal: boolean): Buffer {
  const aad = Buffer.allocUnsafe(HEADER_SIZE + 4 + 1);
  header.copy(aad, 0, 0, HEADER_SIZE);
  aad.writeUInt32BE(i >>> 0, HEADER_SIZE);
  aad[HEADER_SIZE + 4] = isFinal ? 0x01 : 0x00;
  return aad;
}

/** Validate an ASCII kekId that fits the 16-byte NUL-padded field. */
export function validateKekId(id: string): void {
  if (id.length === 0 || id.length > KEK_ID_SIZE) {
    throw new StorageError('CONFIG', `kekId must be 1..${KEK_ID_SIZE} chars: "${id}"`);
  }
  if (!/^[\x21-\x7e]+$/.test(id)) {
    throw new StorageError('CONFIG', `kekId must be printable ASCII with no spaces: "${id}"`);
  }
}

/** Parse and structurally validate a 128-byte header (does not unwrap the DEK). */
export function parseHeader(raw: Buffer): ParsedHeader {
  if (raw.length < HEADER_SIZE) {
    throw new StorageError('INTEGRITY', 'header shorter than 128 bytes');
  }
  const head = raw.subarray(0, HEADER_SIZE);
  if (!head.subarray(OFF.magic, OFF.magic + 4).equals(MAGIC)) {
    throw new StorageError('INTEGRITY', 'bad magic');
  }
  const version = head[OFF.version]!;
  if (version !== VERSION) {
    throw new StorageError('INTEGRITY', `unsupported version ${version}`);
  }
  const chunkSizeLog2 = head[OFF.chunkSizeLog2]!;
  if (chunkSizeLog2 < 10 || chunkSizeLog2 > 30) {
    throw new StorageError('INTEGRITY', `invalid chunkSizeLog2 ${chunkSizeLog2}`);
  }
  const chunkSize = 1 << chunkSizeLog2;

  const kekIdBuf = head.subarray(OFF.kekId, OFF.kekId + KEK_ID_SIZE);
  const nul = kekIdBuf.indexOf(0x00);
  const kekId = kekIdBuf.toString('ascii', 0, nul === -1 ? KEK_ID_SIZE : nul);

  const plaintextSizeBig = head.readBigUInt64BE(OFF.plaintextSize);
  if (plaintextSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StorageError('INTEGRITY', 'plaintextSize exceeds safe integer range');
  }

  return {
    raw: Buffer.from(head), // own copy so callers can cache it
    version,
    chunkSizeLog2,
    chunkSize,
    kekId,
    noncePrefix: Buffer.from(head.subarray(OFF.noncePrefix, OFF.noncePrefix + NONCE_PREFIX_SIZE)),
    wrapNonce: Buffer.from(head.subarray(OFF.wrapNonce, OFF.wrapNonce + WRAP_NONCE_SIZE)),
    wrappedDek: Buffer.from(head.subarray(OFF.wrappedDek, OFF.wrappedDek + DEK_SIZE)),
    wrapTag: Buffer.from(head.subarray(OFF.wrapTag, OFF.wrapTag + TAG_SIZE)),
    plaintextSize: Number(plaintextSizeBig),
  };
}
