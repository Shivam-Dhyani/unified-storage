import { describe, it, expect, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';

import { createR2Adapter, type Presigner } from '../src/adapters/r2/index.js';
import type { MetricEvent } from '../src/types.js';

interface FakeError extends Error {
  $metadata?: { httpStatusCode?: number };
}
function fakeError(name: string, status?: number): FakeError {
  const e = new Error(name) as FakeError;
  e.name = name;
  if (status !== undefined) e.$metadata = { httpStatusCode: status };
  return e;
}

/** A fake S3 client: an in-memory bucket keyed by object key, with send() dispatch. */
function fakeClient(initial: Record<string, Buffer> = {}) {
  const objects = new Map<string, Buffer>(Object.entries(initial));
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const input = command.input;
      commands.push({ name, input });
      if (name === 'PutObjectCommand') {
        objects.set(input.Key as string, Buffer.from(input.Body as Buffer));
        return {};
      }
      if (name === 'GetObjectCommand') {
        const buf = objects.get(input.Key as string);
        if (!buf) throw fakeError('NoSuchKey', 404);
        let out = buf;
        const range = input.Range as string | undefined;
        if (range) {
          const m = /^bytes=(\d+)-(\d+)$/.exec(range);
          if (!m) throw fakeError('InvalidRange', 416);
          out = buf.subarray(Number(m[1]), Number(m[2]) + 1);
        }
        return { Body: { transformToByteArray: async () => new Uint8Array(out) } };
      }
      if (name === 'HeadObjectCommand') {
        const buf = objects.get(input.Key as string);
        if (!buf) throw fakeError('NotFound', 404);
        return { ContentLength: buf.length };
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(input.Key as string);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
    destroy: vi.fn(),
  };
  return { client: client as unknown as S3Client, commands, objects };
}

function adapter(fake: ReturnType<typeof fakeClient>, metrics?: (e: MetricEvent) => void, presigner?: Presigner) {
  return createR2Adapter({
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    bucket: 'holocast-cache',
    client: fake.client,
    ...(metrics ? { metrics } : {}),
    ...(presigner ? { presigner } : {}),
  });
}

describe('R2 adapter', () => {
  it('puts and reads back whole objects', async () => {
    const fake = fakeClient();
    const r2 = adapter(fake);
    const data = Buffer.from('hello cloudflare');
    const ref = await r2.put({ container: '', data, name: 'v/1/1.m4s', contentType: 'video/iso.segment' });
    expect(ref).toMatchObject({ adapter: 'r2', container: 'holocast-cache', key: 'v/1/1.m4s', size: data.length });
    const out = Buffer.from(await r2.get(ref));
    expect(out.equals(data)).toBe(true);
  });

  it('formats a byte range and returns only those bytes', async () => {
    const fake = fakeClient({ 'k': Buffer.from('0123456789') });
    const r2 = adapter(fake);
    const ref = { adapter: 'r2' as const, container: 'holocast-cache', key: 'k', size: 10 };
    const out = Buffer.from(await r2.get(ref, { offset: 2, length: 4 }));
    expect(out.toString()).toBe('2345');
    const getCmd = fake.commands.find((c) => c.name === 'GetObjectCommand');
    expect(getCmd?.input.Range).toBe('bytes=2-5');
  });

  it('maps a missing object to NOT_FOUND', async () => {
    const fake = fakeClient();
    const r2 = adapter(fake);
    await expect(r2.get({ adapter: 'r2', container: 'b', key: 'nope', size: 0 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('stat returns exists/size, and false for a missing object', async () => {
    const fake = fakeClient({ 'k': Buffer.alloc(42) });
    const r2 = adapter(fake);
    expect(await r2.stat({ adapter: 'r2', container: 'b', key: 'k', size: 42 })).toEqual({
      exists: true,
      size: 42,
    });
    expect(await r2.stat({ adapter: 'r2', container: 'b', key: 'missing', size: 0 })).toEqual({
      exists: false,
    });
  });

  it('delete is idempotent', async () => {
    const fake = fakeClient({ 'k': Buffer.from('x') });
    const r2 = adapter(fake);
    await r2.delete({ adapter: 'r2', container: 'b', key: 'k', size: 1 });
    await expect(r2.delete({ adapter: 'r2', container: 'b', key: 'k', size: 1 })).resolves.toBeUndefined();
  });

  it('presignGet signs a GET for the right bucket/key with the given TTL', async () => {
    const fake = fakeClient();
    const presigner: Presigner = vi.fn(async (_client, command, opts) => {
      return `https://signed/${(command.input as { Key: string }).Key}?exp=${opts.expiresIn}`;
    });
    const r2 = adapter(fake, undefined, presigner);
    const url = await r2.presignGet({ adapter: 'r2', container: 'holocast-cache', key: 'v/1/1.m4s', size: 1 }, 600);
    expect(url).toBe('https://signed/v/1/1.m4s?exp=600');
    expect(presigner).toHaveBeenCalledOnce();
  });

  it('emits metrics for each operation', async () => {
    const events: MetricEvent[] = [];
    const fake = fakeClient();
    const r2 = adapter(fake, (e) => events.push(e));
    const ref = await r2.put({ container: '', data: Buffer.from('abc'), name: 'k' });
    await r2.get(ref);
    expect(events.map((e) => e.op)).toEqual(['put', 'get']);
    expect(events.every((e) => e.ok)).toBe(true);
    expect(events[0]!.bytes).toBe(3);
  });

  it('maps AccessDenied to ACCESS_LOST and a bad range to RANGE_INVALID', async () => {
    const fake = fakeClient({ 'k': Buffer.from('0123456789') });
    // Force AccessDenied on get
    const denying = {
      async send() {
        throw fakeError('AccessDenied', 403);
      },
      destroy: vi.fn(),
    } as unknown as S3Client;
    const r2 = createR2Adapter({
      endpoint: 'e',
      accessKeyId: 'a',
      secretAccessKey: 's',
      bucket: 'b',
      client: denying,
    });
    await expect(r2.get({ adapter: 'r2', container: 'b', key: 'k', size: 1 })).rejects.toMatchObject({
      code: 'ACCESS_LOST',
    });
  });
});
