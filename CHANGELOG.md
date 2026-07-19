# Changelog

All notable changes are documented here.

## 0.1.14

- Search DITA Topics: new Activity Bar view searching the rendered text of workspace .dita topics; results open the visual editor scrolled to the exact match (Ctrl/Cmd+Shift+Alt+F).
- Search DITA Topics: native-style Replace — a toggleable replace row pinned with the search input, per-match replace, and a confirmed workspace-wide Replace All applied as undoable editor edits; matches spanning styled text are skipped and counted.
- Visual Editor toolbar: simplified to a single compact row; groups that cannot fit move behind a large » caret that opens a keyboard-accessible popover. The Save/copy/paste/delete/move icon buttons were removed — those actions stay on the keyboard (Cmd/Ctrl+S, Alt+Arrow move, clipboard).
- Visual Editor toolbar: fast custom tooltips (~120ms, instant when moving between buttons) on all bar commands, replacing the slow native title bubbles; unavailable reasons are shown in the tooltip.
- Styles panel: a refused style or attribute change (stale render, incompatible element) now shows its reason in the visible error banner instead of failing silently.
- Canvas webview resources now carry a cache-busting revision so shipped script/stylesheet updates load reliably.
- Styles and Properties are now native VS Code views in a "DITA" Activity Bar container, themed by your VS Code theme, with shortcuts Ctrl/Cmd+Alt+S (Styles) and Ctrl/Cmd+Alt+P (Properties) active while a DITA visual editor is open. Drag the container to the Secondary Side Bar for a right-docked layout — VS Code remembers the placement. The in-canvas overlay panels were removed and the editor content column now centers itself.
- Requires VS Code 1.106 or later (the first release supporting Secondary Side Bar view contributions).
- Styles view: base rows are now radio-style "Default" rows — the redundant "Base" label is gone and, for the selected element's kind, the row showing its current look (the applied preset, or Default when none) is highlighted. Kinds without a customized default show the same muted "Default" row; expanding its editor and setting any value authors one.
- Styles view: the per-row eye now opens a hover preview window that renders the style on a small sample document together with your managed stylesheet, instead of restyling the row name; Escape or moving away closes it, and it can never apply a style.
- Table styles: new "Accent edge" and "Accent width" fields — the accent border can now draw on a chosen edge (left/top/bottom/right/all sides) at a chosen thickness, e.g. a 4px gold left border. Unset keeps the classic top+bottom rules; V-align is no longer shown for tables (no effect on a table box).
- Fixed authored table borders never rendering: Chrome clips a collapsed table's own borders under the rounded card, so the accent computed but never painted. Authored table styles now use the separate border model — borders render, follow the card radius, and table Padding becomes effective. Re-save any style once to refresh an existing stylesheet.

## 0.1.13

- Improved the Visual Editor toolbar with accessible groups, responsive layout, and common Save, clipboard, delete, and move actions.
- Added native color pickers while preserving authored CSS values and added an accessible custom table-shading dialog.
- Added Previous/Next navigation to Track Changes, side-by-side Review, and standalone exported HTML.
- Added guarded per-change **Revert to Earlier** actions that preserve VS Code dirty state and Undo/Redo.
- Expanded accessibility feedback, keyboard behavior, documentation, and real VS Code end-to-end coverage.

## 0.1.0 - Preview

- Added local-first visual editing for common DITA topic structures.
- Added safe source switching, formatting, linting, and rendered change review.
- Added workspace styles, managed author styles, and optional taxonomy fields.
- Added Restricted Mode limits, public release hygiene, and reproducible packaging.
