interface RendererIpcBridge {
  on: <TArgs extends unknown[]>(channel: string, listener: (...args: TArgs) => void) => void;
  off: <TArgs extends unknown[]>(channel: string, listener: (...args: TArgs) => void) => void;
  send: (channel: string, ...args: unknown[]) => void;
  invoke: <TResult = unknown>(channel: string, ...args: unknown[]) => Promise<TResult>;
}

interface ElectronBridge {
  platform: string;
  isPrivate?: boolean;
  privatePartition?: string;
  isMacOS: boolean;
  appVersion?: string | null;
  getAppVersion?: () => Promise<string>;
  ipcRenderer: RendererIpcBridge;
}

type PreloadBridge = Omit<ElectronBridge, 'ipcRenderer'> & {
  ipcSubscriptionIds?: boolean;
  ipcRenderer: Omit<RendererIpcBridge, 'on' | 'off'> & {
    on: (channel: string, listener: (...args: unknown[]) => void) => number;
    off: (channel: string, subscriptionId: number) => void;
  };
};

declare global {
  interface Window {
    electron?: PreloadBridge;
  }
}

/**
 * Typed access point for the preload bridge injected by Electron.
 */
const preload = window.electron;
const subscriptions = new Map<string, Map<object, number>>();
export const electron: ElectronBridge | undefined = preload && (preload.ipcSubscriptionIds ? {
  ...preload,
  ipcRenderer: {
    ...preload.ipcRenderer,
    on(channel, listener) {
      let listeners = subscriptions.get(channel);
      if (!listeners) { listeners = new Map(); subscriptions.set(channel, listeners); }
      if (listeners.has(listener)) return;
      const id = preload.ipcRenderer.on(channel, (...args) => listener(...args as Parameters<typeof listener>));
      listeners.set(listener, id);
    },
    off(channel, listener) {
      const listeners = subscriptions.get(channel);
      if (!listeners) return;
      const id = listeners.get(listener);
      if (id === undefined) return;
      preload.ipcRenderer.off(channel, id);
      listeners.delete(listener);
      if (!listeners.size) subscriptions.delete(channel);
    },
  },
} : preload as unknown as ElectronBridge);

if (import.meta.hot) import.meta.hot.dispose(() => {
  for (const [channel, listeners] of subscriptions) {
    for (const id of listeners.values()) preload?.ipcRenderer.off(channel, id);
  }
  subscriptions.clear();
});
