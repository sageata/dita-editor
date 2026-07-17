import path from 'node:path';
import { Buffer } from 'node:buffer';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { parseFragment, serialize } from 'parse5';

export interface ReviewExportStylesheet {
  /** Complete stylesheet bytes captured with the rendered review. */
  cssText: string;
  /** Absolute URI used to resolve this sheet's imports and url(...) values. */
  baseUri: string;
}

export interface ReviewExportSnapshot {
  title: string;
  defaultFilename: string;
  bodyHtml: string;
  /** Neutral → configured workspace → managed author → redline surface. */
  stylesheets: ReviewExportStylesheet[];
  /** One base for single-file exports; one per data-redline-file for multi-file. */
  imageBaseUris: string[];
}

export interface ReviewExportResource {
  content: Uint8Array;
  mediaType?: string;
  /** Effective URL after redirects, used as the base for nested CSS resources. */
  resolvedUri?: string;
}

export type ReviewExportResourceReader = (absoluteUri: string) => Promise<ReviewExportResource>;

export class ReviewExportSnapshotStore {
  private snapshot: ReviewExportSnapshot | undefined;

  replace(snapshot: ReviewExportSnapshot): void {
    this.snapshot = snapshot;
  }

  current(): ReviewExportSnapshot | undefined {
    return this.snapshot;
  }
}

export interface ReviewExportSaveAdapter {
  chooseDestination(defaultFilename: string): Promise<string | undefined>;
  readResource: ReviewExportResourceReader;
  write(destination: string, completeHtml: string): Promise<void>;
  log(message: string): void;
  showError(message: string): PromiseLike<unknown>;
}

interface HtmlAttribute {
  name: string;
  value: string;
}

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attribute(node: HtmlNode, name: string): HtmlAttribute | undefined {
  return node.attrs?.find((candidate) => candidate.name === name);
}

function hasAttribute(node: HtmlNode, name: string): boolean {
  return attribute(node, name) !== undefined;
}

function removeAttribute(node: HtmlNode, name: string): void {
  if (node.attrs) node.attrs = node.attrs.filter((candidate) => candidate.name !== name);
}

function makeStatic(node: HtmlNode): void {
  if (!node.childNodes) return;
  node.childNodes = node.childNodes.filter((child) => {
    if (child.tagName === 'script') return false;
    if (child.tagName === 'button' && !hasAttribute(child, 'data-redline-nav')) return false;
    makeStatic(child);
    return true;
  });
  if (hasAttribute(node, 'data-redline-unchanged-rows')) removeAttribute(node, 'hidden');
}

async function inlineHtmlImages(
  node: HtmlNode,
  imageBaseUris: readonly string[],
  readResource: ReviewExportResourceReader,
  state: { fileIndex: number },
  inheritedBase = imageBaseUris[0],
): Promise<void> {
  let baseUri = inheritedBase;
  if (hasAttribute(node, 'data-redline-file')) {
    baseUri = imageBaseUris[state.fileIndex];
    state.fileIndex += 1;
    if (!baseUri) {
      throw new Error(`No image base was captured for comparison file ${state.fileIndex}.`);
    }
  }
  if (node.tagName === 'img') {
    const source = attribute(node, 'src');
    if (source && source.value && !/^data:/i.test(source.value)) {
      if (!baseUri) throw new Error(`No image base was captured for ${source.value}.`);
      const absoluteUri = resourceUri(source.value, baseUri);
      source.value = dataUri(absoluteUri, await readResource(absoluteUri));
    }
  }
  for (const child of node.childNodes ?? []) {
    await inlineHtmlImages(child, imageBaseUris, readResource, state, baseUri);
  }
}

