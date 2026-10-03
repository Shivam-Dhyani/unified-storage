/**
 * Telegram integration test (M1 "done when"): upload an encrypted pack to a real
 * test channel, read it back whole and at random ranges, then delete it.
 *
 * Gated by IT_TELEGRAM_* env vars (see .env.example). NEVER commit real secrets.
 * Run: pnpm integration:telegram   (after creating .env)
 */

import { randomBytes } from 'node:crypto';

import { createEncryptedStore } from '../src/crypto/encrypted-store.js';
import { keyringFromKeys } from '../src/crypto/keyring.js';
import { createTelegramAdapter } from '../src/adapters/telegram/index.js';
import type { MetricEvent } from '../src/types.js';
import { loadDotenv, optionalEnv, requireEnv } from './env.js';

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main(): Promise<void> {
  loadDotenv();
  const apiId = Number(requireEnv('IT_TELEGRAM_API_ID'));
  const apiHash = requireEnv('IT_TELEGRAM_API_HASH');
  const botToken = requireEnv('IT_TELEGRAM_BOT_TOKEN');
  const channelId = requireEnv('IT_TELEGRAM_TEST_CHANNEL_ID');
  const sessionFile = optionalEnv('IT_TELEGRAM_SESSION_FILE') ?? './.telegram-it.session';

  const metrics = (e: MetricEvent): void => {
    if (!e.ok || e.op === 'flood_wait') console.log('[metric]', JSON.stringify(e));
  };

  const tg = createTelegramAdapter({ mode: 'bot', apiId, apiHash, botToken, sessionFile, metrics });
  const keyring = keyringFromKeys([{ id: 'itk', key: randomBytes(32) }]);
  const enc = createEncryptedStore(tg, keyring);

  try {
    console.log('→ resolving channel', channelId);
    const ch = await tg.attachChannel(channelId);
    console.log('  channel:', ch);
    assert(ch.canPost, 'bot cannot post to the channel (not an admin with post rights)');

    const plain = randomBytes(1_500_000); // ~1.5 MB pack
    console.log('→ uploading encrypted pack (', plain.length, 'bytes plaintext )');
    const ref = await enc.put({
      container: channelId,
      data: plain,
      name: `it_${Date.now()}.bin`,
      caption: JSON.stringify({ it: true, ts: Date.now() }),
    });
    console.log('  stored ref:', ref);

    console.log('→ reading whole object');
    const whole = Buffer.from(await enc.get(ref));
    assert(whole.equals(plain), 'whole read mismatch');

    console.log('→ reading 5 random ranges');
    for (let i = 0; i < 5; i++) {
      const off = Math.floor(Math.random() * (plain.length - 2000));
      const len = 1000 + Math.floor(Math.random() * 1000);
      const part = Buffer.from(await enc.get(ref, { offset: off, length: len }));
      assert(part.equals(plain.subarray(off, off + len)), `range ${off}+${len} mismatch`);
    }

    console.log('→ deleting');
    await enc.delete(ref);
    const st = await tg.stat(ref);
    assert(!st.exists, 'object still exists after delete');

    console.log('\n✅ INTEGRATION OK — upload, whole read, ranged reads, delete all verified');
  } finally {
    await tg.close();
  }
}

main().catch((e) => {
  console.error('\n❌ INTEGRATION FAILED:', e);
  process.exit(1);
});
