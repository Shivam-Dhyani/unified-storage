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

## unified-storage API deviations
(none yet)

Last updated: 2026-10-03
