# Side-by-side rendered Review session handoff

## Goal

Add a read-only side-by-side rendered comparison mode for one `.dita` file to the existing Review Changes panel. The exact selected revision pair, merged Track Changes view, and raw XML diff fallback must remain intact.

## Starting state

- Branch: `main`
- Starting commit: `26081c4ef2393230d310b3de44da84397c4c2998`
- Existing unrelated untracked path: `.anti-hall/history/INDEX.md`
- The current Review panel renders one merged redline and already preserves exact historical `TabInputTextDiff` URI pairs.

## Implementation seams

- `src/compare/block-diff.ts`: authoritative structural alignment.
- `src/compare/render-side-by-side.ts`: new pure paired-row renderer.
- `src/compare/review-shell.ts`: pure Review banner and mode/view shell.
- `src/host/redline-panel.ts`: load the exact two sources once and render both modes.
- `media/redline.js`: persisted mode, expand/collapse, and previous/next navigation.
- `media/redline.css`: shared two-column row layout with a single document scrollbar.

## Implemented behavior

- The existing Review panel opens in Track Changes mode and now offers a Side by side toggle.
- Both modes render from the same exact selected old/new source strings; earlier content is left and newer content is right.
- Structural rows mark insertions, deletions, edits, formatting changes, and moves. Recursive list/table changes retain their specific semantic kind.
- Both cells of every comparison row share one CSS grid row in normal document flow, so the page has one vertical scrollbar and aligned content cannot drift.
- Long unchanged runs collapse with one context row on either side. Previous/Next visits visible change rows and expands a collapsed group when requested.
- The read-only renderer retains workspace style sheets, relative images, CALS table rendering, table names, and globally unique table-header IDs.
- Added/deleted topic roots and root type/attribute changes are explicit review changes, including an otherwise empty new topic.
- Track Changes and the raw side-by-side XML fallback remain available and unchanged in purpose.
- Commit-wide review and revision-versioned binary/CSS assets are outside this single-file source-comparison scope. Relative assets intentionally resolve from the current workspace, matching the pre-existing Review panel.

## Hardening record

- Round 1 corrected duplicate table-header IDs/missing table names, a single sparse insertion cascade, invisible root metadata/type changes, stale positional expansion state, and a sticky subheader overlap.
- Round 2 corrected multiple sparse edit cascades in wide containers, semantic-kind loss below lists/tables, and invisible added/deleted roots.
- Later adversarial passes corrected repeated-content wide gaps, disappearing direct-text list edits, fragmented table semantics, and ordered-list numbering resets.
- Wide alignment now uses recursively partitioned unique ordered anchors plus bounded Myers alignment for repeated-content gaps before positional fallback. Regression probes cover separated inserts, deletes, and mixed insert/delete edits.
- Only layout-transparent body/section shells flatten into child rows. Lists, tables, figures, and other semantic containers remain whole and expose nested leaf change kinds as badges.
- Final three-lens review converged with zero unadjudicated P0/P1 findings.

## Verification required

- Focused renderer, shell, source-selection, webview-script, and resource tests.
- `bun run typecheck`
- `bun run build`
- Full `bun test`
- Real VS Code webview verification where the environment permits it.
- Three-lens adversarial review with zero unresolved P0/P1 findings after the final code change.

Latest completed automated checks after the production fixes:

- Focused Review/diff suite: 90 passed, 0 failed.
- TypeScript typecheck: passed.
- Production build: passed.
- Full repository suite: 1,666 passed, 1 intentional real-WebView skip, 0 failed.
- Explicit real VS Code WebView suite: 1 passed, 0 failed.

## Owner verification

1. In VS Code Source Control or Git history, open changes for a modified `.dita` file.
2. Select Side by side and confirm Earlier/Newer styling, aligned rows, images, and tables look correct for a representative real document.
3. Exercise Previous/Next and expand one unchanged section.
4. Switch back to Track Changes, then open the side-by-side XML fallback.

## Completion boundary

Automated checks can prove the implementation contract, but visual fidelity remains pending owner verification inside VS Code. Do not describe the goal as fully complete until that owner check occurs.
