/**
 * File-reference / document cache (TDD §6.5 step 1).
 *
 * `channels.getMessages` yields a fresh document (id, access hash, file reference,
 * dcId, size). We cache that per message for ~10 minutes (LRU, 5000 entries) so
 * ranged reads don't re-fetch on every call, and invalidate on a
 * `FILE_REFERENCE_EXPIRED/INVALID` error.
 */

import type { TgDocument } from './backend.js';

export interface DocumentCacheOptions {
  max?: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry {
  value: TgDocument;
  expiresAt: number;
}

export interface DocumentCache {
  get(key: string, load: () => Promise<TgDocument | undefined>): Promise<TgDocument | undefined>;
  invalidate(key: string): void;
  size(): number;
}

export function createDocumentCache(options: DocumentCacheOptions = {}): DocumentCache {
  const max = options.max ?? 5000;
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now;
  const map = new Map<string, Entry>();

  function evictIfNeeded(): void {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  return {
    async get(key, load) {
      const hit = map.get(key);
      if (hit && hit.expiresAt > now()) {
        // refresh LRU recency
        map.delete(key);
        map.set(key, hit);
        return hit.value;
      }
      if (hit) map.delete(key);
      const value = await load();
      if (value) {
        map.set(key, { value, expiresAt: now() + ttlMs });
        evictIfNeeded();
      }
      return value;
    },
    invalidate(key) {
      map.delete(key);
    },
    size() {
      return map.size;
    },
  };
}
