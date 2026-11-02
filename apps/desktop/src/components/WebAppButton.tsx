import { useEffect, useState } from 'react';
import { AppWindow, LoaderCircle, MonitorDown } from 'lucide-react';
import { electron } from '../electronBridge';
import { useTabs } from '../features/tabs/TabsProvider';
import { alertDialog, confirmDialog } from './appDialogs';
import type { WebAppResult, WebAppState } from '../../electron/webAppPolicy';
import './WebApps.css';

export default function WebAppButton({
  animationsEnabled,
  onOpen,
}: {
  animationsEnabled: boolean;
  onOpen: () => void;
}) {
  const { activeId, getWebContentsIdForTab } = useTabs();
  const [state, setState] = useState<WebAppState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc || electron?.isPrivate) return;
    let live = true;
    let received = false;
    const receive = (_event: unknown, value: WebAppState) => {
      if (value.webContentsId !== getWebContentsIdForTab(activeId)) return;
      received = true;
      setState(value);
    };
    ipc.on('web-app-state', receive);
    void ipc
      .invoke<WebAppState | null>('web-app-get-state', getWebContentsIdForTab(activeId))
      .then((value) => {
        if (live && !received) setState(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      ipc.off('web-app-state', receive);
    };
  }, [activeId, getWebContentsIdForTab]);
  const item = state?.app;
  const visible = !!item && !electron?.isPrivate;
  const activate = async () => {
    if (!item || !state || busy) return;
    onOpen();
    if (state.installed) {
      await electron?.ipcRenderer.invoke('web-app-open', item.id).catch(() => undefined);
      return;
    }
    setBusy(true);
    try {
      const accepted = await confirmDialog({
        title: `Install ${item.name}?`,
        message: `${new URL(item.startUrl).origin}\n\nOpen this site in its own window, with a shortcut in your system's apps. Offline features are provided by the site.`,
        confirmLabel: 'Install',
        cancelLabel: 'Cancel',
      });
      if (!accepted) return;
      const result = await electron?.ipcRenderer.invoke<WebAppResult>(
        'web-app-install',
        state.webContentsId,
        item.id,
      );
      if (!result?.ok)
        await alertDialog({
          message: result?.error || 'The app could not be installed.',
          title: 'Install app',
        });
      else if (result.warning)
        await alertDialog({ message: result.warning, title: 'App installed' });
    } catch {
      await alertDialog({
        message: 'The app could not be installed. Please try again.',
        title: 'Install app',
      });
    } finally {
      setBusy(false);
    }
  };
  const Icon = busy ? LoaderCircle : state?.installed ? AppWindow : MonitorDown;
  const label = state?.installed ? `Open ${item?.name ?? 'app'}` : `Install ${item?.name ?? 'app'}`;
  return (
    <div
      className={`web-app-button-slot ${visible ? 'web-app-button-visible' : ''}`}
      data-animate={animationsEnabled}
      aria-hidden={!visible}
    >
      <button
        type="button"
        className="theme-btn theme-btn-nav nav-icon-btn web-app-button"
        title={label}
        aria-label={label}
        disabled={!visible || busy}
        tabIndex={visible ? 0 : -1}
        onClick={() => {
          void activate();
        }}
        aria-busy={busy}
      >
        <span className={busy ? 'web-app-spinner' : 'web-app-icon'}>
          <Icon size={17} strokeWidth={1.9} aria-hidden="true" />
        </span>
      </button>
    </div>
  );
}
