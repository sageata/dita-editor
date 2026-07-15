export const NATIVE_CONTEXT_COMMAND_PREFIX = 'ditaeditor.context.';
export const NATIVE_CONTEXT_WEBVIEW_TYPE = 'ditaeditor.visual';

export interface NativeContextEndpoint {
  postMessage(message: unknown): unknown;
}

export type NativeContextRouteResult =
  | { ok: true }
  | { ok: false; reason: 'missing-context' | 'foreign-context' | 'unknown-session' };

export function nativeContextCommandIds(packageJson: unknown): string[] {
  const commands = (packageJson as { contributes?: { commands?: unknown } } | null)?.contributes?.commands;
  if (!Array.isArray(commands)) return [];
  return commands
    .map((entry: unknown) => (entry && typeof entry === 'object' && 'command' in entry
      ? (entry as { command?: unknown }).command
      : null))
    .filter((command): command is string =>
      typeof command === 'string' && command.startsWith(NATIVE_CONTEXT_COMMAND_PREFIX));
}

export function routeNativeContextCommand(
  command: string,
  argument: unknown,
  endpoints: ReadonlyMap<string, NativeContextEndpoint>,
): NativeContextRouteResult {
  if (!argument || typeof argument !== 'object') return { ok: false, reason: 'missing-context' };
  const context = argument as Record<string, unknown>;
  const session = context.ditaNativeSession;
  if (context.webview !== NATIVE_CONTEXT_WEBVIEW_TYPE || typeof session !== 'string') {
    return { ok: false, reason: 'foreign-context' };
  }
  const target = endpoints.get(session);
  if (!target) return { ok: false, reason: 'unknown-session' };
  void target.postMessage({ type: 'nativeContextCommand', command, context });
  return { ok: true };
}

export function isFreshNativeContextMessage(
  message: { nativeContextSession?: unknown; baseStructVersion?: unknown },
  session: string,
  structVersion: number,
): boolean {
  return message.nativeContextSession === undefined
    || (message.nativeContextSession === session && message.baseStructVersion === structVersion);
}

export function withoutNativeContextTransportMetadata(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...message };
  delete payload.nativeContextSession;
  return payload;
}

export function createNativeContextExecutionGate(
  message: { nativeContextSession?: unknown; baseStructVersion?: unknown },
  session: string,
  getStructVersion: () => number,
  refuse: () => void,
): { isFresh(): boolean; run<T>(action: () => T): T | undefined } {
  const isFresh = (): boolean =>
    isFreshNativeContextMessage(message, session, getStructVersion());
  return {
    isFresh,
    run<T>(action: () => T): T | undefined {
      if (!isFresh()) {
        refuse();
        return undefined;
      }
      return action();
    },
  };
}
