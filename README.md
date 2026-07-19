# DITA Editor

DITA Editor is a free, local-first visual editor for DITA topics in desktop Visual Studio Code. It is a preview: keep source control enabled and review important changes before committing them.

## Scope and source safety

The editor opens `.dita` topic, concept, task, and reference files. It supports common DITA text, lists, notes, figures, images, code, links, and CALS tables. DITA maps and bookmaps, specialization design, schema installation, keyspace management, validation, and publishing are outside this extension's scope.

DITA Editor uses a concrete syntax tree rather than reserializing the document. Opening, viewing, or making no effective change leaves the source byte-for-byte identical. A visual edit is applied as the smallest practical replacement through a normal Visual Studio Code workspace edit, preserving untouched whitespace, XML declarations, doctypes, comments, entities, and unsupported structures verbatim.

Only local `file` workspaces are supported. Remote, virtual, untitled, and web workspaces are read-only or unsupported. In a multi-root workspace, settings come from the folder containing the active topic.

| Desktop OS | Preview support |
| --- | --- |
| Windows 10/11 | Supported |
| macOS 13 or newer | Supported |
| Current Ubuntu LTS | Supported |
| VS Code for the Web / remote workspaces | Not supported |

## Install and use

1. Install **DITA Editor** from the Visual Studio Marketplace.
2. Open a trusted local folder containing DITA topics.
3. Open a `.dita` file. If XML source opens first, run **DITA Editor: Open Visual Editor** from the Command Palette.
4. Use **DITA Editor: View/Edit Source** to return to XML. The “Open … by Default” commands select the preferred editor for future `.dita` files.
5. Save, undo, and redo with the normal Visual Studio Code commands.

The main surfaces are available from the editor toolbar and the Visual Editor controls.

### Visual Editor

Visual Editor renders supported topic content as an editable canvas while retaining the original XML as the source of truth. It provides text and structure editing, keyboard navigation, find and replace, images, and table operations. The grouped toolbar also exposes Save, Copy as DITA, Paste before/after, Delete, and Move earlier/later. Arrow keys wrap through toolbar controls; unavailable controls remain focusable and explain why they cannot run. Unsupported content remains in the source and is preserved when edits do not target it.

### Styles

Styles uses one repository-owned author stylesheet for project presentation without changing the built-in editor. If the file is missing, the panel offers explicit initialization and adds no built-in presets. Color fields combine a native picker, editable CSS value, presets, and a Default action; authored values such as CSS variables and `color-mix(...)` remain unchanged until explicitly replaced. The panel applies author classes as standard DITA `outputclass` values and manages rules only inside the file's marked region; guarded writes are refused if the path, file state, lock, encoding, or concurrent content is unsafe. See [Styling DITA topics](docs/STYLING.md) for the setting, cascade order, initialization, and managed-region rules.

### Review Changes

Run **DITA Editor: Review Changes (Track Changes)**, or open an eligible `.dita` change from Source Control, to compare rendered DITA instead of raw XML. Review Changes provides rendered redline and side-by-side layouts, while keeping an XML diff available for source-level inspection.

**Previous** and **Next** move through rendered changes and update the current position. They work in single-file and multi-file review, and standalone exported review HTML includes self-contained client-side navigation so it continues to work when opened outside Visual Studio Code.

**Revert to Earlier** is available beside an eligible structural change only when the newer side is the current working copy. It restores that selected change from the Earlier version; it does not replace the whole file, run `git reset`, alter a commit, or change unrelated files. Moves, topic-root metadata, and changes that cannot be represented safely by one exact edit are intentionally not offered. The result is a normal dirty Visual Studio Code document: standard Undo restores the pre-revert working copy and Redo reapplies the revert. The action itself does not save the document; inspect it and save or discard it normally. Visual Studio Code's configured Auto Save behavior remains in control.

## Privacy and Restricted Mode

Parsing, editing, styling, taxonomy loading, review rendering, and file writes happen locally. DITA Editor has no telemetry, does not upload document content, and makes no runtime network requests. Links you choose to open and normal Visual Studio Code, Git, or Marketplace behavior are outside the extension.

In Restricted Mode, topics remain viewable, but the workspace-provided author stylesheet, deprecated content stylesheet fallbacks, and taxonomy configuration are disabled. No author stylesheet can be initialized or changed. Trust a folder only when you trust its files.

## Relationship to DitaCraft and DITA-OT

[DitaCraft](https://github.com/jyjeanne/ditacraft) is a separate, complementary Visual Studio Code extension. It provides DITA language tooling, map support, validation, keyspace features, and publishing workflows. Install and configure it independently when those capabilities are needed; DITA Editor has no direct runtime integration with DitaCraft.

[DITA Open Toolkit (DITA-OT)](https://www.dita-ot.org/) is an external publishing engine. DITA Editor does not execute or bundle the toolkit. Its renderer emits the DITA-OT 4.2.1 HTML CSS class contract so familiar selectors can style the Visual Editor and Review Changes output. That class-name compatibility is a presentation contract, not DITA-OT validation, transformation, or publishing.

## Architecture

DITA Editor has two runtimes:

- The TypeScript extension host registers the custom editor and commands, reads local documents and Git revisions, resolves workspace resources, and applies minimal edits through the Visual Studio Code API.
- Plain JavaScript and CSS under `media/` run in sandboxed webviews for the editable canvas and Review Changes UI; these files ship as raw webview resources.

Pure TypeScript modules keep the core behavior testable without Visual Studio Code: `src/cst/` handles offset-preserving XML parsing and edits, `src/render/` produces HTML, and `src/compare/` builds review output. `src/host/` connects those modules to Visual Studio Code, while `src/extension.ts` owns activation and command registration. Esbuild bundles the extension host to `dist/extension.js`; webview assets are not bundled into it.

## Contributing

Use Node.js `22.22.2` and Bun `1.1.42`, as pinned by the repository. Use Bun rather than npm.

```sh
bun install --frozen-lockfile
bun test test/relevant.test.ts
bun test
bun run typecheck
bun run build
bun run build:production
bun run package:vsix
```

There is no development server; do not run one. For interactive development, build the extension and launch an Extension Development Host against a separate local DITA workspace:

```sh
bun run build
code --new-window --extensionDevelopmentPath="$PWD" /path/to/consumer-workspace
```

For the rebuild loop, run `bun run watch` in another terminal and use **Developer: Reload Window** after each build. See [Contributing](CONTRIBUTING.md) for testing, installed-VSIX smoke, pull request, and provenance requirements.

See also [Taxonomy](docs/TAXONOMY.md), [Security](SECURITY.md), and [Support](SUPPORT.md).

Licensed under [Apache-2.0](LICENSE).
