# Topic-wide horizontal alignment

## Intent

Make horizontal alignment available for eligible topic content and images, not only table cells, while preserving table-only vertical alignment. Persist valid DITA, apply multi-selection changes atomically, and publish the same alignment through DITACraft HTML5, EY PDF, PDF2, and DOCX outputs.

## Decisions and trade-offs

- Eligible elements are `title`, `shortdesc`, `p`, `li`, direct-text `note`, `codeblock`, `lines`, `cmd`, CALS `entry`, and `image`. Structural containers remain unsupported.
- `entry` and `image` use native DITA `@align`. Other eligible elements use one managed `@outputclass` token: `ditaeditor-align-left`, `ditaeditor-align-center`, `ditaeditor-align-right`, or `ditaeditor-align-justify`.
- Applying image alignment sets `placement="break"`; clearing image alignment removes only `@align` and preserves `@placement`.
- One closed `setHorizontalAlign` message handles the global toolbar and image quick buttons. The host validates the entire target set before one document edit, so invalid mixed selections never partially apply. The legacy unversioned `setImageAlign` message is refused with a visible resync notice rather than retained as a mutation path.
- Justify is unavailable when any target is an image. Conflicting managed tokens render with precedence `justify > right > center > left` and normalize to one token on the next alignment edit.
- Publisher changes are project-owned additions. Do not modify vendor PDF2 or OOXML transforms and do not touch the publisher's unrelated dirty DITA sources.

## Blast radius

- Editor webview command bar, image toolbar, selection-derived state, message schema, host authorization/action handling, renderer metadata, shared editor CSS, and tests.
- DITACraft shared publishing CSS, Gradle DOCX configuration, a project-owned DITA-OT extension, and focused publishing fixtures.
- No server startup, dependency addition, schema migration, mock UI data, or structural-container alignment.

## Phase 1 — Editor action and persistence

### Read first

- `src/host/attribute-authorization.ts`
- `src/host/visual-editor-provider.ts`
- `src/host/image-actions.ts`
- `src/cst/transform-apply.ts`

### Steps

1. Add the exact authorized `setHorizontalAlign` message shape and alignment action type.
2. Resolve every ID against the current parse, reject duplicates/stale IDs/unsupported elements, reject image+justify, and validate `baseStructVersion` before mutation. A `note` is eligible only when it is a whole editable text/inline-rich leaf according to `editableElementIds`; mixed or block-containing notes are rejected.
3. Apply native attributes to entries/images and managed outputclass tokens to other targets in one parse/edit cycle and one undo unit, preserving unrelated attributes and outputclass tokens.
4. Remove the legacy image mutation handler from the active protocol path and explicitly refuse `setImageAlign` with a resync/reload announcement.

### Acceptance

- Tests prove all eligible kinds, invalid payloads, stale IDs, unsupported containers, plain/inline-rich/mixed/block note predicates, image restrictions, outputclass preservation/normalization, Default semantics, atomic failure, and undo/redo behavior.

## Phase 2 — Editor UI and rendering

### Read first

- `media/canvas-command-bar-ui.js`
- `media/canvas-command-bar.js`
- `media/canvas-image-bar.js`
- `media/canvas-selection.js`
- `src/render/to-html.ts`
- `media/content-theme.css`

### Steps

1. Move horizontal alignment into Format and keep vertical alignment inside the conditional Table group.
2. Resolve eligible IDs from single, block-range, cell-rectangle, and mixed multi-set selections; never fall back to a caret target when an explicit unsupported selection exists. Mark document-drag multi-sets with a range origin and treat structural `section`/`row` units as transparent range artifacts; an explicitly selected unsupported container still disables alignment.
3. Show Default, the uniform active value, or Mixed. Disable unsupported selections and image-containing Justify with accessible reasons.
4. Route image L/C/R quick buttons through `setHorizontalAlign` with the current structure version.
5. Emit separate render-only authored alignment metadata for entries/images and retain existing effective CALS metadata for rendering. Toolbar state and Default use authored metadata, so inherited entry alignment is not mistaken for a local value; images also expose authored placement so reapplying the same alignment remains enabled when it must repair `placement="inline"` to `break`.
6. Add shared token CSS so canvas and read-only/redline views match persisted source. Use `!important` on `main .ditaeditor-align-*` rules declared in left, center, right, justify order; the selector deliberately does not depend on editable-only structural metadata. This guarantees managed alignment against later normal rules and class-only important rules; an equal/higher-specificity later `!important` rule is an explicit workspace override. The rule order implements `justify > right > center > left` for malformed conflicting tokens.

