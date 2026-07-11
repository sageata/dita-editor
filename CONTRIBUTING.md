# Contributing

Thank you for improving DITA Editor. Open an issue before a large change; small fixes may go directly to a focused pull request. Explain the user-visible reason, keep unrelated changes separate, and add tests for changed behavior.

## Development setup

Use Bun `1.1.42` and Node.js `22.22.2`, as pinned by `package.json` and `.node-version`.

```sh
bun install --frozen-lockfile
bun test test/relevant.test.ts
bun test
bun run typecheck
bun run build:production
bun run package:vsix
bun run inspect:vsix -- artifacts/dita-editor-0.1.0.vsix
```

For clickable editor changes, also run the installed-VSIX smoke workflow described by the current release tooling and manually verify the behavior in a real local DITA topic. Never start a development server for this extension.

## Pull requests

Use Bun rather than npm. Keep strict TypeScript, two-space indentation, single quotes, and named exports. Include the commands run and results in the pull request. Link the issue and include screenshots for visual changes.

Every new or changed exported file must receive a current SHA-256 and reviewed entry in `docs/provenance.json`. Run `bun run verify:metadata` after the final bytes are written. Do not add private documents, real organization data, credentials, personal filesystem paths, proprietary styles or fonts, generated source maps, or mock data to runtime UI. Public fixtures must be inert, synthetic, test-only, and clearly licensed.

By contributing, you agree that your contribution is licensed under Apache-2.0 and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
