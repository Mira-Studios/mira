import { useEffect, useState } from 'react';
import { AppWindow, ExternalLink, Trash2 } from 'lucide-react';
import { electron } from '../electronBridge';
import { alertDialog, confirmDialog } from '../components/appDialogs';
import type { InstalledWebApp, WebAppResult } from '../../electron/webAppPolicy';
import '../components/WebApps.css';

export default function Apps() {
  const [apps, setApps] = useState<InstalledWebApp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) {
      setLoaded(true);
      return;
    }
    let live = true;
    const refresh = () => {
      void ipc
        .invoke<InstalledWebApp[]>('web-app-list')
        .then((items) => {
          if (live) {
            setApps(items);
            setLoaded(true);
            setError('');
          }
        })
        .catch(() => {
          if (live) {
            setError('Could not load installed apps.');
            setLoaded(true);
          }
        });
    };
    refresh();
    ipc.on('web-apps-changed', refresh);
    return () => {
      live = false;
      ipc.off('web-apps-changed', refresh);
    };
  }, []);
  const uninstall = async (item: InstalledWebApp) => {
    if (busy) return;
    if (
      !(await confirmDialog({
        title: `Uninstall ${item.name}?`,
        message: 'Remove the app and its system shortcut. Your site data and sign-in will be kept.',
        confirmLabel: 'Uninstall',
      }))
    )
      return;
    setBusy(item.id);
    try {
      const result = await electron?.ipcRenderer.invoke<WebAppResult>('web-app-uninstall', item.id);
      if (!result?.ok || result.warning)
        await alertDialog({
          message: result?.error || result?.warning || 'Could not remove this app.',
          title: 'Uninstall app',
        });
    } catch {
      setError('Could not remove this app. Please try again.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <main className="web-apps-page">
      <h1>Installed apps</h1>
      <p>Install supported websites with the app button beside the URL bar.</p>
      {error && <p role="alert">{error}</p>}
      {!loaded ? (
        <p role="status">Loading apps…</p>
      ) : !apps.length ? (
        <p>
          {electron?.isPrivate
            ? 'Installed apps are unavailable in private windows.'
            : 'No apps installed yet.'}
        </p>
      ) : (
        <ul className="web-app-list">
          {apps.map((item) => (
            <li key={item.id} className="theme-panel web-app-card">
              <AppWindow size={25} aria-hidden="true" />
              <div className="web-app-card-details">
                <strong>{item.name}</strong>
                <span>{new URL(item.startUrl).origin}</span>
              </div>
              <button
                className="theme-btn"
                title={`Open ${item.name}`}
                aria-label={`Open ${item.name}`}
                onClick={() => {
                  void electron?.ipcRenderer
                    .invoke('web-app-open', item.id)
                    .catch(() => setError('Could not open this app.'));
                }}
              >
                <ExternalLink size={17} />
              </button>
              <button
                className="theme-btn"
                disabled={busy !== null}
                title={`Uninstall ${item.name}`}
                aria-label={`Uninstall ${item.name}`}
                onClick={() => {
                  void uninstall(item);
                }}
              >
                <Trash2 size={17} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
