import { describe, it, expect } from 'vitest';

import { createTelegramAdapter } from '../src/adapters/telegram/index.js';
import { findOrCreateChannel } from '../src/adapters/telegram/container.js';
import { createEncryptedStore } from '../src/crypto/encrypted-store.js';
import { parseKeyring } from '../src/crypto/keyring.js';
import type { ChannelHandle, TelegramBackend } from '../src/adapters/telegram/backend.js';
import { createFakeTelegramBackend } from './helpers/fake-telegram-backend.js';

const KEYRING = `k1:${Buffer.alloc(32, 0x5a).toString('base64')}`;

function adapter(backend: TelegramBackend) {
  return createTelegramAdapter({
    mode: 'bot',
    apiId: 1,
    apiHash: 'h',
    botToken: 't',
    sessionFile: '/tmp/unused.session',
    backend,
    sleepImpl: async () => {},
  });
}

function bytes(n: number): Buffer {
  const b = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) b[i] = (i * 13 + 5) & 0xff;
  return b;
}

describe('telegram adapter (fake backend)', () => {
  it('puts a document and reads it back whole and ranged', async () => {
    const tg = adapter(createFakeTelegramBackend());
    const data = bytes(2_000_000); // multi-MiB → multiple getFile requests
    const ref = await tg.put({ container: '555', data, name: 'pack.bin' });
    expect(ref).toMatchObject({ adapter: 'telegram', container: '555', size: data.length });

    const whole = Buffer.from(await tg.get(ref));
    expect(whole.equals(data)).toBe(true);

    for (const [off, len] of [[0, 10], [1_048_576 - 50, 100], [1_500_000, 400_000]] as const) {
      const out = Buffer.from(await tg.get(ref, { offset: off, length: len }));
      expect(out.equals(data.subarray(off, off + len)), `${off}+${len}`).toBe(true);
    }
  });

  it('reports stat and deletes idempotently', async () => {
    const tg = adapter(createFakeTelegramBackend());
    const ref = await tg.put({ container: 'c', data: bytes(100), name: 'x' });
    expect(await tg.stat(ref)).toEqual({ exists: true, size: 100 });
    await tg.delete(ref);
    expect(await tg.stat(ref)).toEqual({ exists: false });
    await expect(tg.delete(ref)).resolves.toBeUndefined(); // idempotent
  });

  it('refreshes the file reference once and retries on FILE_REFERENCE_EXPIRED', async () => {
    const backend = createFakeTelegramBackend({ failFileRefOnce: true });
    const tg = adapter(backend);
    const data = bytes(1000); // one request → exactly one initial getFilePart (which fails once)
    const ref = await tg.put({ container: 'c', data, name: 'x' });
    const out = Buffer.from(await tg.get(ref));
    expect(out.equals(data)).toBe(true);
    expect(backend.counters.getDocument).toBe(2); // initial load + one refresh
  });

  it('works as the backing store for the encrypted layer with plaintext ranges', async () => {
    const backend = createFakeTelegramBackend();
    const tg = adapter(backend);
    const enc = createEncryptedStore(tg, parseKeyring(KEYRING));

    const plain = bytes(200_000); // spans several 64 KiB chunks
    const ref = await enc.put({ container: '999', data: plain, name: 'enc.bin' });
    // The stored (ciphertext) object is larger than plaintext.
    expect(ref.size).toBeGreaterThan(plain.length);

    const whole = Buffer.from(await enc.get(ref));
    expect(whole.equals(plain)).toBe(true);

    // Random-access plaintext range that straddles chunk boundaries.
    const out = Buffer.from(await enc.get(ref, { offset: 70_000, length: 50_000 }));
    expect(out.equals(plain.subarray(70_000, 120_000))).toBe(true);
  });
});

describe('user-mode findOrCreateChannel (FR-PKG-03)', () => {
  const handle: ChannelHandle = { channelId: '77', accessHash: 'h', title: 'Storage', canPost: true, canDelete: true };

  it('returns the existing channel and never creates a duplicate when the marker is found', async () => {
    let created = 0;
    const backend = {
      findChannelByMarker: async () => handle,
      createChannel: async () => { created++; return handle; },
    } as unknown as TelegramBackend;
    const result = await findOrCreateChannel(backend, { marker: 'use:v1:ns:owner', title: 'Storage' });
    expect(result).toBe(handle);
    expect(created).toBe(0);
  });

  it('creates a channel (with the marker as description) when none is found', async () => {
    let createdAbout = '';
    const backend = {
      findChannelByMarker: async () => undefined,
      createChannel: async (args: { title: string; about: string }) => {
        createdAbout = args.about;
        return handle;
      },
    } as unknown as TelegramBackend;
    const result = await findOrCreateChannel(backend, { marker: 'use:v1:ns:owner', title: 'Storage' });
    expect(result).toBe(handle);
    expect(createdAbout).toBe('use:v1:ns:owner');
  });
});