### Acceptance

- Browser/unit tests prove toolbar placement, state labels, cross-section range filtering, explicit unsupported selection refusal, target resolution, mixed selections, menu enablement, image quick-button routing, and table-only vertical controls.
- Computed-style tests exercise both editable canvas and read-only/redline markup, load representative later normal and class-only `!important` workspace CSS, and prove all four managed alignments plus conflict-token precedence. Tests also prove authored-vs-inherited entry state and inline-image repair behavior.
- Edited browser scripts pass `node --check`.

## Phase 3 — DITACraft publishing

### Read first

- `/Users/razvansarbu/Projects/ey/cms/ditacraft/AGENTS.md`
- `/Users/razvansarbu/Projects/ey/cms/ditacraft/css/etihad-shell.css`
- `/Users/razvansarbu/Projects/ey/cms/ditacraft/build.gradle.kts`
- DITA-OT PDF2 `dita.xsl.xslfo` and OOXML `document.xsl` / `block-style` extension points.

### Steps

1. Add the four managed CSS classes to the shared Etihad shell for HTML5 and EY PDF in left, center, right, justify order, yielding the global malformed-token precedence `justify > right > center > left`.
2. Add `dita-ot/plugins/com.ditacraft.alignment` with a PDF2 import that maps managed tokens to FO `text-align` using the explicit selection sequence justify, right, center, left.
3. Add a DOCX wrapper stylesheet that imports the existing OOXML document transform. For paragraph-producing nodes only, call the base `block-style`, then emit exactly one `w:jc`. Resolve the nearest managed eligible `ancestor-or-self` scope first (covering flattened direct-text notes and list items), then the nearest `entry/@align`; within a managed-token scope select justify, right, center, left. Map justify to `both`. A break image with its own native `@align` remains base-owned; an unaligned break image may inherit its entry alignment. Never emit paragraph justification from `entry`'s `w:tcPr` mode.
4. Re-integrate the vendored plug-ins and configure `ditaHospitalityDocx` with the wrapper `document.xsl`. Before integration, create a byte-for-byte temporary snapshot of the entire live `dita-ot` tree, record its path/existence manifest, and separately record hashes for every pre-existing publisher change. A same-path, normalized disposable integration established this exact installer-generated allowlist: `dita-ot/config/messages_en_US.properties`, `dita-ot/config/org.dita.dost.platform/plugin.properties`, `dita-ot/config/plugins.xml`, `dita-ot/lib/dost-configuration.jar`, `dita-ot/plugins/org.dita.base/build.xml`, `dita-ot/plugins/org.dita.base/catalog-dita.xml`, `dita-ot/plugins/org.dita.pdf2/xsl/fo/topic2fo_shell.xsl`, `dita-ot/plugins/org.dita.pdf2.axf/xsl/fo/topic2fo_shell_axf.xsl`, `dita-ot/plugins/org.dita.pdf2.fop/xsl/fo/topic2fo_shell_fop.xsl`, and `dita-ot/plugins/org.dita.pdf2.xep/xsl/fo/topic2fo_shell_xep.xsl`. The live run must match that literal set exactly. On any mismatch, restore every installer-mutated path from the full toolkit snapshot (or delete it only if it did not exist in the snapshot) without checkout/reset, then stop and re-plan. Generated integration files may be committed but must never be hand-edited.
5. Add a focused real DITA fixture used only for publishing verification.

### Acceptance

