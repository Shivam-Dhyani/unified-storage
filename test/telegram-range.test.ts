import { describe, it, expect } from 'vitest';

import { planGetFileRequests, isCompliant, sliceFromParts, ALIGN, MIB } from '../src/adapters/telegram/range.js';

const cases: Array<[number, number]> = [
  [0, 0],
  [0, 1],
  [0, 128],
  [0, 4096],
  [0, 4097],
  [100, 50],
  [4096, 4096],
  [4095, 2],
  [0, 65536 + 16],
  [128, 65536],
  [MIB - 4096, 8192], // would cross a 1 MiB boundary if done naively
  [MIB - 100, 200],
  [MIB, MIB],
  [3 * MIB + 1234, 2 * MIB + 5678],
  [1_000_000, 750_000], // ~ one 1.5 Mbps / 4s segment
];

describe('telegram range planning', () => {
  it('produces only compliant, contiguous requests covering the aligned span', () => {
    for (const [offset, length] of cases) {
      const plan = planGetFileRequests(offset, length);
      const alignedStart = Math.floor(offset / ALIGN) * ALIGN;
      expect(plan.alignedStart, `alignedStart ${offset}+${length}`).toBe(alignedStart);

      if (length === 0) {
        expect(plan.requests).toHaveLength(0);
        continue;
      }
      const alignedEnd = Math.ceil((offset + length) / ALIGN) * ALIGN;

      let cursor = alignedStart;
      for (const req of plan.requests) {
        expect(isCompliant(req), `compliant ${JSON.stringify(req)}`).toBe(true);
        expect(req.offset, `contiguous at ${JSON.stringify(req)}`).toBe(cursor);
        cursor += req.limit;
      }
      expect(cursor, `covers end for ${offset}+${length}`).toBe(alignedEnd);
    }
  });

  it('reassembles the exact requested bytes from fetched parts', () => {
    const backing = Buffer.allocUnsafe(4 * MIB);
    for (let i = 0; i < backing.length; i++) backing[i] = (i * 7 + 3) & 0xff;

    for (const [offset, length] of cases) {
      const plan = planGetFileRequests(offset, length);
      const parts = plan.requests.map((r) => backing.subarray(r.offset, r.offset + r.limit));
      const out = sliceFromParts(plan, parts, offset, length);
      expect(out.equals(backing.subarray(offset, offset + length)), `${offset}+${length}`).toBe(true);
    }
  });
});
