import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import { electron } from '../electronBridge';
import type { WebAppWindowInfo } from '../../electron/webAppPolicy';
import WebAppTitleBar from './WebAppTitleBar';
import SiteInteractionPrompts from './SiteInteractionPrompts';
import DownloadProvider from '../features/downloads/DownloadProvider';
import DownloadButton from './DownloadButton';
import { usePromptPresence } from '../hooks/usePromptPresence';
import { DeviceConnectionsControl } from './DeviceConnectionsButton';
import {
  BROWSER_SETTINGS_CHANGED_EVENT,
  BROWSER_SETTINGS_STORAGE_KEY,
  getBrowserSettings,
} from '../features/settings/browserSettings';
import { applyTheme } from '../features/themes/applyTheme';
import { getThemeById } from '../features/themes/themeLoader';
import { applyLayout } from '../features/layouts/applyLayout';
import { getLayoutById } from '../features/layouts/layoutLoader';
import './WebApps.css';

type Guest = HTMLElement & {
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  getWebContentsId: () => number;
  reloadIgnoringCache: () => void;
  stop: () => void;
  print: () => void;
  focus: () => void;
  openDevTools: () => void;
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean }) => void;
  stopFindInPage: (action: 'clearSelection') => void;
};
type Permission = {
  requestId: string;
  webContentsId: number;
  siteLabel: string;
  label: string;
  origin: string;
};

