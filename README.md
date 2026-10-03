# @shivam-dhyani/unified-storage

One storage API over many backends, with built-in encryption.

- **One adapter interface** — `put` / ranged `get` / `delete` / `stat` — used
  identically for every backend.
- **Adapters:** Telegram (bot mode and user-session mode) and Cloudflare R2 (S3 API).
- **Encryption layer** that composes over any adapter: AES-256-GCM envelope
  encryption with **random-access range decryption** and key rotation.
- **Metrics hook** reporting bytes, durations, retries and FLOOD_WAITs.
- TypeScript, ESM + CJS builds, Node ≥ 20. Zero runtime deps beyond GramJS and the
  AWS S3 SDK.

> Status: `0.1.0-alpha` (Phase 1). The API may change before 1.0.

## Install

```bash
npm install @shivam-dhyani/unified-storage
# peers used by the adapters:
npm install telegram @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

## Quick start

### Encrypted Telegram storage (bot mode)

```ts
import {
  createTelegramAdapter,
  createEncryptedStore,
  parseKeyring,
} from '@shivam-dhyani/unified-storage';

const telegram = createTelegramAdapter({
  mode: 'bot',
  apiId: Number(process.env.TELEGRAM_API_ID),
  apiHash: process.env.TELEGRAM_API_HASH!,
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  sessionFile: '/var/lib/app/tg.session', // persisted so restarts don't re-login
  metrics: (e) => console.log(e),
});

// Keyring: "id:base64(32 bytes)[,id2:...]" — the first id is the active KEK.
const store = createEncryptedStore(telegram, parseKeyring(process.env.STORAGE_KEKS!));

// The bot must be an admin (with post rights) of this channel.
const channelId = '1234567890'; // MTProto channel id as a string

const ref = await store.put({ container: channelId, data: myBytes, name: 'pack.bin' });

// Random-access: decrypt only the chunks covering [offset, offset+length).
const slice = await store.get(ref, { offset: 65_000, length: 8_000 });

await store.delete(ref);
```

### Cloudflare R2 (cache)

```ts
import { createR2Adapter } from '@shivam-dhyani/unified-storage';

const r2 = createR2Adapter({
  endpoint: process.env.R2_ENDPOINT!, // https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  bucket: 'holocast-cache',
});

const ref = await r2.put({ container: '', data: segment, name: 'v/abc/1.m4s', contentType: 'video/iso.segment' });
const url = await r2.presignGet(ref, 600); // 10-minute presigned GET
```

### User-session Telegram mode (find-or-create a storage channel)

```ts
const telegram = createTelegramAdapter({
  mode: 'user',
  apiId, apiHash,
  session: process.env.TELEGRAM_STRING_SESSION!,
});
// Never creates a duplicate when a channel with the marker already exists.
const channel = await telegram.findOrCreateChannel({
  marker: 'unified-storage:v1:myapp:owner-123',
  title: 'My App Storage',
});
```

## API

### `StorageAdapter`

```ts
interface StorageAdapter {
  readonly kind: 'telegram' | 'r2';
  put(input: PutInput): Promise<ObjectRef>;
  get(ref: ObjectRef, range?: { offset: number; length: number }): Promise<Uint8Array>;
  delete(ref: ObjectRef): Promise<void>;
  stat(ref: ObjectRef): Promise<{ exists: boolean; size?: number }>;
  close(): Promise<void>;
}
```

`createEncryptedStore(adapter, keyProvider)` returns a `StorageAdapter` whose `get`
takes **plaintext** offsets. The Telegram adapter additionally exposes
`attachChannel`, `findOrCreateChannel` and `leaveChannel`; the R2 adapter exposes
`presignGet`.

### Errors

Every backend error is mapped to a `StorageError` with a `code`: `NOT_FOUND`,
`ACCESS_LOST`, `FLOOD_WAIT_EXCEEDED`, `INTEGRITY`, `RANGE_INVALID`, `CONFIG`,
`UNKNOWN`. `FLOOD_WAIT_EXCEEDED` carries `waitSeconds`.

## Encryption format (`USE1` v1)

A 128-byte header followed by AES-256-GCM chunks of 64 KiB plaintext each.

- A fresh random 32-byte **DEK** per object, wrapped with a **KEK** from the keyring
  (envelope encryption). The header names the KEK id, so rotation only requires
  keeping old KEKs available for decryption.
- Each chunk's GCM nonce is `noncePrefix ‖ uint32BE(index)`; its AAD binds the full
  header, the chunk index, and a final-chunk flag — so tampering, truncation and
  reordering are all detected (`INTEGRITY`).
- Ranged reads fetch only the chunks covering the requested plaintext bytes.

## Security

Threat model and what this library does about it:

- **Database leak.** The consumer (e.g. Holocast) stores only `ObjectRef`s
  (container + key + size) — never keys. Stored objects are ciphertext. A leaked DB
  reveals which messages hold data and their sizes, **not** the plaintext.
- **Bot-token / credential leak.** A leaked Telegram bot token or R2 credential grants
  access to the **ciphertext** only. Without a KEK the data cannot be decrypted. Keep
  KEKs in a separate secret from storage credentials.
- **Server compromise (has KEKs + token).** An attacker with both the active KEK and
  the storage credential can read data — this is unavoidable for a server that must
  itself decrypt. Mitigate with key rotation (supported), least-privilege storage
  tokens, and keeping KEKs out of logs, the DB, and client bundles.
- **Integrity.** Any modification of stored bytes (including truncation or chunk
  reordering) fails decryption with `INTEGRITY`; the library never returns
  unauthenticated bytes.
- **Nonce safety.** DEKs are per-object and random, and chunk nonces are unique within
  an object, so GCM nonce reuse does not occur across objects sharing a KEK.

Secrets (bot tokens, KEKs, R2 keys) must never be committed, logged, or sent to a
client. The metrics hook never receives key material.

## Limitations (Phase 1)

- Objects are handled whole in memory on `put` (packs ≤ 32 MB); streaming put/get is a
  later addition.
- Telegram channel access resolution for bots (U-04) and the event source for "who
  added the bot" (U-03) are measured in Holocast Phase 1; the adapter keeps these
  behind swappable seams.
- R2 adapter targets the S3 API used by Cloudflare R2; other S3 providers are untested
  in Phase 1.

## License

MIT © Shivam Dhyani
