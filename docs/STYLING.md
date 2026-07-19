# Styling DITA topics

DITA Editor owns only the structural CSS required for safe visual editing and its editor/review interaction chrome. The repository owns typography, colors, spacing, borders, design tokens, presets, and publishing presentation.

## One repository stylesheet

`ditaeditor.visual.authorStylesheet` is the optional workspace-relative entry point used by the visual editor, Review Changes, and the Styles view. Its default is:

```json
{
  "ditaeditor.visual.authorStylesheet": "css/ditaeditor-author-styles.css"
}
```

The complete file is loaded as a stylesheet link, not copied into an inline style block. Relative `@import`, font, image, and other `url(...)` references therefore resolve from the author stylesheet's own directory. A repository can import its tokens, base rules, and publishing shell from this one file:

```css
@import "tokens.css";
@import "manual-shell.css";

/* DITAEDITOR_MANAGED_STYLES_START */
/* DITAEDITOR_MANAGED_STYLES_VERSION 1 */
/* Styles-view definitions are written here. */
/* DITAEDITOR_MANAGED_STYLES_END */
```

The older `ditaeditor.visual.managedAuthorStylesheet` and `ditaeditor.visual.contentStylesheets` settings remain deprecated compatibility fallbacks. New workspace setup needs only `authorStylesheet`. `ditaeditor.visual.taxonomyFile` is independent and adds no CSS.

Paths are workspace-relative. In a multi-root workspace, the folder containing the active topic supplies its resource settings. Canonical containment, normalized duplicate, case-alias, and destination checks prevent workspace escapes and ambiguous writes. Managed destinations reject symbolic links and reparse points in every component. Only trusted local `file` workspaces are writable.

## Initializing a missing file

A missing configured/default file produces no built-in author presets and injects no author CSS. The Styles view instead shows **Initialize author stylesheet**, the repository path, and an ownership explanation. Initialization is explicit; DITA Editor never silently creates or seeds the file.

The generated template explains where project imports and hand-authored CSS belong, includes one versioned managed region, and contains no presets. If no safe writable destination exists, initialization is disabled with the refusal reason.

## Cascade

Visual and review surfaces use this order:

1. DITA Editor structural CSS.
2. Deprecated configured content stylesheets, when an existing workspace still uses them.
3. The complete repository author stylesheet link.
4. Temporary generated declarations while a changed author link is loading.
5. Surface-only editor or review chrome.

The temporary layer is cleared after the linked file loads, leaving the repository file authoritative. A source hash in the link URL prevents stale webview caching. Normal CSS specificity, importance, and source-order rules still apply.

## Managed regions and migration

DITA Editor writes only between these markers:

```css
/* DITAEDITOR_MANAGED_STYLES_START */
/* DITAEDITOR_MANAGED_STYLES_VERSION 1 */
/* DITAEDITOR_AUTHOR_STYLE {"className":"dc-example","name":"Example","target":"body","color":"#1f2937"} */
/* generated selectors and declarations */
/* DITAEDITOR_MANAGED_STYLES_END */
```

Every byte outside the markers is preserved. Valid unversioned DITA Editor regions remain readable; the next explicit style save migrates only their managed region. Malformed, ambiguous, duplicated, manually altered, or lossy regions remain visible but read-only instead of being guessed at or rewritten.

Every save uses optimistic concurrency. The extension snapshots matching open documents, refuses dirty files, revalidates canonical identity, acquires an exclusive sibling `.ditaeditor.lock`, rereads and hashes the destination, writes and flushes an exclusive temporary file, rechecks documents and destination bytes, then atomically replaces the target. Changed bytes, unsafe paths, invalid UTF-8, lock contention, or filesystem errors produce a visible refusal and an Output log entry.

## DITA compatibility

A preset class is stored on the DITA element through the standard `outputclass` attribute. The stylesheet maps that token to presentation; it does not invent a non-DITA styling attribute or change the document vocabulary. DITA Editor limits each preset to compatible target elements and preserves unrelated `outputclass` tokens.

Base styles apply through classless selectors and do not mark DITA source. Editor-only selection, caret, focus, resize, and review rules never serialize into the document or the repository stylesheet.

In Restricted Mode, workspace stylesheets and taxonomy configuration are disabled and no author stylesheet can be initialized or changed.
