import { useMemo, useSyncExternalStore } from 'react';

/** Blob URLs are external browser resources, allocated only for a mounted subscriber. */
function createBlobResource(blob: Blob | null) {
  let url: string | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => url,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      url ??= blob ? URL.createObjectURL(blob) : undefined;
      notify();
      return () => {
        listeners.delete(notify);
        if (!listeners.size) {
          if (url) URL.revokeObjectURL(url);
          url = undefined;
        }
      };
    },
  };
}
const resources = new WeakMap<Blob, ReturnType<typeof createBlobResource>>();
const emptyResource = createBlobResource(null);
export function useBlobUrl(blob: Blob | null): string | undefined {
  const resource = useMemo(() => {
    if (!blob) return emptyResource;
    const previous = resources.get(blob);
    if (previous) return previous;
    const next = createBlobResource(blob);
    resources.set(blob, next);
    return next;
  }, [blob]);
  return useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    () => undefined,
  );
}
