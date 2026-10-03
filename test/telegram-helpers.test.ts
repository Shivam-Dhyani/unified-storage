import { describe, it, expect, vi } from 'vitest';

import {
  floodWaitSeconds,
  isFileReferenceError,
  mapTelegramError,
  withFloodRetry,
} from '../src/adapters/telegram/flood.js';
import { createDocumentCache } from '../src/adapters/telegram/refs.js';
import type { MetricEvent } from '../src/types.js';
import type { TgDocument } from '../src/adapters/telegram/backend.js';

function floodError(seconds: number): Error {
  return Object.assign(new Error(`FLOOD_WAIT_${seconds}`), { seconds });
}

describe('flood/error mapping', () => {
  it('detects FLOOD_WAIT seconds from message or property', () => {
    expect(floodWaitSeconds(floodError(7))).toBe(7);
    expect(floodWaitSeconds(new Error('FLOOD_WAIT_42'))).toBe(42);
    expect(floodWaitSeconds(new Error('NOPE'))).toBeUndefined();
  });

  it('maps telegram errors to the storage taxonomy', () => {
    expect(mapTelegramError(new Error('CHANNEL_PRIVATE')).code).toBe('ACCESS_LOST');
    expect(mapTelegramError(new Error('CHAT_ADMIN_REQUIRED')).code).toBe('ACCESS_LOST');
    expect(mapTelegramError(new Error('MESSAGE_ID_INVALID')).code).toBe('NOT_FOUND');
    expect(mapTelegramError(new Error('OFFSET_INVALID')).code).toBe('RANGE_INVALID');
    expect(mapTelegramError(new Error('something else')).code).toBe('UNKNOWN');
    const fwe = mapTelegramError(floodError(5));
    expect(fwe.code).toBe('FLOOD_WAIT_EXCEEDED');
    expect(fwe.waitSeconds).toBe(5);
  });

  it('isFileReferenceError recognises the expiry errors', () => {
    expect(isFileReferenceError(new Error('FILE_REFERENCE_EXPIRED'))).toBe(true);
    expect(isFileReferenceError(new Error('FILE_REFERENCE_INVALID'))).toBe(true);
    expect(isFileReferenceError(new Error('whatever'))).toBe(false);
  });
});

describe('withFloodRetry', () => {
  it('retries while FLOOD_WAIT <= 60 then succeeds, emitting metrics and sleeping', async () => {
    const events: MetricEvent[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withFloodRetry(
      async () => {
        calls++;
        if (calls < 3) throw floodError(2);
        return 'ok';
      },
      { metrics: (e) => events.push(e), sleepImpl: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2000, 2000]);
    expect(events.filter((e) => e.op === 'flood_wait')).toHaveLength(2);
    expect(events.filter((e) => e.op === 'retry')).toHaveLength(2);
  });

  it('throws FLOOD_WAIT_EXCEEDED when the wait is > 60s', async () => {
    await expect(
      withFloodRetry(async () => { throw floodError(120); }, { sleepImpl: async () => {} }),
    ).rejects.toMatchObject({ code: 'FLOOD_WAIT_EXCEEDED', waitSeconds: 120 });
  });

  it('throws FLOOD_WAIT_EXCEEDED after exhausting retries', async () => {
    await expect(
      withFloodRetry(async () => { throw floodError(1); }, { maxRetries: 2, sleepImpl: async () => {} }),
    ).rejects.toMatchObject({ code: 'FLOOD_WAIT_EXCEEDED' });
  });

  it('maps and rethrows non-flood errors immediately', async () => {
    await expect(
      withFloodRetry(async () => { throw new Error('CHANNEL_PRIVATE'); }),
    ).rejects.toMatchObject({ code: 'ACCESS_LOST' });
  });
});

describe('document cache (file-reference cache)', () => {
  const doc = (id: string): TgDocument => ({ id, accessHash: 'a', fileReference: Buffer.alloc(0), dcId: 2, size: 1 });

  it('caches within TTL, reloads after expiry, and on invalidate', async () => {
    let clock = 1000;
    const cache = createDocumentCache({ ttlMs: 100, now: () => clock });
    let loads = 0;
    const load = async () => { loads++; return doc(`v${loads}`); };

    expect((await cache.get('k', load))!.id).toBe('v1');
    expect((await cache.get('k', load))!.id).toBe('v1'); // cached
    expect(loads).toBe(1);

    clock += 101; // expire
    expect((await cache.get('k', load))!.id).toBe('v2');
    expect(loads).toBe(2);

    cache.invalidate('k');
    expect((await cache.get('k', load))!.id).toBe('v3');
    expect(loads).toBe(3);
  });

  it('evicts least-recently-used beyond max', async () => {
    const cache = createDocumentCache({ max: 2 });
    const mk = (id: string) => async () => doc(id);
    await cache.get('a', mk('a'));
    await cache.get('b', mk('b'));
    await cache.get('a', mk('a2')); // touch a (now MRU); cached so a2 ignored
    await cache.get('c', mk('c')); // inserts c, evicts LRU which is b
    expect(cache.size()).toBe(2);
    let reloaded = false;
    await cache.get('b', async () => { reloaded = true; return doc('b2'); });
    expect(reloaded).toBe(true); // b was evicted
  });
});
