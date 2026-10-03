/**
 * Telegram storage adapter (TDD §6.5), bot mode and user-session mode.
 *
 * Builds on a `TelegramBackend`: range planning (range.ts), FLOOD_WAIT retry
 * (flood.ts), file-reference refresh + document cache (refs.ts), channel access
 * caching, bounded per-DC parallelism, metrics, and StorageError mapping.
 */

import { StorageError } from '../../errors.js';
import { emitMetric, nowMs } from '../../internal/metrics.js';
import type { MetricsHook, ObjectRef, PutInput, RangeRequest, StorageAdapter } from '../../types.js';
import type { ChannelHandle, TelegramBackend } from './backend.js';
import { createGramjsBackend } from './backend-gramjs.js';
import { attachChannel, findOrCreateChannel } from './container.js';
import { isFileReferenceError, mapTelegramError, withFloodRetry } from './flood.js';
import { createDocumentCache, type DocumentCacheOptions } from './refs.js';
import { planGetFileRequests, sliceFromParts } from './range.js';

export interface TelegramAdapterBaseOptions {
  metrics?: MetricsHook;
  /** max concurrent getFile calls per DC (default 4). */
  maxParallelPerDc?: number;
  docCache?: DocumentCacheOptions;
  /** inject a backend (tests / alternative implementations). */
  backend?: TelegramBackend;
  /** injectable sleeper for flood retry (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type TelegramAdapterOptions = TelegramAdapterBaseOptions &
  (
    | { mode: 'bot'; apiId: number; apiHash: string; botToken: string; sessionFile: string }
    | { mode: 'user'; apiId: number; apiHash: string; session: string }
  );

export interface TelegramAdapter extends StorageAdapter {
  readonly kind: 'telegram';
  /** Resolve / cache a channel for file ops (bot mode); also used by Holocast on connect. */
  attachChannel(channelId: string): Promise<ChannelHandle>;
  /** User mode: find-or-create the storage channel by marker (FR-PKG-03). */
  findOrCreateChannel(params: { marker: string; title: string }): Promise<ChannelHandle>;
  /** Bot leaves a channel (Holocast "disconnect storage"). */
  leaveChannel(channelId: string): Promise<void>;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]!();
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, run);
  await Promise.all(workers);
  return results;
}