function safeStyleText(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

function safeScriptText(script: string): string {
  return script.replace(/<\/script/gi, '<\\/script');
}

const EXPORT_NAVIGATION_SCRIPT = '(function(){var i=-1,q=function(s){return Array.from(document.querySelectorAll(s));},c=function(){return q("[data-redline-change]");};' +
  'function u(a){q("[data-redline-position]").forEach(function(s){s.textContent="Change "+(i<0?0:i+1)+" of "+a.length;});' +
  'q("[data-redline-nav]").forEach(function(b){b.disabled=!a.length;b.setAttribute("aria-disabled",String(!a.length));});}' +
  'function n(d){var a=c();if(!a.length){i=-1;u(a);return;}i=i<0?(d==="previous"?a.length-1:0):d==="previous"?(i<=0?a.length-1:i-1):(i>=a.length-1?0:i+1);' +
  'a.forEach(function(r,x){if(x===i){r.setAttribute("data-redline-active","true");r.setAttribute("aria-current","true");}else{r.removeAttribute("data-redline-active");r.removeAttribute("aria-current");}});u(a);' +
  'a[i].scrollIntoView({block:"center",behavior:"auto"});a[i].focus({preventScroll:true});}' +
  'document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-redline-nav]");if(b&&!b.disabled)n(b.getAttribute("data-redline-nav"));});u(c());})();';

function resourceUri(reference: string, baseUri: string): string {
  let resolved: URL;
  try {
    resolved = new URL(reference, baseUri);
  } catch {
    throw new Error(`Could not resolve resource ${JSON.stringify(reference)} from ${baseUri}.`);
  }
  if (resolved.protocol !== 'file:' && resolved.protocol !== 'https:') {
    throw new Error(`Unsupported export resource protocol ${resolved.protocol} for ${resolved.toString()}.`);
  }
  return resolved.toString();
}

function inferredMediaType(uri: string): string {
  const extension = path.extname(new URL(uri).pathname).toLowerCase();
  const types: Record<string, string> = {
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extension] ?? 'application/octet-stream';
}

function dataUri(uri: string, resource: ReviewExportResource): string {
  const mediaType = resource.mediaType?.split(';', 1)[0].trim() || inferredMediaType(uri);
  return `data:${mediaType};base64,${Buffer.from(resource.content).toString('base64')}`;
}

function importReference(params: string): { reference: string; conditions: string } {
  const parsed = valueParser(params);
  const first = parsed.nodes.find((node) => node.type !== 'space' && node.type !== 'comment');
  if (!first) throw new Error('CSS @import is missing a resource URL.');
  let reference: string;
  if (first.type === 'string') {
    reference = first.value;
  } else if (first.type === 'function' && first.value.toLowerCase() === 'url') {
    const value = first.nodes.find((node) => node.type !== 'space' && node.type !== 'comment');
    if (!value || (value.type !== 'string' && value.type !== 'word')) {
      throw new Error(`CSS @import has an invalid url(): ${params}`);
    }
    reference = value.value;
  } else {
    throw new Error(`CSS @import has an unsupported target: ${params}`);
  }
  return { reference, conditions: params.slice(first.sourceEndIndex).trim() };
}

function importConditionWrappers(conditions: string): Array<{ name: string; params: string }> {
  const parsed = valueParser(conditions);
  const nodes = parsed.nodes;
  const wrappers: Array<{ name: string; params: string }> = [];
  let index = 0;
  const skipWhitespace = (): void => {
    while (nodes[index]?.type === 'space' || nodes[index]?.type === 'comment') index += 1;
  };

  skipWhitespace();
  const layer = nodes[index];
  if (layer?.type === 'function' && layer.value.toLowerCase() === 'layer') {
    wrappers.push({ name: 'layer', params: valueParser.stringify(layer.nodes).trim() });
    index += 1;
  } else if (layer?.type === 'word' && layer.value.toLowerCase() === 'layer') {
    wrappers.push({ name: 'layer', params: '' });
    index += 1;
  }

  skipWhitespace();
  const supports = nodes[index];
  if (supports?.type === 'function' && supports.value.toLowerCase() === 'supports') {
    wrappers.push({
      name: 'supports',
      params: `(${valueParser.stringify(supports.nodes).trim()})`,
    });
    index += 1;
  }

  skipWhitespace();
  if (nodes[index]) {
    wrappers.push({
      name: 'media',
      params: conditions.slice(nodes[index].sourceIndex).trim(),
    });
  }
  return wrappers;
}

function wrapImportedNodes(
  nodes: import('postcss').ChildNode[],
  conditions: string,
): import('postcss').ChildNode[] {
  let wrapped = nodes;
  const wrappers = importConditionWrappers(conditions);
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    const wrapper = wrappers[index];
    const atRule = postcss.atRule({ name: wrapper.name, params: wrapper.params });
    atRule.append(...wrapped);
    wrapped = [atRule];
  }
  return wrapped;
}

