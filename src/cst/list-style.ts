import type { ElementNode } from './types';

export type ListStyle = 'unordered' | 'alpha' | 'ordered';

export const ALPHA_OUTPUTCLASS = 'lower-alpha';

export function attrValue(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((attr) => attr.name === name)?.value;
}

export function outputclassTokens(el: ElementNode): string[] {
  return (attrValue(el, 'outputclass') ?? '').split(/\s+/g).filter((token) => token.length > 0);
}

export function hasAlphaOutputclass(el: ElementNode): boolean {
  return outputclassTokens(el).includes(ALPHA_OUTPUTCLASS);
}

export function listStyle(el: ElementNode): ListStyle {
  if (el.name === 'ul') return 'unordered';
  return hasAlphaOutputclass(el) ? 'alpha' : 'ordered';
}

export function listNameForStyle(style: ListStyle): 'ul' | 'ol' {
  return style === 'unordered' ? 'ul' : 'ol';
}

export function listAttrsForStyle(style: ListStyle): Array<{ name: string; value: string; quote?: '"' | "'" }> {
  return style === 'alpha' ? [{ name: 'outputclass', value: ALPHA_OUTPUTCLASS }] : [];
}

export function nextNestedListStyle(style: ListStyle): ListStyle {
  if (style === 'unordered') return 'unordered';
  if (style === 'alpha') return 'ordered';
  return 'unordered';
}

export function outputclassWithAlpha(value: string | undefined): string {
  const tokens = (value ?? '').split(/\s+/g).filter((token) => token.length > 0);
  if (!tokens.includes(ALPHA_OUTPUTCLASS)) tokens.push(ALPHA_OUTPUTCLASS);
  return tokens.join(' ');
}

export function outputclassWithoutAlpha(value: string | undefined): string | null {
  const tokens = (value ?? '').split(/\s+/g).filter((token) => token.length > 0 && token !== ALPHA_OUTPUTCLASS);
  return tokens.length > 0 ? tokens.join(' ') : null;
}
