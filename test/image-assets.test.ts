import { describe, expect, test } from 'bun:test';
import {
  buildImagePickItems,
  buildImagePickItemsForDir,
  imageDirRelForHref,
  imageHrefForName,
  isImageAssetName,
} from '../src/commands/image-assets';

describe('image asset picker model', () => {
  test('recognizes supported image file extensions case-insensitively', () => {
    expect(isImageAssetName('img_001.jpeg')).toBe(true);
    expect(isImageAssetName('diagram.SVG')).toBe(true);
    expect(isImageAssetName('scan.tiff')).toBe(true);
    expect(isImageAssetName('topic.dita')).toBe(false);
    expect(isImageAssetName('img_001.jpeg.bak')).toBe(false);
  });

  test('derives the image directory from the current href', () => {
    expect(imageDirRelForHref('../images/img_061.jpeg')).toBe('../images');
    expect(imageDirRelForHref('images/sub/img_001.png')).toBe('images/sub');
    expect(imageDirRelForHref('img_001.png')).toBe('');
  });

  test('joins picker names back into hrefs without adding extra slashes', () => {
    expect(imageHrefForName('../images', 'img_062.jpeg')).toBe('../images/img_062.jpeg');
    expect(imageHrefForName('', 'img_062.jpeg')).toBe('img_062.jpeg');
  });

  test('sorts items alphabetically while putting the current source first', () => {
    const items = buildImagePickItems(
      ['img_063.jpeg', 'img_061.jpeg', 'img_062.jpeg'],
      '../images/img_062.jpeg',
    );
    expect(items.map((item) => item.href)).toEqual([
      '../images/img_062.jpeg',
      '../images/img_061.jpeg',
      '../images/img_063.jpeg',
    ]);
    expect(items[0]).toMatchObject({
      label: 'img_062.jpeg',
      description: '../images/img_062.jpeg  •  current source',
      isCurrent: true,
    });
    expect(items.slice(1).every((item) => item.isCurrent === false)).toBe(true);
  });

  test('builds picker hrefs for a directory before an image has a current href', () => {
    const items = buildImagePickItemsForDir(['img_062.jpeg', 'img_061.jpeg'], '../images');

    expect(items.map((item) => item.href)).toEqual([
      '../images/img_061.jpeg',
      '../images/img_062.jpeg',
    ]);
    expect(items.some((item) => item.isCurrent)).toBe(false);
  });
});
