/**
 * Public type contracts for `@shivam-dhyani/unified-storage`.
 *
 * One adapter interface (put / ranged get / delete / stat) is used identically
 * for every backend (FR-PKG-01, TDD §6.2). The encryption layer (§6.4) is itself
 * a `StorageAdapter`, so it composes over any backend.
 */

export type AdapterKind = 'telegram' | 'r2';

/** A handle to a stored object. For encrypted objects, `size` is the ciphertext size. */
export interface ObjectRef {
  adapter: AdapterKind;
  /** telegram: channel id (string); r2: bucket name. */
  container: string;
  /** telegram: message id (string); r2: object key. */
  key: string;
  /** stored size in bytes (ciphertext size if encrypted). */
  size: number;
  /** adapter extras, e.g. `{ encrypted: '1' }`. */
  meta?: Record<string, string>;
}

export interface PutInput {
  container: string;
  /** Phase 1: the whole object in memory (packs are <= 32 MB). */
  data: Uint8Array;
  /** file name (telegram document name / r2 key suffix). */
  name: string;
  contentType?: string;
  /** telegram only, <= 1024 chars. */
  caption?: string;
  /** r2: explicit object key (overrides `name`-derived key). */
  key?: string;
}

/** A plaintext byte range. For the encrypted store these are plaintext offsets. */
export interface RangeRequest {
  offset: number;
  length: number;
}

export interface StorageAdapter {
  readonly kind: AdapterKind;
  put(input: PutInput): Promise<ObjectRef>;
  get(ref: ObjectRef, range?: RangeRequest): Promise<Uint8Array>;
  delete(ref: ObjectRef): Promise<void>;
  stat(ref: ObjectRef): Promise<{ exists: boolean; size?: number }>;
  close(): Promise<void>;
}

export type MetricOp =
  | 'put'
  | 'get'
  | 'delete'
  | 'stat'
  | 'refresh_ref'
  | 'flood_wait'
  | 'retry';

export interface MetricEvent {
  adapter: AdapterKind;
  op: MetricOp;
  bytes?: number;
  ms?: number;
  waitSeconds?: number;
  ok: boolean;
  errorCode?: string;
}

export type MetricsHook = (e: MetricEvent) => void;