async function inlineCssUrls(
  root: ReturnType<typeof postcss.parse>,
  baseUri: string,
  readResource: ReviewExportResourceReader,
): Promise<void> {
  const declarations: Array<{ value: string }> = [];
  root.walkDecls((declaration) => { declarations.push(declaration); });
  for (const declaration of declarations) {
    const parsed = valueParser(declaration.value);
    const urls: Array<{ value: string; nodes: unknown[] }> = [];
    parsed.walk((node) => {
      if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
      const value = node.nodes.find((child) => child.type !== 'space' && child.type !== 'comment');
      if (!value || (value.type !== 'string' && value.type !== 'word')) {
        throw new Error(`CSS declaration has an invalid url(): ${declaration.value}`);
      }
      urls.push({ value: value.value, nodes: node.nodes });
    });
    for (const url of urls) {
      if (/^(?:data:|#)/i.test(url.value)) continue;
      const absoluteUri = resourceUri(url.value, baseUri);
      const resource = await readResource(absoluteUri);
      const encoded = dataUri(absoluteUri, resource);
      const target = url.nodes.find((node) => {
        const candidate = node as { type?: string };
        return candidate.type !== 'space' && candidate.type !== 'comment';
      }) as { type: string; value: string; quote?: string } | undefined;
      if (!target) throw new Error(`CSS declaration has an empty url(): ${declaration.value}`);
      target.type = 'word';
      target.value = encoded;
      delete target.quote;
    }
    declaration.value = parsed.toString();
  }
}

async function inlineStylesheet(
  stylesheet: ReviewExportStylesheet,
  readResource: ReviewExportResourceReader,
  ancestry = new Set<string>(),
): Promise<string> {
  if (ancestry.has(stylesheet.baseUri)) {
    throw new Error(`Circular CSS @import detected at ${stylesheet.baseUri}.`);
  }
  const nextAncestry = new Set(ancestry).add(stylesheet.baseUri);
  const root = postcss.parse(stylesheet.cssText, { from: stylesheet.baseUri });
  const imports: import('postcss').AtRule[] = [];
  root.walkAtRules('import', (atRule) => { imports.push(atRule); });
  for (const atRule of imports) {
    const imported = importReference(atRule.params);
    if (/^data:/i.test(imported.reference)) {
      throw new Error(`Data URI CSS imports are not supported in ${stylesheet.baseUri}.`);
    }
    const absoluteUri = resourceUri(imported.reference, stylesheet.baseUri);
    const resource = await readResource(absoluteUri);
    const importedBaseUri = resource.resolvedUri ?? absoluteUri;
    const cssText = new TextDecoder().decode(resource.content);
    const inlined = await inlineStylesheet(
      { cssText, baseUri: importedBaseUri },
      readResource,
      nextAncestry,
    );
    const replacement = postcss.parse(inlined, { from: importedBaseUri });
    atRule.replaceWith(...wrapImportedNodes(replacement.nodes, imported.conditions));
  }
  root.walkAtRules('charset', (atRule) => { atRule.remove(); });
  await inlineCssUrls(root, stylesheet.baseUri, readResource);
  return root.toString();
}

/**
 * Build the complete file in memory. Callers write the returned string once;
 * any resource failure rejects before a destination is touched.
 */
export async function buildReviewExportHtml(
  snapshot: ReviewExportSnapshot,
  readResource: ReviewExportResourceReader,
): Promise<string> {
  const fragment = parseFragment(snapshot.bodyHtml) as unknown as HtmlNode;
  await inlineHtmlImages(fragment, snapshot.imageBaseUris, readResource, { fileIndex: 0 });
  makeStatic(fragment);
  const body = serialize(fragment as never);
  const sheets: string[] = [];
  for (const stylesheet of snapshot.stylesheets) {
    sheets.push(await inlineStylesheet(stylesheet, readResource));
  }
  return '<!DOCTYPE html>\n'
    + '<html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="color-scheme" content="light">'
    + `<title>${escapeHtml(snapshot.title)}</title>`
    + `<style>${safeStyleText(sheets.join('\n'))}</style>`
    + '</head><body class="ditaeditor-canvas"><main role="main">'
    + body
    + `</main><script>${safeScriptText(EXPORT_NAVIGATION_SCRIPT)}</script></body></html>`;
}

export async function saveReviewExport(
  snapshots: ReviewExportSnapshotStore,
  adapter: ReviewExportSaveAdapter,
): Promise<'saved' | 'cancelled' | 'failed'> {
  const snapshot = snapshots.current();
  if (!snapshot) {
    const message = 'DITA Editor: no successfully rendered comparison is available to export.';
    adapter.log(message);
    await adapter.showError(message);
    return 'failed';
  }
  const destination = await adapter.chooseDestination(snapshot.defaultFilename);
  if (!destination) return 'cancelled';
  try {
    const completeHtml = await buildReviewExportHtml(snapshot, adapter.readResource);
    await adapter.write(destination, completeHtml);
    return 'saved';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    adapter.log(`DITA Editor: HTML comparison export failed: ${detail}`);
    await adapter.showError(`DITA Editor: HTML export failed: ${detail}`);
    return 'failed';
  }
}
