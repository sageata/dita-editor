import { parse } from '../cst/parse';
import { renderEditable } from '../render/to-html';
import type { AvailabilityMap } from '../commands/validity';
import {
  buildCmdMap,
  buildDocProps,
  buildInsertMap,
  buildNavMap,
  buildTransformMap,
  type DocProps,
  type InsertMap,
  type NavMap,
  type TransformMap,
} from '../webview/state-maps';

export interface RenderStateDocument {
  getText(): string;
}

export interface RenderSnapshot {
  navMap: NavMap;
  cmdMap: AvailabilityMap;
  transformMap: TransformMap;
  insertMap: InsertMap;
  docProps: DocProps;
}

export interface VisualRenderState {
  renderBody(focusId?: string | null): string;
  snapshot(): RenderSnapshot;
}

export function createVisualRenderState(
  document: RenderStateDocument,
  imageVersion: string,
  logError: (message: string, error: unknown) => void = console.error,
): VisualRenderState {
  let navMap: NavMap = {};
  let cmdMap: AvailabilityMap = {};
  let transformMap: TransformMap = {};
  let insertMap: InsertMap = {};
  let docProps: DocProps = null;

  const clearSnapshot = (): void => {
    navMap = {};
    cmdMap = {};
    transformMap = {};
    insertMap = {};
    docProps = null;
  };

  return {
    renderBody(focusId?: string | null): string {
      try {
        const doc = parse(document.getText());
        const html = renderEditable(doc, focusId, imageVersion);
        navMap = buildNavMap(doc);
        cmdMap = buildCmdMap(doc);
        transformMap = buildTransformMap(doc);
        insertMap = buildInsertMap(doc);
        docProps = buildDocProps(doc);
        return html;
      } catch (err) {
        logError('dita-editor: render failed', err);
        clearSnapshot();
        return `<pre class="dita-parse-error">DITA could not be rendered (the XML may be mid-edit or invalid):\n${escapeHtml(String(err))}</pre>`;
      }
    },
    snapshot(): RenderSnapshot {
      return {
        navMap,
        cmdMap,
        transformMap,
        insertMap,
        docProps,
      };
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