function AppContent({ item }: { item: WebAppWindowInfo }) {
  const guest = useRef<Guest | null>(null);
  const [animationsEnabled, setAnimationsEnabled] = useState(
    () => getBrowserSettings().animationsEnabled,
  );
  const getSourceId = useCallback(() => {
    try {
      return guest.current?.getWebContentsId();
    } catch {
      return undefined;
    }
  }, []);
  const onDeviceOpen = useCallback(() => undefined, []);
  const [findOpen, setFindOpen] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const findQuery = useRef('');
  const [url, setUrl] = useState(item.startUrl);
  const [failed, setFailed] = useState(false);
  const [back, setBack] = useState(false);
  const [forward, setForward] = useState(false);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const permissionPanel = useRef<HTMLDivElement>(null);
  const { displayed: permission, closing, animated } = usePromptPresence(permissions[0] ?? null);
  const permissionId = permission?.requestId;
  useEffect(() => {
    if (permissionId && !closing) permissionPanel.current?.querySelector('button')?.focus();
  }, [permissionId, closing]);
  useEffect(() => {
    const syncSettings = () => {
      const settings = getBrowserSettings();
      setAnimationsEnabled(settings.animationsEnabled);
      applyTheme(getThemeById(settings.themeId));
      applyLayout(getLayoutById(settings.layoutId));
      const styles = getComputedStyle(document.documentElement);
      void electron?.ipcRenderer
        .invoke('window-set-titlebar-symbol-color', {
          symbolColor: styles.getPropertyValue('--text1').trim() || '#e8edf5',
          color:
            styles.getPropertyValue('--surfaceBg').trim() ||
            styles.getPropertyValue('--tabBg').trim() ||
            '#12161d',
        })
        .catch(() => undefined);
    };
    syncSettings();
    const storageChanged = (event: StorageEvent) => {
      if (event.key === BROWSER_SETTINGS_STORAGE_KEY || event.key === null) syncSettings();
    };
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
    window.addEventListener('storage', storageChanged);
    return () => {
      window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
      window.removeEventListener('storage', storageChanged);
    };
  }, []);
  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);
  const closeFind = () => {
    setFindOpen(false);
    guest.current?.stopFindInPage('clearSelection');
    guest.current?.focus();
  };
  useEffect(() => {
    const view = guest.current;
    const ipc = electron?.ipcRenderer;
    if (!view || !ipc) return;
    const sync = () => {
      setUrl(view.getURL() || item.startUrl);
      setBack(view.canGoBack());
      setForward(view.canGoForward());
    };
    const ready = () => {
      sync();
      setFailed(false);
    };
    const crashed = () => setFailed(true);
    const fail = (event: Event) => {
      const detail = event as Event & { isMainFrame: boolean; errorCode: number };
      if (detail.isMainFrame && detail.errorCode !== -3) setFailed(true);
    };
    const request = (_event: unknown, value: Permission) => {
      if (value.webContentsId !== view.getWebContentsId()) return;
      setPermissions((current) =>
        current.some((entry) => entry.requestId === value.requestId)
          ? current
          : [...current, value],
      );
    };
    const navigate = () => {
      sync();
      setPermissions((current) => {
        for (const pending of current)
          void ipc
            .invoke('site-permission-request-respond', {
              requestId: pending.requestId,
              decision: 'dismiss',
            })
            .catch(() => undefined);
        return [];
      });
    };
    const openLink = (_event: unknown, raw: string | { url: string }) => {
      const value = typeof raw === 'string' ? raw : raw.url;
      void ipc.invoke('web-app-open-in-browser', value).catch(() => undefined);
    };
    const shortcut = (_event: unknown, command: string) => {
      if (command === 'reload-tab') view.reload();
      else if (command === 'reload-tab-ignore-cache') view.reloadIgnoringCache();
      else if (command === 'reload-tab-clear-cache')
        void ipc.invoke('webview-clear-cache-and-reload', view.getWebContentsId());
      else if (command === 'stop-loading') view.stop();
      else if (command === 'go-back' && view.canGoBack()) view.goBack();
      else if (command === 'go-forward' && view.canGoForward()) view.goForward();
      else if (command === 'print-page') view.print();
      else if (command === 'close-tab' || command === 'close-window')
        void ipc.invoke('window-close');
      else if (command === 'toggle-fullscreen') void ipc.invoke('window-fullscreen-toggle');
      else if (command === 'toggle-devtools') view.openDevTools();
      else if (command === 'find-in-page') {
        setFindOpen(true);
        findInput.current?.focus();
      } else if ((command === 'find-next' || command === 'find-previous') && findQuery.current)
        view.findInPage(findQuery.current, { forward: command === 'find-next', findNext: true });
      else if (['zoom-in', 'zoom-out', 'zoom-reset'].includes(command))
        void ipc.invoke('page-zoom-change', {
          webContentsId: view.getWebContentsId(),
          action: command.slice(5),
        });
    };
    view.addEventListener('dom-ready', ready);
    view.addEventListener('did-navigate', navigate);
    view.addEventListener('did-navigate-in-page', sync);
    view.addEventListener('did-fail-load', fail);
    view.addEventListener('render-process-gone', crashed);
    ipc.on('site-permission-request', request);
    ipc.on('open-url-in-new-tab', openLink);
    ipc.on('app-shortcut', shortcut);
    return () => {
      view.removeEventListener('dom-ready', ready);
      view.removeEventListener('did-navigate', navigate);
      view.removeEventListener('did-navigate-in-page', sync);
      view.removeEventListener('did-fail-load', fail);
      view.removeEventListener('render-process-gone', crashed);
      ipc.off('site-permission-request', request);
      ipc.off('open-url-in-new-tab', openLink);
      ipc.off('app-shortcut', shortcut);
    };
  }, [item.startUrl]);
  const respond = (decision: 'allow' | 'block' | 'dismiss') => {
    if (!permission || closing) return;
    setPermissions((current) =>
      current.filter((entry) => entry.requestId !== permission.requestId),
    );
    void electron?.ipcRenderer
      .invoke('site-permission-request-respond', { requestId: permission.requestId, decision })
      .catch(() => undefined);
  };
  let origin = new URL(item.startUrl).origin;
  try {
    origin = new URL(url).origin;
  } catch {
    /* Keep the app origin while a document is loading. */
  }
  return (
    <div className="web-app-window">
      <WebAppTitleBar
        item={item}
        origin={origin}
        url={url}
        animationsEnabled={animationsEnabled}
        navigation={
          <>
            <button
              className="web-app-chrome-button"
              aria-label="Back"
              title="Back"
              disabled={!back}
              onClick={() => guest.current?.goBack()}
            >
              <ArrowLeft size={16} />
            </button>
            <button
              className="web-app-chrome-button"
              aria-label="Forward"
              title="Forward"
              disabled={!forward}
              onClick={() => guest.current?.goForward()}
            >
              <ArrowRight size={16} />
            </button>
            <button
              className="web-app-chrome-button"
              aria-label="Reload"
              title="Reload"
              onClick={() => guest.current?.reload()}
            >
              <RotateCw size={16} />
            </button>
          </>
        }
      >
        <DeviceConnectionsControl
          getSourceId={getSourceId}
          animationsEnabled={animationsEnabled}
          onOpen={onDeviceOpen}
          otherMenuOpen={!!permission}
        />
        <DownloadButton />
        <button
          className="web-app-chrome-button web-app-open-browser"
          aria-label="Open in Mira"
          title="Open in Mira"
          onClick={() => {
            void electron?.ipcRenderer
              .invoke('web-app-open-in-browser', url)
              .catch(() => undefined);
          }}
        >
          <ExternalLink size={16} />
        </button>
      </WebAppTitleBar>
      {findOpen && (
        <div className="web-app-findbar" role="search" aria-label="Find in app">
          <input
            ref={findInput}
            className="theme-input"
            aria-label="Find in app"
            onChange={(event) => {
              findQuery.current = event.target.value;
              if (event.target.value)
                guest.current?.findInPage(event.target.value, { findNext: false });
              else guest.current?.stopFindInPage('clearSelection');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeFind();
              if (event.key === 'Enter' && findQuery.current)
                guest.current?.findInPage(findQuery.current, {
                  forward: !event.shiftKey,
                  findNext: true,
                });
            }}
          />
          <button className="theme-btn" onClick={closeFind}>
            Close
          </button>
        </div>
      )}
      <div className="web-app-content">
        <webview
          ref={(element) => {
            guest.current = element as Guest | null;
          }}
          src={item.startUrl}
        />
        {failed && (
          <div className="web-app-load-error">
            <h2>Couldn’t load {item.name}</h2>
            <p>Check your connection and try again.</p>
            <button className="theme-btn" onClick={() => guest.current?.reload()}>
              Try again
            </button>
          </div>
        )}
      </div>
      {permission && (
        <div
          ref={permissionPanel}
          className={`web-app-permission theme-panel ${animated ? (closing ? 'prompt-motion-out' : 'prompt-motion-in') : ''}`}
          role="dialog"
          aria-labelledby="web-app-permission-title"
          aria-describedby="web-app-permission-message"
          inert={closing}
          aria-hidden={closing || undefined}
          onKeyDown={(event) => {
            if (event.key === 'Escape') respond('dismiss');
          }}
        >
          <strong id="web-app-permission-title">{permission.siteLabel}</strong>
          <p>{permission.origin}</p>
          <p id="web-app-permission-message">{permission.label}?</p>
          <div className="web-app-permission-actions">
            <button className="theme-btn" onClick={() => respond('block')}>
              Block
            </button>
            <button className="theme-btn" onClick={() => respond('allow')}>
              Allow
            </button>
          </div>
        </div>
      )}
      <SiteInteractionPrompts />
    </div>
  );
}

export default function WebAppWindow() {
  const [item, setItem] = useState<WebAppWindowInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void electron?.ipcRenderer
      .invoke<WebAppWindowInfo | null>('web-app-window-info')
      .then((value) => {
        if (!live) return;
        if (value) setItem(value);
        else setError('This app is no longer installed.');
      })
      .catch(() => {
        if (live) setError('Could not open this app.');
      });
    return () => {
      live = false;
    };
  }, []);
  return item ? (
    <DownloadProvider>
      <AppContent item={item} />
    </DownloadProvider>
  ) : (
    <p role="status">{error || 'Opening app…'}</p>
  );
}
