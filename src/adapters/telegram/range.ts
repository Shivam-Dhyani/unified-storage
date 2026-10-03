/**
 * Telegram `upload.getFile` range math (TDD §6.5).
 *
 * Telegram accepts a `getFile` request only when:
 *   - `offset % 4096 == 0`
 *   - `limit % 4096 == 0`
 *   - `limit <= 1048576`
 *   - `1048576 % limit == 0`
 *   - the request does not cross a 1 MiB boundary
 *     (`floor(offset / 1MiB) == floor((offset + limit - 1) / 1MiB)`)
 *
 * We translate an arbitrary byte range into a minimal list of compliant requests.
 * Invariant: each request offset is a multiple of its own limit, and every limit
 * is a power-of-two multiple of 4096 that divides 1 MiB. That makes every block
 * fall entirely within one 1 MiB window, so the boundary rule always holds.
 */

export const ALIGN = 4096;
export const MIB = 1048576;

/** Valid limits (divisors of 1 MiB that are multiples of 4096), largest first. */
export const VALID_LIMITS = [1048576, 524288, 262144, 131072, 65536, 32768, 16384, 8192, 4096];

export interface GetFileRequest {
  offset: number;
  limit: number;
}

export interface RangePlan {
  /** 4096-aligned start of the fetched span; subtract from the wanted offset to slice. */
  alignedStart: number;
  requests: GetFileRequest[];
}

/** Plan the compliant `getFile` requests that cover plaintext/ciphertext bytes [offset, offset+length). */
export function planGetFileRequests(offset: number, length: number): RangePlan {
  if (offset < 0 || length < 0) {
    throw new Error(`invalid range offset=${offset} length=${length}`);
  }
  const alignedStart = Math.floor(offset / ALIGN) * ALIGN;
  if (length === 0) return { alignedStart, requests: [] };

  const alignedEnd = Math.ceil((offset + length) / ALIGN) * ALIGN;
  const requests: GetFileRequest[] = [];
  let pos = alignedStart;
  while (pos < alignedEnd) {
    let chosen = ALIGN;
    for (const L of VALID_LIMITS) {
      if (pos % L === 0 && pos + L <= alignedEnd) {
        chosen = L;
        break;
      }
    }
    requests.push({ offset: pos, limit: chosen });
    pos += chosen;
  }
  return { alignedStart, requests };
}

/** True iff a single request obeys every Telegram alignment rule. */
export function isCompliant(req: GetFileRequest): boolean {
  const { offset, limit } = req;
  if (offset % ALIGN !== 0) return false;
  if (limit % ALIGN !== 0) return false;
  if (limit <= 0 || limit > MIB) return false;
  if (MIB % limit !== 0) return false;
  // no 1 MiB boundary crossing
  return Math.floor(offset / MIB) === Math.floor((offset + limit - 1) / MIB);
}

/**
 * Reassemble fetched parts (in request order) and slice out the exact wanted bytes.
 * `parts[i]` corresponds to `plan.requests[i]`; a short final part (EOF) is fine.
 */
export function sliceFromParts(
  plan: RangePlan,
  parts: Uint8Array[],
  wantedOffset: number,
  wantedLength: number,
): Buffer {
  const joined = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  const start = wantedOffset - plan.alignedStart;
  return joined.subarray(start, start + wantedLength);
}
