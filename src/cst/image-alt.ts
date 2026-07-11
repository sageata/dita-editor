import { insertNode, makeElement, makeText, removeNode, setElementText } from './edit';
import { decodeEntities } from './inline-marks';
import { firstChildNamed } from './query';
import type { CstNode, ElementNode } from './types';
import { isElement } from './types';

export type ImageAltEditResult = 'added' | 'updated' | 'cleared' | 'unchanged';

function decodedText(node: CstNode): string {
  if (node.type === 'text') return node.newText !== undefined ? node.newText : decodeEntities(node.raw);
  if (isElement(node)) return node.children.map(decodedText).join('');
  return '';
}

export function imageAltText(image: ElementNode): string {
  if (image.name !== 'image') throw new Error('imageAltText requires an <image> element');
  const alt = firstChildNamed(image, 'alt');
  return alt ? alt.children.map(decodedText).join('') : '';
}

export function applyImageAlt(image: ElementNode, decoded: string): ImageAltEditResult {
  if (image.name !== 'image') throw new Error('applyImageAlt requires an <image> element');
  const current = imageAltText(image);
  if (decoded === current) return 'unchanged';

  const existing = firstChildNamed(image, 'alt');
  if (decoded === '') {
    if (!existing) return 'unchanged';
    removeNode(existing);
    return 'cleared';
  }

  if (existing) {
    setElementText(existing, decoded);
    return 'updated';
  }

  insertNode(image, image.children.length, makeElement('alt', [], [makeText(decoded)]));
  return 'added';
}