export function createTelegramAdapter(options: TelegramAdapterOptions): TelegramAdapter {
  const metrics = options.metrics;
  const maxParallel = options.maxParallelPerDc ?? 4;
  const sleepImpl = options.sleepImpl;

  const backend = options.backend ?? createGramjsBackend(options);
  const docCache = createDocumentCache(options.docCache);
  const channelCache = new Map<string, ChannelHandle>();
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    await backend.connect();
    connected = true;
  }

  async function resolveChannelCached(channelId: string): Promise<ChannelHandle> {
    const hit = channelCache.get(channelId);
    if (hit) return hit;
    const handle = await attachChannel(backend, channelId);
    channelCache.set(channelId, handle);
    return handle;
  }

  function docKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
  }

  async function loadDocTimed(ch: ChannelHandle, messageId: string) {
    const start = nowMs();
    try {
      const doc = await backend.getDocument({
        channelId: ch.channelId,
        accessHash: ch.accessHash,
        messageId,
      });
      emitMetric(metrics, { adapter: 'telegram', op: 'refresh_ref', ms: nowMs() - start, ok: true });
      return doc;
    } catch (e) {
      const err = mapTelegramError(e);
      emitMetric(metrics, { adapter: 'telegram', op: 'refresh_ref', ms: nowMs() - start, ok: false, errorCode: err.code });
      throw err;
    }
  }

  const floodOpts = { metrics, ...(sleepImpl ? { sleepImpl } : {}) };

  return {
    kind: 'telegram',

    async put(input: PutInput): Promise<ObjectRef> {
      await ensureConnected();
      const ch = await resolveChannelCached(input.container);
      const data = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
      const start = nowMs();
      try {
        const { messageId } = await withFloodRetry(
          () =>
            backend.uploadDocument({
              channelId: ch.channelId,
              accessHash: ch.accessHash,
              data,
              name: input.name,
              ...(input.caption !== undefined ? { caption: input.caption } : {}),
            }),
          floodOpts,
        );
        emitMetric(metrics, { adapter: 'telegram', op: 'put', bytes: data.length, ms: nowMs() - start, ok: true });
        return { adapter: 'telegram', container: ch.channelId, key: messageId, size: data.length };
      } catch (e) {
        const err = mapTelegramError(e);
        emitMetric(metrics, { adapter: 'telegram', op: 'put', ms: nowMs() - start, ok: false, errorCode: err.code });
        throw err;
      }
    },

    async get(ref: ObjectRef, range?: RangeRequest): Promise<Uint8Array> {
      await ensureConnected();
      const ch = await resolveChannelCached(ref.container);
      const key = docKey(ref.container, ref.key);

      let doc = await docCache.get(key, () => loadDocTimed(ch, ref.key));
      if (!doc) throw new StorageError('NOT_FOUND', `message ${ref.key} not found`);

      const offset = range ? range.offset : 0;
      const length = range ? range.length : ref.size;
      if (offset < 0 || length < 0) {
        throw new StorageError('RANGE_INVALID', `negative range offset=${offset} length=${length}`);
      }
      if (length === 0) return Buffer.alloc(0);

      const plan = planGetFileRequests(offset, length);
      const fetchParts = (d: NonNullable<typeof doc>): Promise<Buffer[]> =>
        runWithConcurrency(
          plan.requests.map((req) => () => withFloodRetry(() => backend.getFilePart(d, req.offset, req.limit), floodOpts)),
          maxParallel,
        );

      const start = nowMs();
      let parts: Buffer[];
      try {
        parts = await fetchParts(doc);
      } catch (e) {
        if (!isFileReferenceError(e)) throw e instanceof StorageError ? e : mapTelegramError(e);
        // Refresh the file reference once, then retry (TDD §6.5 step 1).
        docCache.invalidate(key);
        doc = await docCache.get(key, () => loadDocTimed(ch, ref.key));
        if (!doc) throw new StorageError('NOT_FOUND', `message ${ref.key} not found`);
        parts = await fetchParts(doc);
      }

      const out = sliceFromParts(plan, parts, offset, length);
      emitMetric(metrics, { adapter: 'telegram', op: 'get', bytes: out.length, ms: nowMs() - start, ok: true });
      return out;
    },

    async delete(ref: ObjectRef): Promise<void> {
      await ensureConnected();
      const ch = await resolveChannelCached(ref.container);
      const start = nowMs();
      try {
        await withFloodRetry(
          () => backend.deleteMessage({ channelId: ch.channelId, accessHash: ch.accessHash, messageId: ref.key }),
          floodOpts,
        );
        docCache.invalidate(docKey(ref.container, ref.key));
        emitMetric(metrics, { adapter: 'telegram', op: 'delete', ms: nowMs() - start, ok: true });
      } catch (e) {
        const err = mapTelegramError(e);
        if (err.code === 'NOT_FOUND') {
          // Deleting a missing message is a success (idempotent).
          emitMetric(metrics, { adapter: 'telegram', op: 'delete', ms: nowMs() - start, ok: true });
          return;
        }
        emitMetric(metrics, { adapter: 'telegram', op: 'delete', ms: nowMs() - start, ok: false, errorCode: err.code });
        throw err;
      }
    },

    async stat(ref: ObjectRef): Promise<{ exists: boolean; size?: number }> {
      await ensureConnected();
      const ch = await resolveChannelCached(ref.container);
      const start = nowMs();
      try {
        const doc = await backend.getDocument({ channelId: ch.channelId, accessHash: ch.accessHash, messageId: ref.key });
        emitMetric(metrics, { adapter: 'telegram', op: 'stat', ms: nowMs() - start, ok: true });
        return doc ? { exists: true, size: doc.size } : { exists: false };
      } catch (e) {
        const err = mapTelegramError(e);
        if (err.code === 'NOT_FOUND') {
          emitMetric(metrics, { adapter: 'telegram', op: 'stat', ms: nowMs() - start, ok: true });
          return { exists: false };
        }
        emitMetric(metrics, { adapter: 'telegram', op: 'stat', ms: nowMs() - start, ok: false, errorCode: err.code });
        throw err;
      }
    },

    async close(): Promise<void> {
      if (connected) await backend.close();
      connected = false;
    },

    async attachChannel(channelId: string): Promise<ChannelHandle> {
      await ensureConnected();
      const handle = await attachChannel(backend, channelId);
      channelCache.set(channelId, handle);
      return handle;
    },

    async findOrCreateChannel(params: { marker: string; title: string }): Promise<ChannelHandle> {
      await ensureConnected();
      const handle = await findOrCreateChannel(backend, params);
      channelCache.set(handle.channelId, handle);
      return handle;
    },

    async leaveChannel(channelId: string): Promise<void> {
      await ensureConnected();
      const ch = await resolveChannelCached(channelId);
      await backend.leaveChannel({ channelId: ch.channelId, accessHash: ch.accessHash });
      channelCache.delete(channelId);
      docCache.invalidate(channelId);
    },
  };
}
