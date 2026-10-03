import type { MetricEvent, MetricsHook } from '../types.js';

/** Invoke a metrics hook without ever letting it break a storage operation. */
export function emitMetric(hook: MetricsHook | undefined, event: MetricEvent): void {
  if (!hook) return;
  try {
    hook(event);
  } catch {
    // A misbehaving metrics hook must never affect storage.
  }
}

/** Monotonic milliseconds for durations. */
export function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
