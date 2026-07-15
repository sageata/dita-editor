# Extension publishing session handoff

## Goal

Publish the latest tested `main` commit to the Visual Studio Marketplace without starting a development server or committing generated release versions back to the repository.

## Repository state

- Branch: `codex/auto-publish-extension`
- Branch point: local `main` at `15a197a`, 12 commits ahead of `origin/main`
- Marketplace extension: `paul-razvan-sarbu.dita-editor`
- Marketplace version verified before implementation: `0.1.0`
- Required repository secret: `VSCE_PAT` (not configured as of 2026-07-15)

## Changed files

- `.github/workflows/publish-extension.yml`
- `scripts/inspect-vsix.mjs`
- `test/release-hygiene.test.ts`
- `test/release-tooling.test.ts`

## Design

- Trigger only on pushes to `main`.
- Use read-only repository permissions and serialized publishing runs.
- Treat `package.json` as a `major.minor.0` release line and use the immutable workflow run number as the published patch.
- Refuse a release older than the current Marketplace version, package with `--no-update-package-json`, inspect the exact VSIX, then publish that VSIX.
- Allow only canonical stable semantic versions through the existing owner metadata gate.
- Bind the strict VSIX gate to the exact `paul-razvan-sarbu.dita-editor` Marketplace identity before publishing.
- Verify after publishing that Marketplace reports the expected newest version and the exact local VSIX SHA-256.
- Do not run the whole-repository public-export audit in the Marketplace job. The audit currently reports stale source provenance and tracked development-only files, while the strict VSIX inspector validates the actual Marketplace payload.

## Verification completed

- Final full suite: 1,622 passed, 1 intentionally skipped, 0 failed.
- Focused release tests: 25 passed, 0 failed.
- Type-check passed.
- Production build passed.
- Simulated `0.1.1` VSIX packaged and passed the strict VSIX hygiene gate.
- Live Marketplace boundary check accepted `0.1.0` to `0.1.1`.
- The expected-version and exact-VSIX-SHA post-publish assertion passed against simulated post-publish metadata.
- Workflow YAML passed actionlint 1.7.12.

## Open blocker

Do not merge to `main` until the repository has a valid `VSCE_PAT` secret. The workflow deliberately fails before publishing when the secret is absent.
