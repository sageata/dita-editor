# DITA Editor

DITA Editor is a free, local-first visual editor for DITA topics in desktop Visual Studio Code. Version 0.1.0 is a preview: keep source control enabled and review changes before committing important content.

## Supported scope

The editor opens `.dita` topic, concept, task, and reference files and supports common DITA text, lists, notes, figures, images, code, links, and CALS tables. It preserves XML declarations, doctypes, comments, entities, and unsupported structures when they are not edited. DITA maps, bookmaps, specialization design, publishing, and schema installation are outside the visual editor's scope.

Only local `file` workspaces are supported. Remote, virtual, untitled, and web workspaces are read-only or unsupported. A multi-root workspace resolves each topic's settings from the workspace folder that contains that topic.

| Desktop OS | Preview support |
| --- | --- |
| Windows 10/11 | Supported |
| macOS 13 or newer | Supported |
| Current Ubuntu LTS | Supported |
| VS Code for the Web / remote workspaces | Not supported |

## Install and use

Install **DITA Editor** from the Visual Studio Marketplace, open a trusted local folder, then open a `.dita` file. Use **DITA Editor: Open Visual Editor** if VS Code opens XML source first. Use **DITA Editor: View/Edit Source** to return to XML, or the “Open … by Default” commands to choose the preferred editor.

In Restricted Mode the topic remains viewable, but workspace-provided styles, the managed author stylesheet, and taxonomy configuration are disabled. Trust the folder only when you trust its files.

## Privacy and network behavior

Editing, parsing, styling, taxonomy loading, and file writes happen locally. The extension has no telemetry and does not upload document content. It makes no runtime network requests. Links you choose to open and normal Visual Studio Code or Marketplace behavior are outside the extension.

## Preview limitations

This release does not replace a validating XML editor or DITA-OT. Visual coverage is intentionally narrower than the DITA standard, taxonomy fields are optional metadata helpers, and managed CSS writes are refused when concurrent or unsafe file state is detected.

Configuration details are in [Styling](docs/STYLING.md) and [Taxonomy](docs/TAXONOMY.md). See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and [Support](SUPPORT.md) for project workflows.

Licensed under [Apache-2.0](LICENSE).
