import { serializeAuthorStyles } from '../styles/author-styles';
import type { ManagedStylesInspection } from './managed-author-stylesheet';
import { authorStyleNames } from './author-style-source';

export interface RedlineManagedStylesMessage {
  type: 'managedStyles';
  cssText: string;
  stylesheetHref?: string;
}

export interface RedlineManagedStylePresentation {
  styleNames: ReadonlyMap<string, string>;
  message: RedlineManagedStylesMessage;
}

/** Derive friendly outputclass labels and the temporary generated live layer
 * from the same inspection used by the linked repository stylesheet. */
export function redlineManagedStylePresentation(
  inspection: Pick<ManagedStylesInspection, 'kind' | 'styles'>,
  stylesheetHref?: string,
): RedlineManagedStylePresentation {
  return {
    styleNames: authorStyleNames(inspection.styles),
    message: {
      type: 'managedStyles',
      cssText: inspection.kind === 'refused' || inspection.styles.length === 0
        ? ''
        : serializeAuthorStyles(inspection.styles),
      ...(stylesheetHref ? { stylesheetHref } : {}),
    },
  };
}
