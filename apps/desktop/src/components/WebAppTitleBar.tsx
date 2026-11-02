import { useEffect, useState, type ReactNode } from 'react';
import { AppWindow, Copy, Minus, Square, X } from 'lucide-react';
import { electron } from '../electronBridge';
import type { WebAppWindowInfo } from '../../electron/webAppPolicy';

export default function WebAppTitleBar({
  item,
  origin,
  url,
  children,
  navigation,
  animationsEnabled,
}: {
  item: WebAppWindowInfo;
  origin: string;
  url: string;
  children: ReactNode;
  navigation: ReactNode;
  animationsEnabled: boolean;
}) {
  const isMac = electron?.isMacOS ?? false;
  const isWindows = electron?.platform === 'win32';
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [nativeOverlay, setNativeOverlay] = useState(isWindows);
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => {
    document.title = item.name;
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    let live = true;
    const onMaximized = (_event: unknown, value: boolean) => setMaximized(!!value);
    const onFullscreen = (_event: unknown, value: boolean) => setFullscreen(!!value);
    const onOverlay = (_event: unknown, value: boolean) => setNativeOverlay(!!value);
    ipc.on('window-maximized-changed', onMaximized);
    ipc.on('window-fullscreen-changed', onFullscreen);
    ipc.on('window-titlebar-overlay-changed', onOverlay);
    void ipc
      .invoke<boolean>('window-is-maximized')
      .then((value) => {
        if (live) setMaximized(!!value);
      })
      .catch(() => undefined);
    void ipc
      .invoke<boolean>('window-is-fullscreen')
      .then((value) => {
        if (live) setFullscreen(!!value);
      })
      .catch(() => undefined);
    if (isWindows)
      void ipc
        .invoke<boolean>('window-is-titlebar-overlay-enabled')
        .then((value) => {
          if (live) setNativeOverlay(!!value);
        })
        .catch(() => undefined);
    return () => {
      live = false;
      ipc.off('window-maximized-changed', onMaximized);
      ipc.off('window-fullscreen-changed', onFullscreen);
      ipc.off('window-titlebar-overlay-changed', onOverlay);
    };
  }, [item.name, isWindows]);
  const invoke = (channel: string) => {
    void electron?.ipcRenderer.invoke(channel).catch(() => undefined);
  };
  return (
    <header
      className={`web-app-titlebar ${isMac ? 'web-app-titlebar-mac' : ''} ${fullscreen ? 'web-app-titlebar-fullscreen' : ''}`}
      data-animate={animationsEnabled}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest('button, a, input')) return;
        // macOS handles title-bar double-click according to the system preference.
        if (!isMac) invoke('window-maximize-toggle');
      }}
    >
      {isMac && !fullscreen && <div className="web-app-traffic-lights" aria-hidden="true" />}
      <div className="web-app-titlebar-navigation" role="group" aria-label="App navigation">
        {navigation}
      </div>
      <div className="web-app-identity">
        <div className="web-app-brand-icon" aria-hidden="true">
          {item.iconDataUrl && !iconFailed ? (
            <img
              src={item.iconDataUrl}
              alt=""
              draggable={false}
              onError={() => setIconFailed(true)}
            />
          ) : (
            <AppWindow size={23} strokeWidth={1.6} />
          )}
        </div>
        <div className="web-app-title-stack">
          <h1 className="web-app-title" title={item.name}>
            {item.name}
          </h1>
          <span className="web-app-location" title={url}>
            {origin.replace(/^https?:\/\//, '')}
          </span>
        </div>
      </div>
      <div className="web-app-titlebar-actions" role="group" aria-label="App actions">
        {children}
      </div>
      {!fullscreen &&
        (isWindows && nativeOverlay ? (
          <div className="web-app-native-caption" aria-hidden="true" />
        ) : (
          !isMac && (
            <div className="web-app-caption-controls">
              <button
                type="button"
                title="Minimize"
                aria-label="Minimize"
                onClick={() => invoke('window-minimize')}
              >
                <Minus size={15} />
              </button>
              <button
                type="button"
                title={maximized ? 'Restore' : 'Maximize'}
                aria-label={maximized ? 'Restore' : 'Maximize'}
                onClick={() => invoke('window-maximize-toggle')}
              >
                {maximized ? <Copy size={13} /> : <Square size={13} />}
              </button>
              <button
                type="button"
                className="web-app-caption-close"
                title="Close app"
                aria-label="Close app"
                onClick={() => invoke('window-close')}
              >
                <X size={17} />
              </button>
            </div>
          )
        ))}
    </header>
  );
}
