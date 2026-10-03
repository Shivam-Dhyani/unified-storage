/**
 * Cloudflare R2 adapter (TDD §6.6) over the S3 API via `@aws-sdk/client-s3`.
 *
 * R2 is a cache in Holocast, never the source of truth; this adapter also backs
 * the generic S3 use case. Every operation emits a metric so the consumer can
 * count Class A (put/delete) and Class B (get/head) operations against the free
 * tier.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { StorageError } from '../../errors.js';
import { emitMetric, nowMs } from '../../internal/metrics.js';
import type { MetricsHook, ObjectRef, PutInput, RangeRequest, StorageAdapter } from '../../types.js';

/** Presigner seam so tests can assert signing without a network call. */
export type Presigner = (
  client: S3Client,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface R2AdapterOptions {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** default bucket; `input.container` / `ref.container` override per call. */
  bucket: string;
  region?: string;
  metrics?: MetricsHook;
  /** inject a preconfigured client (tests); otherwise one is built from creds. */
  client?: S3Client;
  /** inject a presigner (tests); defaults to the real `getSignedUrl`. */
  presigner?: Presigner;
}

export interface R2Adapter extends StorageAdapter {
  readonly kind: 'r2';
  presignGet(ref: ObjectRef, expiresSeconds: number): Promise<string>;
}

function httpStatus(e: unknown): number | undefined {
  const meta = (e as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata;
  return meta?.httpStatusCode;
}

function errName(e: unknown): string {
  return (e as { name?: string } | undefined)?.name ?? '';
}

function mapR2Error(e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  const name = errName(e);
  const status = httpStatus(e);
  if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) {
    return new StorageError('NOT_FOUND', 'object not found', { cause: e });
  }
  if (name === 'AccessDenied' || status === 403) {
    return new StorageError('ACCESS_LOST', 'access denied to R2 bucket/object', { cause: e });
  }
  if (name === 'InvalidRange' || status === 416) {
    return new StorageError('RANGE_INVALID', 'requested range not satisfiable', { cause: e });
  }
  const message = e instanceof Error ? e.message : String(e);
  return new StorageError('UNKNOWN', message, { cause: e });
}

export function createR2Adapter(options: R2AdapterOptions): R2Adapter {
  const defaultBucket = options.bucket;
  const metrics = options.metrics;
  const presigner: Presigner = options.presigner ?? getSignedUrl;

  const client =
    options.client ??
    new S3Client({
      region: options.region ?? 'auto',
      endpoint: options.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });

  return {
    kind: 'r2',

    async put(input: PutInput): Promise<ObjectRef> {
      const bucket = input.container || defaultBucket;
      const key = input.key ?? input.name;
      const body = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
      const start = nowMs();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: input.contentType,
            ContentLength: body.length,
          }),
        );
        emitMetric(metrics, { adapter: 'r2', op: 'put', bytes: body.length, ms: nowMs() - start, ok: true });
        const meta = input.contentType ? { contentType: input.contentType } : undefined;
        return { adapter: 'r2', container: bucket, key, size: body.length, ...(meta ? { meta } : {}) };
      } catch (e) {
        const err = mapR2Error(e);
        emitMetric(metrics, { adapter: 'r2', op: 'put', ms: nowMs() - start, ok: false, errorCode: err.code });
        throw err;
      }
    },

    async get(ref: ObjectRef, range?: RangeRequest): Promise<Uint8Array> {
      const bucket = ref.container || defaultBucket;
      const start = nowMs();
      try {
        if (range && range.length <= 0) return new Uint8Array(0);
        const Range = range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined;
        const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: ref.key, Range }));
        if (!resp.Body) throw new StorageError('NOT_FOUND', 'empty response body');
        const bytes = await resp.Body.transformToByteArray();
        emitMetric(metrics, { adapter: 'r2', op: 'get', bytes: bytes.length, ms: nowMs() - start, ok: true });
        return bytes;
      } catch (e) {
        const err = mapR2Error(e);
        emitMetric(metrics, { adapter: 'r2', op: 'get', ms: nowMs() - start, ok: false, errorCode: err.code });
        throw err;
      }
    },

    async delete(ref: ObjectRef): Promise<void> {
      const bucket = ref.container || defaultBucket;
      const start = nowMs();
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: ref.key }));
        emitMetric(metrics, { adapter: 'r2', op: 'delete', ms: nowMs() - start, ok: true });
      } catch (e) {
        const err = mapR2Error(e);
        emitMetric(metrics, { adapter: 'r2', op: 'delete', ms: nowMs() - start, ok: false, errorCode: err.code });
        throw err;
      }
    },

    async stat(ref: ObjectRef): Promise<{ exists: boolean; size?: number }> {
      const bucket = ref.container || defaultBucket;
      const start = nowMs();
      try {
        const resp = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: ref.key }));
        emitMetric(metrics, { adapter: 'r2', op: 'stat', ms: nowMs() - start, ok: true });
        return resp.ContentLength !== undefined
          ? { exists: true, size: resp.ContentLength }
          : { exists: true };
      } catch (e) {
        const err = mapR2Error(e);
        if (err.code === 'NOT_FOUND') {
          emitMetric(metrics, { adapter: 'r2', op: 'stat', ms: nowMs() - start, ok: true });
          return { exists: false };
        }
        emitMetric(metrics, { adapter: 'r2', op: 'stat', ms: nowMs() - start, ok: false, errorCode: err.code });
        throw err;
      }
    },

    async presignGet(ref: ObjectRef, expiresSeconds: number): Promise<string> {
      const bucket = ref.container || defaultBucket;
      return presigner(client, new GetObjectCommand({ Bucket: bucket, Key: ref.key }), {
        expiresIn: expiresSeconds,
      });
    },

    async close(): Promise<void> {
      client.destroy();
    },
  };
}
