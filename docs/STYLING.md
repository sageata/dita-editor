# Styling DITA topics

DITA Editor has three resource-scoped settings:

- `ditaeditor.visual.contentStylesheets`: ordered, read-only developer CSS files.
- `ditaeditor.visual.managedAuthorStylesheet`: the one CSS file the Styles panel may manage; default `css/ditaeditor-author-styles.css`.
- `ditaeditor.visual.taxonomyFile`: optional taxonomy JSON; it does not add CSS.

## Cascade

The visual and change-review views load CSS in this exact order: built-in `media/content-theme.css`; each configured `contentStylesheets` entry in array order; the complete inspected managed author stylesheet in its live style slot; and finally the view's surface-only `editor.css` or `redline.css`. Later rules win when normal CSS specificity and importance are equal. Developer stylesheets are always read-only; the Styles panel writes only the managed file.

```json
{
  "ditaeditor.visual.contentStylesheets": ["css/base.css", "css/project.css"],
  "ditaeditor.visual.managedAuthorStylesheet": "css/author.css"
}
```

Paths are workspace-relative. In a multi-root workspace, the folder containing the active topic supplies its resource settings. Read targets may use a symbolic link only when its canonical target remains inside that folder. Managed destinations reject symbolic links and reparse points in every component. Canonical containment, normalized duplicate, case-alias, and managed/developer alias checks prevent escapes and ambiguous writes. Only local `file` workspaces are writable.

## Managed regions

New managed files and migrated canonical legacy files use exactly one region:

```css
/* DITAEDITOR_MANAGED_STYLES_START */
/* DITAEDITOR_AUTHOR_STYLE {"className":"dc-example","name":"Example","target":"paragraph"} */
body.ditaeditor-canvas .p.dc-example { color: #1f2937; }
/* DITAEDITOR_MANAGED_STYLES_END */
```

Text outside the two region markers is preserved byte-for-byte. Missing, duplicate, reversed, nested, or non-canonical marker content is rendered but read-only. Metadata must parse as the canonical serializer expects; unsupported or lossy content is refused instead of rewritten.

Every save uses optimistic concurrency. The extension snapshots matching open documents, refuses dirty files, revalidates canonical identity, acquires an exclusive sibling `.ditaeditor.lock`, rereads and hashes the destination, writes and flushes an exclusive temporary file, rechecks documents and destination bytes, then atomically replaces the target. A pre-existing lock, changed bytes, changed destination, unsafe path, invalid UTF-8, or filesystem error causes a visible refusal and an Output log entry. DITA Editor never guesses that a lock is stale; remove one manually only after confirming no instance is writing.

In Restricted Mode all three settings are disabled, so only built-in presentation is used and no managed stylesheet can be written.
