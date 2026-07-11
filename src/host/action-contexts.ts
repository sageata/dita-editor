import type * as vscode from 'vscode';
import type { RangeActionAvailability } from '../webview/canvas-messages';
import type { AttributeActionContext } from './attribute-actions';
import type { ImageActionContext } from './image-actions';
import type { InlineActionContext } from './inline-actions';
import type { InsertActionContext } from './insert-actions';
import type { LineBreakActionContext } from './line-break-actions';
import type { RangeActionContext } from './range-actions';
import type { StructuralActionContext } from './structural-actions';

export interface VisualActionContextParams {
  document: vscode.TextDocument;
  folder: vscode.WorkspaceFolder | undefined;
  applyMinimal(newSource: string, history?: ApplyMinimalHistory): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  postError(message: string): void;
  clearDiagnostics(): void;
  setRefusedDiagnostic(op: string): void;
  getStructVersion(): number;
  bumpStructVersion(): void;
  postRangeAvailability(forIds: string[], actions: RangeActionAvailability[]): void;
}

export interface ApplyMinimalHistory {
  beforeFocusId?: string | null;
  beforeCaretOffset?: number | null;
  afterFocusId?: string | null;
  afterCaretOffset?: number | null;
}

export interface VisualActionContexts {
  imageActionContext(): ImageActionContext;
  attributeActionContext(): AttributeActionContext;
  inlineActionContext(): InlineActionContext;
  rangeActionContext(): RangeActionContext;
  insertActionContext(): InsertActionContext;
  lineBreakActionContext(): LineBreakActionContext;
  structuralActionContext(): StructuralActionContext;
}

export function createVisualActionContexts(params: VisualActionContextParams): VisualActionContexts {
  return {
    imageActionContext: () => ({
      document: params.document,
      folder: params.folder,
      applyMinimal: params.applyMinimal,
      pushBody: params.pushBody,
      announce: params.announce,
      clearDiagnostics: params.clearDiagnostics,
    }),
    attributeActionContext: () => ({
      document: params.document,
      applyMinimal: params.applyMinimal,
      pushBody: params.pushBody,
      announce: params.announce,
      postError: params.postError,
      clearDiagnostics: params.clearDiagnostics,
    }),
    inlineActionContext: () => ({
      document: params.document,
      applyMinimal: params.applyMinimal,
      pushBody: params.pushBody,
      announce: params.announce,
      clearDiagnostics: params.clearDiagnostics,
      getStructVersion: params.getStructVersion,
      bumpStructVersion: params.bumpStructVersion,
    }),
    rangeActionContext: () => ({
      document: params.document,
      applyMinimal: params.applyMinimal,
      pushBody: params.pushBody,
      announce: params.announce,
      clearDiagnostics: params.clearDiagnostics,
      postRangeAvailability: params.postRangeAvailability,
    }),
    insertActionContext: () => ({
      document: params.document,
      applyMinimal: params.applyMinimal,
      pushBody: params.pushBody,
      announce: params.announce,
      clearDiagnostics: params.clearDiagnostics,
      setRefusedDiagnostic: params.setRefusedDiagnostic,
      bumpStructVersion: params.bumpStructVersion,
    }),
    lineBreakActionContext: () => ({
      document: params.document,
      applyMinimal: params.applyMinimal,
      pushBody: params.pushBody,
      announce: params.announce,
      clearDiagnostics: params.clearDiagnostics,
      setRefusedDiagnostic: params.setRefusedDiagnostic,
      bumpStructVersion: params.bumpStructVersion,
    }),
    structuralActionContext: () => ({
      document: params.document,
      applyMinimal: params.applyMinimal,
      pushBody: params.pushBody,
      announce: params.announce,
      postError: params.postError,
      clearDiagnostics: params.clearDiagnostics,
      setRefusedDiagnostic: params.setRefusedDiagnostic,
      getStructVersion: params.getStructVersion,
      bumpStructVersion: params.bumpStructVersion,
    }),
  };
}
