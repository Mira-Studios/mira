import { useEffect, useState } from 'react';
import {
  BROWSER_SETTINGS_CHANGED_EVENT,
  BROWSER_SETTINGS_STORAGE_KEY,
  getBrowserSettings,
} from '../settings/browserSettings';

export function useSidebarSettings() {
  const [settings, setSettings] = useState(getBrowserSettings);
  useEffect(() => {
    const refresh = () => setSettings(getBrowserSettings());
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === BROWSER_SETTINGS_STORAGE_KEY) refresh();
    };
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', storage);
    };
  }, []);
  return settings;
}
