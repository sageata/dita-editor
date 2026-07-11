const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?)$/i;

export interface ImagePickModelItem {
  label: string;
  description: string;
  href: string;
  isCurrent: boolean;
}

export function isImageAssetName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function imageDirRelForHref(href: string): string {
  const slash = href.lastIndexOf('/');
  return slash >= 0 ? href.slice(0, slash) : '';
}

export function imageHrefForName(dirRel: string, name: string): string {
  return dirRel ? `${dirRel}/${name}` : name;
}

export function buildImagePickItemsForDir(
  names: string[],
  dirRel: string,
  currentHref = '',
): ImagePickModelItem[] {
  return names
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const href = imageHrefForName(dirRel, name);
      const isCurrent = href === currentHref;
      return {
        label: name,
        description: isCurrent ? `${href}  •  current source` : href,
        href,
        isCurrent,
      };
    })
    .sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : 0));
}

export function buildImagePickItems(names: string[], currentHref: string): ImagePickModelItem[] {
  return buildImagePickItemsForDir(names, imageDirRelForHref(currentHref), currentHref);
}
