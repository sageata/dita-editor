# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension: a local-first **visual (WYSIWYG) editor for `.dita` topic files**. It registers a custom editor (`ditaeditor.visual`) that renders a DITA topic as an editable canvas, plus a rendered "Review Changes" (track-changes / redline) view. No telemetry, no network at runtime, `file`-scheme local workspaces only.

The overriding invariant: **edits round-trip byte-for-byte**. Visual edits are mapped back to the source and applied as *minimal* `WorkspaceEdit`s so VS Code owns undo/save and the on-disk git diff stays tiny. Unsupported/unedited XML (declarations, doctypes, comments, entities, unknown elements) is preserved verbatim.

## Commands

Use **Bun**, not npm. Node `22.22.2` / Bun `1.1.42` are pinned (`.node-version`, `package.json`).

```sh
bun install --frozen-lockfile
bun test                      # full headless suite (~146 test files)
bun test test/foo.test.ts     # single file
bun run typecheck             # tsc --noEmit — THIS is the lint gate (no eslint/prettier configured)
bun run build                 # esbuild dev bundle -> dist/extension.js
bun run build:production      # minified, no sourcemap
bun run watch                 # esbuild --watch for the source-dev loop
bun run package:vsix          # typecheck + prod build + vsce package -> artifacts/*.vsix
bun run inspect:vsix -- artifacts/dita-editor-0.1.0.vsix
bun run verify:metadata       # provenance check — see "Provenance" below
```

Real-VS-Code e2e is gated behind an env var and off by default: `bun run test:real-webview` (sets `DITAEDITOR_REAL_VSCODE_E2E=1`).

**Never start a dev server** — this is an extension, not an app. To exercise clickable behavior, build once and launch an Extension Development Host against a *separate* local DITA workspace:

```sh
bun run build
code --new-window --extensionDevelopmentPath="$PWD" /path/to/consumer-workspace
# run `bun run watch` in another terminal; use "Developer: Reload Window" after each rebuild
```

## Architecture

Two runtimes, one bundle. **Only `src/extension.ts` is bundled** (esbuild → `dist/extension.js`, `vscode` external). Everything under `media/` (webview client) and the CSS ships **unbundled as raw files** loaded as webview resources.

### Host side (extension process) — `src/host/`, `src/extension.ts`
- `extension.ts` — activation, command registration, status bar, and the **SCM diff interceptor**: when the user clicks a changed `.dita` in Source Control (which VS Code would open as a raw XML text-diff), it replaces that tab with the rendered Review panel. Escape hatch: `ditaeditor.redline.openFromScm`.
- `host/visual-editor-provider.ts` — the custom editor provider; the large hub wiring canvas messages → CST edits → `WorkspaceEdit`s.
- `host/*-actions.ts` — one module per edit category (inline, structural, image, table, style, attribute…).
- `host/redline-panel.ts`, `host/multi-redline-panel.ts`, `host/scm-intercept.ts` — the Review Changes panels (single file and commit-wide multi-file).
- `host/managed-style-*.ts` — the "Styles panel" that writes the one *managed* author stylesheet with optimistic-concurrency, atomic, lock-guarded writes.

### Pure core (no `vscode` import — kept headlessly testable)
- `src/cst/` — a hand-rolled, offset-tracking XML **CST** (concrete syntax tree). Every byte lands in exactly one node so ranges tile `[0, len)`. `parse.ts`, `serialize.ts`, editing transforms, and `edit-bridge.ts`/`minimalEdit` (computes the smallest replacement span between old and new source). This is the heart of byte-exact round-tripping.
- `src/render/to-html.ts` — CST → HTML emitting **DITA-OT 4.2.1 class names** (the tag+class contract, not full-document parity), shared by the read-only preview and the editable canvas. Render-only a11y attributes are never written back to source.
- `src/webview/canvas-html.ts` — pure builder for the canvas webview document (CSP, nonce, and URIs injected by the host).
- `src/compare/` — Review Changes rendering: block/word diff, redline, side-by-side, and the review "shells" (`review-shell.ts`, `multi-review-shell.ts`).
- `src/commands/`, `src/selection/`, `src/keyboard/`, `src/config/`, `src/styles/` — pure logic modules.

### Webview client — `media/*.js` (plain JS, NOT bundled or typechecked)
The in-canvas editing UI: `canvas.js` plus `canvas-*.js` (keyboard nav, selection, editing, tables, context menus, find/replace…), and `redline-review.js` for the Review view. These run in the webview and post messages to the host. Because they are shipped as raw resources, **VS Code aggressively caches them** — the redline resources carry a `?v=<REDLINE_RESOURCE_REVISION>` query string (`src/host/webview-resources.ts`); bump that revision when changing those files or the webview may serve stale bytes even after a window reload.

## Conventions that matter here

- **Keep pure modules free of `vscode`.** The `cst/`, `render/`, `webview/canvas-html`, `compare/`, `commands/` split exists so logic is unit-testable without a VS Code host. Put VS Code API calls in `host/` or `extension.ts` only.
- **Every changed behavior gets a test.** Tests are `test/*.test.ts` run via `bun test`; they cover the pure pieces. Anything only exercisable inside VS Code is verified manually in the Extension Development Host (see the handover docs and `docs/*-session-handoff.md`).
- **Provenance:** every new or changed *exported* file must get a fresh SHA-256 entry in `docs/provenance.json`; run `bun run verify:metadata` after the final bytes are written (`docs/PROVENANCE.md`). `vsce` packaging depends on this discipline.
- Strict TypeScript, two-space indent, single quotes, named exports. `noUnusedLocals`/`noUnusedParameters` are on — typecheck fails on dead locals.
- Never add mock/synthetic data to runtime UI, credentials, personal paths, or proprietary styles/fonts. Public fixtures must be inert and test-only.
- Styling model (managed vs. read-only developer stylesheets, cascade order, atomic managed writes) is documented in `docs/STYLING.md`; taxonomy in `docs/TAXONOMY.md`.
