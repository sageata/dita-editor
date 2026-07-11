import { readFileSync } from 'node:fs';

const CATEGORIES = [
  ['command', collectCommands],
  ['setting', collectSettings],
  ['view', collectViews],
  ['language', collectLanguages],
  ['activation-event', collectActivationEvents],
  ['file-association', collectFileAssociations],
  ['editor', collectEditors],
  ['editor-selector', collectEditorSelectors],
];

function strings(values) {
  return new Set(values.filter((value) => typeof value === 'string' && value.length > 0));
}

function collectCommands(manifest) {
  return strings((manifest.contributes?.commands ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry?.command));
}

function collectSettings(manifest) {
  if (Array.isArray(manifest.contributes?.settings)) return strings(manifest.contributes.settings);
  const configuration = manifest.contributes?.configuration;
  const sections = Array.isArray(configuration)
    ? configuration
    : configuration
      ? [configuration]
      : [];
  return strings(sections.flatMap((section) => Object.keys(section?.properties ?? {})));
}

function collectViews(manifest) {
  if (Array.isArray(manifest.contributes?.views)) return strings(manifest.contributes.views);
  const groups = Object.values(manifest.contributes?.views ?? {});
  return strings(groups.flatMap((group) =>
    Array.isArray(group) ? group.map((entry) => entry?.id) : [],
  ));
}

function collectLanguages(manifest) {
  return strings((manifest.contributes?.languages ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry?.id));
}

function collectActivationEvents(manifest) {
  return strings(manifest.activationEvents ?? []);
}

function collectFileAssociations(manifest) {
  return strings((manifest.contributes?.languages ?? []).flatMap((entry) =>
    typeof entry === 'object' && entry !== null
      ? [...(entry.extensions ?? []), ...(entry.filenames ?? []), ...(entry.filenamePatterns ?? [])]
      : []));
}

function collectEditors(manifest) {
  return strings((manifest.contributes?.customEditors ?? []).map((entry) => entry?.viewType));
}

function collectEditorSelectors(manifest) {
  return strings((manifest.contributes?.customEditors ?? []).flatMap((entry) =>
    (entry?.selector ?? []).map((selector) => selector?.filenamePattern)));
}

function manifestLabel(manifest) {
  const extensionId = [manifest.publisher, manifest.name].filter(Boolean).join('.');
  const version = manifest.version ? `@${manifest.version}` : '';
  return `${extensionId || '<unnamed extension>'}${version}`;
}

function exactCollisions(left, right) {
  const exact = CATEGORIES.flatMap(([category, collect]) => {
    const rightIds = collect(right);
    return [...collect(left)]
      .filter((id) => rightIds.has(id))
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ category, id }));
  });
  const leftEditors = editorSummary(left);
  const rightEditors = editorSummary(right);
  for (const leftEditor of leftEditors) {
    for (const rightEditor of rightEditors) {
      const sharedSelectors = leftEditor.selectors.filter((selector) =>
        rightEditor.selectors.includes(selector));
      if (sharedSelectors.length === 0 || leftEditor.priority !== rightEditor.priority) continue;
      exact.push({ category: 'editor-priority', id: leftEditor.priority });
      if (leftEditor.priority === 'default' && sharedSelectors.includes('*.dita')) {
        exact.push({ category: 'competing-default-editor', id: '*.dita' });
      }
    }
  }
  return exact.filter((collision, index, collisions) =>
    collisions.findIndex((candidate) =>
      candidate.category === collision.category && candidate.id === collision.id) === index);
}

function readManifest(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed.manifest ?? parsed;
}

function editorSummary(manifest) {
  return (manifest.contributes?.customEditors ?? []).map((editor) => ({
    viewType: editor.viewType,
    priority: editor.priority ?? 'default',
    selectors: (editor.selector ?? []).map((selector) => selector.filenamePattern).filter(Boolean),
  }));
}

const [leftPath, rightPath] = process.argv.slice(2);
if (!leftPath || !rightPath) {
  console.error('Usage: node scripts/compare-extension-manifests.mjs <left-package.json> <right-package.json>');
  process.exitCode = 2;
} else {
  try {
    const left = readManifest(leftPath);
    const right = readManifest(rightPath);
    const collisions = exactCollisions(left, right);
    if (collisions.length > 0) {
      console.error('Exact contribution collisions found:');
      for (const collision of collisions) {
        console.error(`${collision.category}: ${collision.id}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`Compared ${manifestLabel(left)} with ${manifestLabel(right)}.`);
      console.log('No exact contribution collisions.');
      console.log(`Activation events inspected: ${collectActivationEvents(left).size} and ${collectActivationEvents(right).size}.`);
      console.log(`Custom editors inspected: ${JSON.stringify(editorSummary(left))} and ${JSON.stringify(editorSummary(right))}.`);
    }
  } catch (error) {
    console.error(`Manifest comparison failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