- HTML retains the managed classes and CSS mappings.
- Retained PDF2 FO contains `text-align` values for all four alignments and the focused PDF is visually inspected.
- HTML, FO, and DOCX produce the same `justify > right > center > left` result for a conflicting-token fixture.
- DOCX `word/document.xml` contains exactly one applicable `w:jc` with values `left`, `center`, `right`, or `both`, including aligned-list inheritance, flattened direct-text note inheritance, aligned-entry inheritance, child-over-entry precedence, locally aligned native images, and unaligned break-image entry inheritance. The DOCX ZIP and XML pass integrity/well-formedness checks and the package opens through an installed document reader/converter.
- Git diff contains no changes to pre-existing dirty DITA source files.

## Phase 4 — Full verification and hardening

### Steps

1. Run focused editor tests, `bun run typecheck`, `bun run build`, full `bun test`, and `bun run test:real-webview` without starting a dev server.
2. Run focused publisher fixture builds and inspect HTML, retained FO/PDF, and unzipped DOCX XML.
3. Run `./gradlew dita`, `./gradlew ditaHospitality`, `./gradlew ditaHospitalityPdf`, `./gradlew hospitalityPdfEYFormat`, and `./gradlew ditaHospitalityDocx`; inspect each agreed output.
4. Run independent correctness, regression/coupling, and adversarial failure-mode reviews. Fix confirmed P0/P1 findings and repeat reviews after code changes until no P0/P1 blockers remain.
5. Commit only scoped files in each repository.

### Acceptance

- Every command completes successfully this turn, output artifacts exist, and source/output inspection matches the agreed storage and rendering contract.
- Any UI fidelity not mechanically verifiable is reported as pending owner verification instead of complete.

## Goal coverage

| Goal | Proving phase/check |
| --- | --- |
| Horizontal alignment across eligible topic content | Phase 1 persistence tests + Phase 2 toolbar/selection tests |
| Images align through both toolbars | Phase 1 image action tests + Phase 2 quick/global toolbar tests |
| Multi-selection applies atomically | Phase 1 authorization/action tests |
| Vertical alignment remains table-only | Phase 2 command/image toolbar tests |
| Valid DITA persistence and Default behavior | Phase 1 source round-trip tests |
| Canvas and redline rendering | Phase 2 render/CSS tests + real-WebView check |
| HTML5 and EY PDF publishing | Phase 3 CSS fixture + Phase 4 real builds |
| PDF2 publishing | Phase 3 retained FO/focused PDF + Phase 4 real PDF build |
| DOCX publishing | Phase 3 unzipped fixture XML + Phase 4 real DOCX build |
| Preserve unrelated publisher work | Phase 3/4 path-scoped Git diff checks |

## Progress

- [x] Intent and acceptance criteria captured.
- [x] Plan hardening locked (three-lens convergence: zero P0/P1).
- [x] Phase 1 complete and verified.
- [x] Phase 2 complete and verified.
- [x] Phase 3 complete and verified.
- [x] Phase 4 feature verification complete; full-publisher exceptions are recorded below.
- [x] Scoped commit contents verified.

## Verification exceptions

- `./gradlew ditaHospitalityPdf` reaches the existing hospitality source but fails in vendor PDF2 table processing because `27-b777-300-3-class-a6-ets-ulh-nrt-kix.dita` has a row with an extra leading entry beneath a `morerows="1"` cell. The focused alignment PDF2 fixture succeeds and its retained FO/PDF contain the expected alignment values.
- `./gradlew hospitalityPdfEYFormat` was run against the full 231-topic HTML output. Headless Chrome intermittently produced no PDF and no stderr, causing many pages to be omitted; a five-topic retry reproduced the stall/empty-stderr behavior. The shared CSS is present in the successful HTML output and the focused HTML fixture retains every managed class.
- `./gradlew dita`, `./gradlew ditaHospitality`, and `./gradlew ditaHospitalityDocx` succeed. The final DOCX is a valid 293 MB package.
- Two user-owned publisher commits advanced `main` during verification. The remaining unrelated `.github` and `src/dita` changes were preserved and excluded from the feature commit.

## Owner/manual actions

- Confirm final toolbar appearance in the live editor if the automated real-WebView check cannot establish visual fidelity.
