import { describe, it, expect } from 'vitest';

import { createEncryptedStore, encryptedSize } from '../src/crypto/encrypted-store.js';
import { parseKeyring } from '../src/crypto/keyring.js';
import { StorageError } from '../src/errors.js';
import type { ObjectRef } from '../src/types.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';

const C = 65536; // DEFAULT chunk size (2^16)

function key(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64');
}
const KEYRING_A = `k2026a:${key(0x11)}`;
const KEYRING_ROTATED = `k2026b:${key(0x22)},k2026a:${key(0x11)}`; // active k2026b, still holds k2026a
const KEYRING_WRONG = `k2026a:${key(0x99)}`; // same id, different bytes

function makePlaintext(n: number): Buffer {
  // Deterministic but non-trivial content.
  const b = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

function store(spec = KEYRING_A) {
  const mem = createMemoryAdapter();
  const enc = createEncryptedStore(mem, parseKeyring(spec));
  return { mem, enc };
}

describe('encrypted store: round-trip', () => {
  const sizes = [0, 1, C - 1, C, C + 1, 10 * 1024 * 1024];
  for (const size of sizes) {
    it(`round-trips ${size} bytes and reports the right stored size`, async () => {
      const { mem, enc } = store();
      const data = makePlaintext(size);
      const ref = await enc.put({ container: 'c', data, name: 'x.bin' });

      expect(ref.meta?.encrypted).toBe('1');
      expect(ref.size).toBe(encryptedSize(size));
      expect(mem.rawOf(ref).length).toBe(encryptedSize(size));

      const out = Buffer.from(await enc.get(ref));
      expect(out.length).toBe(size);
      expect(out.equals(data)).toBe(true);
    });
  }
});

describe('encrypted store: ranged reads', () => {
  it('returns exactly the requested plaintext bytes at every boundary', async () => {
    const { enc } = store();
    const size = 3 * C + 1234;
    const data = makePlaintext(size);
    const ref = await enc.put({ container: 'c', data, name: 'x.bin' });

    const ranges: Array<[number, number]> = [
      [0, 0], // empty
      [0, 10], // start of first chunk
      [0, C], // exactly first chunk
      [5, 20], // inside first chunk
      [C - 10, 20], // crossing chunk 0/1 boundary
      [C, C], // exactly second chunk
      [C + 5, 2 * C], // spanning multiple chunks
      [2 * C - 1, 3], // crossing chunk 1/2 boundary by one byte
      [3 * C, 1234], // whole final (partial) chunk
      [size - 1, 1], // last byte
      [0, size], // whole object via range
    ];

    for (const [offset, length] of ranges) {
      const out = Buffer.from(await enc.get(ref, { offset, length }));
      expect(out.equals(data.subarray(offset, offset + length)), `range ${offset}+${length}`).toBe(
        true,
      );
    }
  });

  it('rejects invalid ranges with RANGE_INVALID', async () => {
    const { enc } = store();
    const data = makePlaintext(1000);
    const ref = await enc.put({ container: 'c', data, name: 'x.bin' });

    await expect(enc.get(ref, { offset: -1, length: 5 })).rejects.toMatchObject({
      code: 'RANGE_INVALID',
    });
    await expect(enc.get(ref, { offset: 0, length: 1001 })).rejects.toMatchObject({
      code: 'RANGE_INVALID',
    });
    await expect(enc.get(ref, { offset: 1000, length: 1 })).rejects.toMatchObject({
      code: 'RANGE_INVALID',
    });
    // offset == size with length 0 is allowed (empty slice at end)
    const empty = Buffer.from(await enc.get(ref, { offset: 1000, length: 0 }));
    expect(empty.length).toBe(0);
  });
});

describe('encrypted store: integrity', () => {
  it('detects a single-byte tamper anywhere in the object', async () => {
    // Small object spanning 2 chunks + partial, so every region is exercised.
    const size = C + 500;
    for (const pos of samplePositions(encryptedSize(size))) {
      const { mem, enc } = store();
      const data = makePlaintext(size);
      const ref = await enc.put({ container: 'c', data, name: 'x.bin' });

      const raw = Buffer.from(mem.rawOf(ref));
      raw[pos] = raw[pos]! ^ 0xff;
      mem.setRaw(ref, raw);

      let threw: unknown;
      try {
        await enc.get(ref);
      } catch (e) {
        threw = e;
      }
      expect(StorageError.is(threw), `tamper at byte ${pos} must throw`).toBe(true);
      // Every byte except the kekId field (6..22) must be an INTEGRITY failure;
      // tampering the kekId yields a key-not-found CONFIG error (documented).
      const code = (threw as StorageError).code;
      if (pos < 6 || pos >= 22) {
        expect(code, `byte ${pos}`).toBe('INTEGRITY');
      } else {
        expect(['INTEGRITY', 'CONFIG']).toContain(code);
      }
    }
  });

  it('detects a truncated final chunk', async () => {
    const { mem, enc } = store();
    const data = makePlaintext(C + 100);
    const ref = await enc.put({ container: 'c', data, name: 'x.bin' });
    const raw = mem.rawOf(ref);
    mem.setRaw(ref, raw.subarray(0, raw.length - 1)); // drop one byte of the final tag
    await expect(enc.get(ref)).rejects.toMatchObject({ code: 'INTEGRITY' });
  });

  it('detects swapped chunks', async () => {
    const { mem, enc } = store();
    const data = makePlaintext(2 * C); // two full chunks
    const ref = await enc.put({ container: 'c', data, name: 'x.bin' });
    const raw = Buffer.from(mem.rawOf(ref));

    const HEADER = 128;
    const stored = C + 16;
    const c0 = Buffer.from(raw.subarray(HEADER, HEADER + stored));
    const c1 = Buffer.from(raw.subarray(HEADER + stored, HEADER + 2 * stored));
    c1.copy(raw, HEADER);
    c0.copy(raw, HEADER + stored);
    mem.setRaw(ref, raw);

    await expect(enc.get(ref, { offset: 0, length: 2 * C })).rejects.toMatchObject({
      code: 'INTEGRITY',
    });
  });

  it('fails with INTEGRITY when the wrong KEK bytes are used for a known id', async () => {
    const mem = createMemoryAdapter();
    const good = createEncryptedStore(mem, parseKeyring(KEYRING_A));
    const data = makePlaintext(5000);
    const ref = await good.put({ container: 'c', data, name: 'x.bin' });

    const bad = createEncryptedStore(mem, parseKeyring(KEYRING_WRONG));
    await expect(bad.get(ref)).rejects.toMatchObject({ code: 'INTEGRITY' });
  });

  it('fails with CONFIG when the object names a KEK the ring does not hold', async () => {
    const mem = createMemoryAdapter();
    const a = createEncryptedStore(mem, parseKeyring(KEYRING_A));
    const ref = await a.put({ container: 'c', data: makePlaintext(1000), name: 'x.bin' });

    const other = createEncryptedStore(mem, parseKeyring(`k9999z:${key(0x55)}`));
    await expect(other.get(ref)).rejects.toMatchObject({ code: 'CONFIG' });
  });
});

describe('encrypted store: key rotation', () => {
  it('decrypts an object with a rotated (non-active) KEK and writes new objects with the active one', async () => {
    const mem = createMemoryAdapter();

    // Written under k2026a (active at the time).
    const old = createEncryptedStore(mem, parseKeyring(KEYRING_A));
    const data = makePlaintext(C + 77);
    const oldRef = await old.put({ container: 'c', data, name: 'old.bin' });

    // After rotation: active is k2026b, but k2026a is still available.
    const rotated = createEncryptedStore(mem, parseKeyring(KEYRING_ROTATED));
    const out = Buffer.from(await rotated.get(oldRef));
    expect(out.equals(data)).toBe(true);

    // A new object is written under the active KEK (k2026b); an A-only ring can't read it.
    const newData = makePlaintext(2000);
    const newRef = await rotated.put({ container: 'c', data: newData, name: 'new.bin' });
    const aOnly = createEncryptedStore(mem, parseKeyring(KEYRING_A));
    await expect(aOnly.get(newRef)).rejects.toMatchObject({ code: 'CONFIG' });
  });
});

describe('header cache invalidation', () => {
  it('drops the cached header when an object is deleted', async () => {
    const { enc } = store();
    const data = makePlaintext(1000);
    const ref: ObjectRef = await enc.put({ container: 'c', data, name: 'x.bin' });
    await enc.get(ref, { offset: 0, length: 10 }); // populate header cache
    await enc.delete(ref);
    await expect(enc.get(ref, { offset: 0, length: 10 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

/** A representative set of byte positions across header + chunk regions (keeps the sweep fast). */
function samplePositions(total: number): number[] {
  const set = new Set<number>();
  // Every header byte (structural + crypto fields).
  for (let i = 0; i < 128; i++) set.add(i);
  // A scattering of chunk-region bytes: first/last of each chunk, tags, boundaries.
  const picks = [128, 129, 200, 128 + 65535, 128 + 65536, 128 + 65536 + 15, total - 1, total - 16];
  for (const p of picks) if (p >= 0 && p < total) set.add(p);
  return [...set].sort((a, b) => a - b);
}
