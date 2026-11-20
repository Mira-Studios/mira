export type BackgroundSnapshot = { image: string; error: string; loading: boolean };
type LoadedImage = { image: string; dispose: () => void };
const EMPTY: BackgroundSnapshot = { image: '', error: '', loading: false };
type Entry = {
  snapshot: BackgroundSnapshot;
  listeners: Set<() => void>;
  pending?: Promise<void>;
  controller?: AbortController;
  loaded?: LoadedImage;
};

/** One decoded image shared by all New Tabs and previews in a window. */
export function createBackgroundImageCache(
  load: (source: string, signal: AbortSignal) => Promise<LoadedImage>,
  errorMessage: (error: unknown) => string,
) {
  const entries = new Map<string, Entry>();
  let retainedSource = '';
  let enabled = true;
  const get = (source: string) => {
    let entry = entries.get(source);
    if (!entry) {
      entry = { snapshot: EMPTY, listeners: new Set() };
      entries.set(source, entry);
    }
    return entry;
  };
  const publish = (entry: Entry, snapshot: BackgroundSnapshot) => {
    entry.snapshot = snapshot;
    entry.listeners.forEach((listener) => listener());
  };
  const release = (entry: Entry) => {
    entry.controller?.abort();
    entry.controller = undefined;
    entry.pending = undefined;
    entry.loaded?.dispose();
    entry.loaded = undefined;
    publish(entry, EMPTY);
  };
  const ensure = (source: string, force = false): Promise<void> => {
    if (!source || (!enabled && !force)) return Promise.resolve();
    const entry = get(source);
    if (entry.pending) return entry.pending;
    if (entry.loaded || entry.snapshot.error) return Promise.resolve();
    const controller = new AbortController();
    entry.controller = controller;
    publish(entry, { image: '', error: '', loading: true });
    entry.pending = (async () => {
      try {
        const loaded = await load(source, controller.signal);
        if (controller.signal.aborted) {
          loaded.dispose();
          return;
        }
        entry.loaded = loaded;
        publish(entry, { image: loaded.image, error: '', loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          publish(entry, { image: '', error: errorMessage(error), loading: false });
      } finally {
        if (entry.controller === controller) {
          entry.pending = undefined;
          entry.controller = undefined;
        }
      }
    })();
    return entry.pending;
  };
  return {
    snapshot: (source: string) => (source ? get(source).snapshot : EMPTY),
    subscribe(source: string, listener: () => void) {
      if (!source) return () => {};
      const entry = get(source);
      entry.listeners.add(listener);
      void ensure(source);
      return () => {
        entry.listeners.delete(listener);
        if (!entry.listeners.size && source !== retainedSource) {
          release(entry);
          entries.delete(source);
        }
      };
    },
    async prepare(source: string) {
      const entry = get(source);
      if (entry.snapshot.error) release(entry);
      await ensure(source, true);
      if (entry.snapshot.error) {
        const error = new Error(entry.snapshot.error);
        if (!entry.listeners.size && source !== retainedSource) entries.delete(source);
        throw error;
      }
    },
    retry(source: string) {
      release(get(source));
      void ensure(source);
    },
    retain(source: string, active: boolean) {
      enabled = active;
      retainedSource = active ? source : '';
      for (const [key, entry] of entries) {
        if (!active || (key !== retainedSource && !entry.listeners.size)) {
          release(entry);
          if (!entry.listeners.size) entries.delete(key);
        }
      }
      if (active) {
        void ensure(source);
        for (const [key, entry] of entries) if (entry.listeners.size) void ensure(key);
      }
    },
  };
}
