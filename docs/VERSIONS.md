# `unified-storage` — exact dependency versions

Recorded per CLAUDE.md engineering standards. Update on every dependency change.

| Package | Version | Notes |
|---|---|---|
| node | 22.22.0 | current Active LTS line (22.x) |
| pnpm | 10.28.0 | package manager |
| typescript | 5.9.3 | **pinned to 5.x** — see IMPLEMENTATION_NOTES (TS 7 native port breaks `tsup`/`rollup-plugin-dts`) |
| tsup | 8.5.1 | build (ESM + CJS + d.ts) |
| vitest | 5.0.3 | unit tests |
| tsx | 4.23.15 | runs integration/bench scripts |
| @types/node | 26.6.4 | |
| telegram (GramJS) | 2.26.22 | Telegram MTProto client (bot + user modes) |
| @aws-sdk/client-s3 | 3.1146.0 | R2 adapter (S3 API) |
| @aws-sdk/s3-request-presigner | 3.1146.0 | R2 presigned GET URLs |

Last updated: 2026-10-03
