# Topic-wide alignment delivery summary

## Delivered

- One closed, versioned, atomic horizontal-alignment action for eligible topic content, table entries, and images.
- General Format toolbar state and multi-selection behavior, with table-only vertical alignment retained.
- Native DITA persistence for CALS entries/images and reserved outputclass persistence for other eligible content.
- Shared editor/redline rendering plus DITACraft HTML/EY-PDF CSS parity.
- Project-owned DITA-OT PDF2 and DOCX extensions, including conflict-token precedence and Word `both` mapping for justify.
- Focused publishing fixtures and real-WebView native-image undo/redo coverage.

## Verification

- `bun test`: 1,621 pass, 1 expected skip, 0 fail.
- `bun run typecheck`: pass.
- `bun run build`: pass.
- `bun run test:real-webview`: 1 pass, 0 fail.
- Focused HTML5, PDF2, and DOCX fixtures: pass with artifact inspection.
- `./gradlew dita`: pass.
- `./gradlew ditaHospitality`: pass.
- `./gradlew ditaHospitalityDocx`: pass; 293.03 MB DOCX with valid ZIP/XML.
- Final three-lens review: zero P0/P1 findings.

## Existing publisher blockers observed

- Full hospitality PDF2 fails on an existing invalid CALS row in `27-b777-300-3-class-a6-ets-ulh-nrt-kix.dita`.
- The Chrome EY-PDF runner intermittently stalls or exits without a PDF and with empty stderr, so the full output is incomplete.

## Scope preservation

Publisher staging is restricted to the 18 feature-owned paths. All unrelated `.github` and `src/dita` work remains unstaged.
