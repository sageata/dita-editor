export interface RefreshGeneration {
  begin(): number | null;
  invalidate(): void;
  isCurrent(generation: number): boolean;
  isDisposed(): boolean;
  dispose(): void;
}

/** Latest-wins/disposal guard for async webview renders. */
export function createRefreshGeneration(): RefreshGeneration {
  let generation = 0;
  let disposed = false;
  return {
    begin(): number | null {
      if (disposed) return null;
      return ++generation;
    },
    invalidate(): void {
      if (!disposed) generation++;
    },
    isCurrent(candidate: number): boolean {
      return !disposed && candidate === generation;
    },
    isDisposed(): boolean {
      return disposed;
    },
    dispose(): void {
      disposed = true;
      generation++;
    },
  };
}
