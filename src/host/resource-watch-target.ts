import { canonicalIdentity } from './workspace-files';
import {
  absoluteFileWatcherParts,
  configuredWorkspaceWatcherPath,
  resolvedWorkspaceWatcherPattern,
} from './workspace-watcher-path';

export interface WorkspaceResourceWatchTarget {
  configuredPath: string;
  lexicalPath: string;
  canonicalPath: string;
  identity: string;
}

export interface WorkspaceResourceWatcherSpecification {
  base: 'workspace' | 'absolute';
  basePath: string;
  pattern: string;
  key: string;
}

export function workspaceResourceWatcherSpecifications(
  target: WorkspaceResourceWatchTarget | null,
  workspaceFsPath: string | null,
  platform: NodeJS.Platform,
): WorkspaceResourceWatcherSpecification[] {
  if (!target || !workspaceFsPath) return [];
  const specifications: WorkspaceResourceWatcherSpecification[] = [];
  const lexicalPattern = resolvedWorkspaceWatcherPattern(
    workspaceFsPath,
    target.lexicalPath,
    platform,
  );
  if (lexicalPattern) {
    specifications.push({
      base: 'workspace',
      basePath: workspaceFsPath,
      pattern: lexicalPattern,
      key: `${workspaceFsPath}::${lexicalPattern}`,
    });
  }
  if (target.canonicalPath !== target.lexicalPath) {
    const canonical = absoluteFileWatcherParts(target.canonicalPath, platform);
    specifications.push({
      base: 'absolute',
      basePath: canonical.base,
      pattern: canonical.pattern,
      key: `${canonical.base}::${canonical.pattern}`,
    });
  }
  return specifications.filter(
    (specification, index, all) => all.findIndex((item) => item.key === specification.key) === index,
  );
}

export function updateWorkspaceResourceWatchTarget(params: {
  current: WorkspaceResourceWatchTarget | null;
  workspaceFsPath: string | null;
  configuredPath: string;
  resolved: { canonicalPath: string; identity: string } | null;
  platform: NodeJS.Platform;
}): WorkspaceResourceWatchTarget | null {
  const { current, workspaceFsPath, configuredPath, resolved, platform } = params;
  if (!workspaceFsPath || !configuredPath) return null;
  const lexicalPath = configuredWorkspaceWatcherPath(workspaceFsPath, configuredPath, platform);
  if (!lexicalPath) return null;
  const preserve = current?.configuredPath === configuredPath ? current : null;
  return {
    configuredPath,
    lexicalPath,
    canonicalPath: resolved?.canonicalPath ?? preserve?.canonicalPath ?? lexicalPath,
    identity: resolved?.identity ?? preserve?.identity ?? canonicalIdentity(lexicalPath, platform),
  };
}
