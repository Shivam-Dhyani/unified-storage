# `unified-storage` — implementation notes & deviations

Decisions and deviations from the TDD, recorded per CLAUDE.md rule 3 ("never invent
APIs; if the named API differs, implement the required behavior with the real API
and record the difference here").

## Toolchain

- **TypeScript pinned to 5.9.3, not the `latest` tag (7.0.2).** npm's `latest` for
  `typescript` is now the 7.x native (Go) port. tsup's bundled `rollup-plugin-dts`
  crashes against it (`Cannot read properties of undefined (reading
  'useCaseSensitiveFileNames')`) so `.d.ts` emission fails. TS 5.9.3 is the latest
  release the build toolchain supports. Revisit when tsup/rollup-plugin-dts support
  TS 7. (TDD §1.4 says "latest stable"; this is the latest *viable* stable.)
- **GramJS (`telegram`) shows an npm deprecation warning on install.** It remains
  the library named by the TDD (§6.5) and is the de-facto MTProto client for Node.
  No drop-in replacement is specified; we proceed with it and will record any
  concrete API differences below as they are found.

## GramJS (`telegram`) usage notes

- **bigInt without a new dependency.** GramJS `long` fields are `big-integer`
  `BigInteger`. Rather than add `big-integer` as a direct dependency, we build them
  via the re-exported `helpers.returnBigInt(...)`. Keeps runtime deps to GramJS +
  AWS SDK (TDD §6.7).
- **`CustomFile` import path.** `telegram` ships no `exports` map, so `CustomFile`
  is imported from the deep path `telegram/client/uploads.js` (it is not on the
  top-level export). Verified present at that path in 2.26.22.
- **Observable FLOOD_WAIT.** The client is constructed with
  `floodSleepThreshold: 0` so GramJS never sleeps silently; every FLOOD_WAIT
  surfaces to `flood.ts` and the metrics hook (TDD §6.5).
- **Ranged reads via raw `upload.getFile`.** We issue `Api.upload.GetFile` directly
  (with DC routing through `client.invoke(req, dcId)`) using our own 4096-aligned,
  1 MiB-bounded request planner (`range.ts`), rather than the library's download
  iterator, so ranges and flood waits are fully under our control (TDD §6.5 allowed
  either; we chose the explicit path).
- **Channel resolution (U-04).** `resolveChannel` uses
  `channels.getChannels` with `InputChannel(channelId, accessHash = 0)` as the
  primary method. The whole backend is behind the `TelegramBackend` interface so the
  fallback (access hash from an MTProto membership update) can be swapped in after
  Phase 1 measures T-ONB-04.
- **User-mode `findChannelByMarker`** iterates dialogs and reads each owned
  channel's `about` via `channels.getFullChannel`. Correct but O(dialogs); only used
  by the PocketVerse user-session path and exercised by integration, not the hot
  path.

## unified-storage API deviations
(none — public surface matches TDD §6.2/§6.3.)

Last updated: 2026-10-03
