import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

const css = fs.readFileSync(path.resolve(import.meta.dir, '../media/redline.css'), 'utf8');

describe('Review comparison width', () => {
  test('overrides the authoring page cap and preserves readable paired columns', () => {
    expect(css).toMatch(/body\.ditaeditor-canvas main\[role="main"\]\s*\{[^}]*width:\s*100%\s*!important/s);
    expect(css).toMatch(/body\.ditaeditor-canvas main\[role="main"\]\s*\{[^}]*max-width:\s*none\s*!important/s);
    expect(css).toMatch(/\.redline-side-by-side\s*\{[^}]*min-width:\s*1120px/s);
    expect(css).toMatch(/\.redline-multi-file\s*\{[^}]*min-width:\s*1120px/s);
  });

  test('keeps the single-column Track Changes layout at a readable line length', () => {
    expect(css).toMatch(/\.redline-review-view\[data-redline-view="inline"\]\s*\{[^}]*max-width:\s*1100px/s);
  });
});
