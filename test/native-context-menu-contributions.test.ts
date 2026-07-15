import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const contributes = manifest.contributes;
const nativeCommands = contributes.commands.filter((entry: any) => entry.command.startsWith('ditaeditor.context.'));
const nativeCommandIds = new Set<string>(nativeCommands.map((entry: any) => entry.command));
const nativeSubmenus = new Set(contributes.submenus.map((entry: any) => entry.id));
const menus = contributes.menus as Record<string, Array<Record<string, string>>>;

describe('native VS Code context menu contributions', () => {
  test('declares every menu command and submenu and keeps internal commands out of the palette', () => {
    for (const [menuId, entries] of Object.entries(menus)) {
      if (menuId !== 'webview/context' && !menuId.startsWith('ditaeditor.context.')) continue;
      for (const entry of entries) {
        if (entry.command) expect(nativeCommandIds.has(entry.command)).toBe(true);
        if (entry.submenu) expect(nativeSubmenus.has(entry.submenu)).toBe(true);
      }
    }
    const hidden = new Set<string>(
      menus.commandPalette
        .filter((entry) => entry.when === 'false')
        .map((entry) => entry.command),
    );
    expect([...nativeCommandIds].every((id) => hidden.has(id))).toBe(true);
  });

  test('scopes every top-level item to the visual webview and exposes all target families', () => {
    const top = menus['webview/context'];
    expect(top.every((entry) => entry.when.includes("webviewId == 'ditaeditor.visual'"))).toBe(true);
    const joined = top.map((entry) => `${entry.command || entry.submenu} ${entry.when}`).join('\n');
    for (const family of ['ditaNativeContext == \'image\'', 'ditaNativeContext == \'element\'', 'ditaNativeContext == \'cell\'']) {
      expect(joined).toContain(family);
    }
    for (const slot of ['selfBefore', 'selfAfter', 'selfInto', 'cellInto', 'tableAfter', 'figureAfter']) {
      expect(joined).toContain(`ditaNativeHas.${slot}`);
    }
  });

  test('preserves the contextual submenu labels and disabled-state expressions', () => {
    expect(contributes.submenus.map((entry: any) => entry.label)).toEqual([
      'Convert to', 'Convert content', 'Row', 'Column', 'Borders', 'Align text',
      'Vertical align', 'Shading', 'Table settings', 'Insert before', 'Insert after',
      'Insert inside', 'Insert inside cell', 'Insert after table', 'Insert after figure',
    ]);
    for (const command of nativeCommands) {
      if (command.command.includes('.insert.') || command.command.includes('.transform.') || command.command.includes('.structural.')
        || command.command.includes('.delete.') || command.command.includes('.range.') || command.command.includes('.cals.')) {
        expect(command.enablement).toBe(`ditaNativeEnabled.${command.command.slice('ditaeditor.context.'.length)}`);
      }
    }
    expect(nativeCommandIds.has('ditaeditor.context.image.pick')).toBe(true);
    expect(nativeCommandIds.has('ditaeditor.context.image.alt')).toBe(true);
    expect(nativeCommandIds.has('ditaeditor.context.image.resize')).toBe(true);
    expect(nativeCommandIds.has('ditaeditor.context.range.cellRectMerge')).toBe(true);
  });
});
