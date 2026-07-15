# Extension publishing session handoff

## Goal

Publish the latest tested `main` commit to the Visual Studio Marketplace without starting a development server or committing generated release versions back to the repository.

## Repository state

- Branch: `codex/auto-publish-extension`
- Branch point: local `main` at `15a197a`, 12 commits ahead of `origin/main`
- Marketplace extension: `paul-razvan-sarbu.dita-editor`
- Marketplace version verified before implementation: `0.1.0`
- Required repository secret: `VSCE_PAT` (configured on 2026-07-15)

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

## Resolved credential blocker

The repository now has a `VSCE_PAT` Actions secret. The workflow still fails closed before publishing when that credential is absent.

## First main run and Linux CI repair

- `VSCE_PAT` was configured and PR #1 merged as `c71b93110353d245afd6791161cf66073b0bab37`.
- GitHub Actions run `29388878366` failed in `bun test` before packaging or publishing: 1,619 passed, 1 skipped, and 3 failed.
- Two managed-style persistence tests proved that Ubuntu can immediately reuse the same device/inode pair after unlink and recreation; the production identity check tracked only those fields.
- One smoke-harness test proved that a macOS `.app` fixture was executed as a GUI binary on Linux because CLI-wrapper selection depended on the host platform instead of the executable path.
- The scoped repair compares positive finite birth times when either side exposes one, rejects asymmetric availability, and retains device/inode compatibility when neither adapter exposes a usable birth time. Deterministic regressions cover changed and asymmetric birth times plus successful cleanup through adapters that expose `undefined` or `0`.
- The macOS CLI wrapper is selected from the `.app` executable shape. Its cross-platform regression injects command capture and proves the resolved `Resources/app/bin/code` CLI receives `--version` without launching a temporary executable.
