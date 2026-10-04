# Publishing `@shivam-dhyani/unified-storage`

The package is prepared for an **alpha** npm release (`0.1.0-alpha.0`). Publishing is a
manual, owner-gated step — it needs the npm scope/org and an auth token that are **not**
part of this repo or any CI secret here. Do not commit a token.

## One-time setup (owner)
1. Create the npm account / organization that owns the `@shivam-dhyani` scope.
2. `npm login` locally, or create an automation token and export it:
   `export NODE_AUTH_TOKEN=<token>` (never commit it).
3. The manifest already sets `publishConfig.access = "public"` so the scoped package
   publishes publicly without extra flags.

## Release checklist
Run from this package directory (`unified-storage/`):

```bash
pnpm install
pnpm typecheck && pnpm test     # 40 unit tests must pass
pnpm build                      # tsup → dist/ (ESM + CJS + .d.ts/.d.cts)
npm pack --dry-run              # verify the tarball is dist + README + LICENSE only
npm publish --tag alpha         # alpha dist-tag so it is not the default install
```

`prepublishOnly` runs `pnpm build`, so `dist/` is always rebuilt before a publish.

## Versioning
- Pre-1.0 alpha line: `0.1.0-alpha.N`. Bump with `npm version prerelease --preid alpha`.
- The Telegram backend's channel-access resolution and the fragmented-MP4 range math are
  the parts most likely to change; keep them in the changelog for each alpha.

## Consuming from Holocast before the first publish
`apps/api` depends on the package via `link:../../../unified-storage`, so Holocast builds
against the local source and does **not** require a published version. Switch that
dependency to the published range (`^0.1.0-alpha.0`) only after the first `npm publish`.
