# Releasing `@solvchat/*` packages

All publishable packages (`@solvchat/core`, `@solvchat/widget`, `@solvchat/admin`, `@solvchat/cli`, and `@solvchat/engine`) share a single version number and are published together from a `v<semver>` git tag on `main`.

`@solvchat/engine` does not depend on `@solvchat/admin` at runtime; instead, it embeds `@solvchat/admin`'s built `dist/` assets into `dist/adminBundle.js` at build time. To ensure the two cannot drift, `npm run pack-check` asserts that `@solvchat/engine`'s bundled admin assets match `packages/admin/dist/` from the same build.

## Cutting a release

1. Make sure `main` is up to date and green in CI.
2. Create and push an annotated or lightweight tag on `main` matching `v<semver>` (for example `v0.1.0`):

   ```sh
   git checkout main
   git pull --ff-only
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. The [Release workflow](../.github/workflows/release.yml) runs automatically on `v*` tag pushes.

## What the workflow does

1. Validates that the tag matches `v<semver>` and that the tagged commit is an ancestor of `origin/main` (failing before anything is published if either check fails).
2. Installs dependencies (`npm ci`) and runs `npm run verify` (lint, typecheck, tests, build, and `pack-check`).
3. Updates `version` and all internal `@solvchat/*` dependencies in the five publishable `package.json` manifests to the exact tag version (no `^`, `*`, or `workspace:`), then re-runs `npm run pack-check`.
4. Publishes in dependency order (`@solvchat/core`, `@solvchat/widget`, `@solvchat/admin`, `@solvchat/cli`, `@solvchat/engine`) with `--access public --provenance`.
5. Skips any package whose `<name>@<version>` is already on npm, so re-running a partially failed release job is safe.

## Dry run

To test the release pipeline without publishing to npm, run the **Release** workflow manually via **Actions → Release → Run workflow** with `dry_run` checked (default `true`). It runs `npm run verify`, `pack-check`, and `npm publish --dry-run`, and writes each tarball's file list to the workflow job summary.

## Immutability of published versions

A published version is never modified or unpublished. If a release has a bug, fix it on `main` and cut a new `v<semver>` tag.
