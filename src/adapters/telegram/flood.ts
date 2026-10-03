/**
 * FLOOD_WAIT handling and Telegram→StorageError mapping (TDD §6.5, §6.3).
 *
 * The GramJS client is configured with `floodSleepThreshold: 0` so it never
 * sleeps silently; every wait surfaces here as a `FloodWaitError` and is made
 * observable through the metrics hook.
 */

import { StorageError } from '../../errors.js';
import { emitMetric } from '../../internal/metrics.js';
import type { MetricsHook } from '../../types.js';

const FLOOD_MAX_INLINE_WAIT = 60; // seconds; longer waits are surfaced, not slept

function errText(e: unknown): string {
  if (e == null) return '';
  const anyE = e as { errorMessage?: string; message?: string };
  return anyE.errorMessage ?? anyE.message ?? String(e);
}

/** If `e` is a FLOOD_WAIT_X error, return X seconds; otherwise undefined. */
export function floodWaitSeconds(e: unknown): number | undefined {
  const anyE = e as { seconds?: number } | undefined;
  const text = errText(e);
  if (/FLOOD(_PREMIUM)?_WAIT/i.test(text)) {
    if (typeof anyE?.seconds === 'number') return anyE.seconds;
    const m = /_WAIT_(\d+)/.exec(text);
    if (m) return Number(m[1]);
  }
  if (typeof anyE?.seconds === 'number' && /FLOOD/i.test(text)) return anyE.seconds;
  return undefined;
}

export function isFileReferenceError(e: unknown): boolean {
  return /FILE_REFERENCE/i.test(errText(e));
}

/** Map a raw Telegram/GramJS error to the StorageError taxonomy. */
export function mapTelegramError(e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  const text = errText(e);
  const flood = floodWaitSeconds(e);
  if (flood !== undefined) {
    return new StorageError('FLOOD_WAIT_EXCEEDED', `FLOOD_WAIT ${flood}s`, {
      waitSeconds: flood,
      cause: e,
    });
  }
  if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|CHANNEL_INVALID|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHAT_SEND_MEDIA_FORBIDDEN/i.test(text)) {
    return new StorageError('ACCESS_LOST', text, { cause: e });
  }
  if (/MESSAGE_ID_INVALID|MESSAGE_IDS_EMPTY|MSG_ID_INVALID/i.test(text)) {
    return new StorageError('NOT_FOUND', text, { cause: e });
  }
  if (/OFFSET_INVALID|LIMIT_INVALID|OFFSET_OUT_OF_RANGE/i.test(text)) {
    return new StorageError('RANGE_INVALID', text, { cause: e });
  }
  return new StorageError('UNKNOWN', text || 'telegram error', { cause: e });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface FloodRetryOptions {
  metrics?: MetricsHook;
  maxRetries?: number;
  /** injectable sleeper for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`, handling FLOOD_WAIT: wait and retry while X <= 60 (max `maxRetries`
 * times), throw `FLOOD_WAIT_EXCEEDED` when X > 60 or retries are exhausted.
 * Non-flood errors are mapped and rethrown immediately.
 */
export async function withFloodRetry<T>(fn: () => Promise<T>, options: FloodRetryOptions = {}): Promise<T> {
  const { metrics, maxRetries = 3, sleepImpl = sleep } = options;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const seconds = floodWaitSeconds(e);
      if (seconds === undefined) throw mapTelegramError(e);

      emitMetric(metrics, { adapter: 'telegram', op: 'flood_wait', waitSeconds: seconds, ok: false });

      if (seconds > FLOOD_MAX_INLINE_WAIT || attempt >= maxRetries) {
        throw new StorageError('FLOOD_WAIT_EXCEEDED', `FLOOD_WAIT ${seconds}s`, {
          waitSeconds: seconds,
          cause: e,
        });
      }
      attempt += 1;
      emitMetric(metrics, { adapter: 'telegram', op: 'retry', ok: true });
      await sleepImpl(seconds * 1000);
    }
  }
}
