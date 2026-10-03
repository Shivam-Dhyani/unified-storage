/**
 * Throughput benchmark for the Telegram adapter — the upload/download/range
 * measurements behind T-TG-01..03, reusable from a laptop for T-INF-03
 * (laptop-vs-VM comparison). Optionally posts a result to the Holocast Lab.
 *
 * Usage:
 *   pnpm bench -- --packs 10 --size-mb 12 [--test T-INF-03] [--report]
 *
 * Gated by IT_TELEGRAM_* env vars; --report additionally needs LAB_URL + LAB_TOKEN.
 * NEVER commit real secrets.
 */

import { randomBytes } from 'node:crypto';
import os from 'node:os';

import { createEncryptedStore } from '../src/crypto/encrypted-store.js';
import { keyringFromKeys } from '../src/crypto/keyring.js';
import { createTelegramAdapter } from '../src/adapters/telegram/index.js';
import type { MetricEvent, ObjectRef } from '../src/types.js';
import { loadDotenv, optionalEnv, requireEnv } from './env.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

async function main(): Promise<void> {
  loadDotenv();
  const apiId = Number(requireEnv('IT_TELEGRAM_API_ID'));
  const apiHash = requireEnv('IT_TELEGRAM_API_HASH');
  const botToken = requireEnv('IT_TELEGRAM_BOT_TOKEN');
  const channelId = requireEnv('IT_TELEGRAM_TEST_CHANNEL_ID');
  const sessionFile = optionalEnv('IT_TELEGRAM_SESSION_FILE') ?? './.telegram-bench.session';

  const packs = Number(arg('packs', '10'));
  const sizeMb = Number(arg('size-mb', '12'));
  const testId = arg('test', 'T-INF-03')!;
  const packBytes = Math.round(sizeMb * 1_000_000);

  const floodWaits: number[] = [];
  const metrics = (e: MetricEvent): void => {
    if (e.op === 'flood_wait' && e.waitSeconds !== undefined) floodWaits.push(e.waitSeconds);
  };

  const tg = createTelegramAdapter({ mode: 'bot', apiId, apiHash, botToken, sessionFile, metrics });
  const enc = createEncryptedStore(tg, keyringFromKeys([{ id: 'benchk', key: randomBytes(32) }]));

  const uploadMBps: number[] = [];
  const downloadMBps: number[] = [];
  const rangeMs: number[] = [];
  const refs: ObjectRef[] = [];

  try {
    await tg.attachChannel(channelId);

    console.log(`→ T-TG-01 upload: ${packs} x ${sizeMb} MB`);
    for (let i = 0; i < packs; i++) {
      const data = randomBytes(packBytes);
      const t0 = performance.now();
      const ref = await enc.put({ container: channelId, data, name: `bench_${Date.now()}_${i}.bin` });
      const secs = (performance.now() - t0) / 1000;
      uploadMBps.push(packBytes / 1e6 / secs);
      refs.push(ref);
    }

    console.log('→ T-TG-02 sequential download');
    for (const ref of refs) {
      const t0 = performance.now();
      const buf = await enc.get(ref);
      const secs = (performance.now() - t0) / 1000;
      downloadMBps.push(buf.length / 1e6 / secs);
    }

    console.log('→ T-TG-03 random 1 MB range reads (50)');
    for (let i = 0; i < 50; i++) {
      const ref = refs[Math.floor(Math.random() * refs.length)]!;
      const off = Math.floor(Math.random() * (packBytes - 1_000_000));
      const t0 = performance.now();
      await enc.get(ref, { offset: off, length: 1_000_000 });
      rangeMs.push(performance.now() - t0);
    }

    const result = {
      uploadMedianMBps: Number(median(uploadMBps).toFixed(3)),
      downloadMedianMBps: Number(median(downloadMBps).toFixed(3)),
      rangeP50Ms: Number(percentile(rangeMs, 50).toFixed(1)),
      rangeP95Ms: Number(percentile(rangeMs, 95).toFixed(1)),
      floodWaits,
      packs,
      sizeMb,
    };
    console.log('\nResult:', JSON.stringify(result, null, 2));

    if (hasFlag('report')) {
      const labUrl = requireEnv('LAB_URL');
      const labToken = requireEnv('LAB_TOKEN');
      const environment = {
        host: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        cpus: os.cpus().length,
        node: process.version,
      };
      const res = await fetch(`${labUrl.replace(/\/$/, '')}/api/lab/results`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${labToken}` },
        body: JSON.stringify({ testId, metrics: result, environment, notes: 'bench.ts' }),
      });
      console.log(`→ posted to Lab (${testId}): HTTP ${res.status}`);
    }
  } finally {
    // Clean up uploaded bench packs.
    for (const ref of refs) {
      try {
        await enc.delete(ref);
      } catch {
        /* best effort */
      }
    }
    await tg.close();
  }
}

main().catch((e) => {
  console.error('bench failed:', e);
  process.exit(1);
});
