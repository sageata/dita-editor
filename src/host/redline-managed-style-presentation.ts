import type { ManagedStylesInspection } from './managed-author-stylesheet';
import { authorStyleNames } from './author-style-source';

export interface RedlineManagedStylesMessage {
  type: 'managedStyles';
  cssText: string;
}

export interface RedlineManagedStylePresentation {
  styleNames: ReadonlyMap<string, string>;
  message: RedlineManagedStylesMessage;
}

/**
 * Derive both redline consumers from one host inspection. This keeps friendly
 * outputclass labels and the exact CSS sent to the webview on the same source
 * snapshot, including developer-owned bytes outside the managed region.
 */
export function redlineManagedStylePresentation(
  inspection: Pick<ManagedStylesInspection, 'styles' | 'renderCssText'>,
): RedlineManagedStylePresentation {
  return {
    styleNames: authorStyleNames(inspection.styles),
    message: {
      type: 'managedStyles',
      cssText: inspection.renderCssText,
    },
  };
}
