import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createBackgroundImageCache } from './backgroundImageCache';
import { electron } from '../../electronBridge';
import {
  BROWSER_SETTINGS_CHANGED_EVENT,
  BROWSER_SETTINGS_STORAGE_KEY,
  getBrowserSettings,
} from '../settings/browserSettings';
import { getThemeById } from './themeLoader';
import { getBackgroundImageError } from '../../themes/backgroundImage';

export function useNewTabAppearance() {
  const [settings, setSettings] = useState(getBrowserSettings);
  useEffect(() => {
    const refresh = () => setSettings(getBrowserSettings());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === BROWSER_SETTINGS_STORAGE_KEY) refresh();
    };
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    refresh();
    return () => {
      window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return settings;
}

const backgroundCache = createBackgroundImageCache(async (source, signal) => {
  if (!electron) throw new Error('Background images require the desktop app.');
  const url = await electron.ipcRenderer.invoke<string>('background-image-load', source);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const decoded = new Image();
  decoded.decoding = 'async';
  const dispose = () => {
    decoded.src = '';
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    decoded.src = url;
    await decoded.decode();
    if (decoded.naturalWidth * decoded.naturalHeight > 64_000_000)
      throw new Error(
        `This image is ${decoded.naturalWidth} x ${decoded.naturalHeight} pixels. Resize it to 64 megapixels or less.`,
      );
    return { image: url, dispose };
  } catch (error) {
    dispose();
    if (error instanceof DOMException && error.name === 'EncodingError')
      throw new Error('Could not read this image. Choose a PNG, JPG, WebP, GIF, or BMP file.');
    throw error;
  } finally {
    signal.removeEventListener('abort', dispose);
  }
}, getBackgroundImageError);

export const prepareBackgroundImage = (source: string) => backgroundCache.prepare(source);

export function useBackgroundImage(source: string) {
  const subscribe = useCallback(
    (listener: () => void) => backgroundCache.subscribe(source, listener),
    [source],
  );
  const snapshot = useCallback(() => backgroundCache.snapshot(source), [source]);
  const result = useSyncExternalStore(subscribe, snapshot);
  return { ...result, retry: () => backgroundCache.retry(source) };
}

export function useBackgroundImageWarmup(newTabActive: boolean) {
  const settings = useNewTabAppearance();
  const source = getNewTabBackgroundSource(settings);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    let cancelled = false;
    let receivedEvent = false;
    const update = (_event: unknown, value: boolean) => {
      receivedEvent = true;
      setVisible(value);
    };
    ipc.on('background-window-visible', update);
    void ipc
      .invoke<boolean>('background-window-visible')
      .then((value) => {
        if (!cancelled && !receivedEvent) setVisible(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      ipc.off('background-window-visible', update);
    };
  }, []);
  useEffect(() => {
    backgroundCache.retain(source, visible || newTabActive);
  }, [source, visible, newTabActive]);
  useEffect(() => () => backgroundCache.retain('', false), []);
}

export function getNewTabBackgroundSource(settings: ReturnType<typeof getBrowserSettings>) {
  return (
    (settings.useThemeBackgroundImage && getThemeById(settings.themeId)?.backgroundImageUrl) ||
    settings.backgroundImage
  );
}

export function getBackgroundStyle(settings: ReturnType<typeof getBrowserSettings>, image: string) {
  return {
    backgroundColor: 'var(--bg)',
    backgroundImage: image ? `url("${image}")` : 'none',
    backgroundSize:
      settings.backgroundImageFit === 'stretch'
        ? '100% 100%'
        : settings.backgroundImageFit === 'original' || settings.backgroundImageFit === 'tile'
          ? 'auto'
          : settings.backgroundImageFit,
    backgroundPosition: `${settings.backgroundImagePositionX}% ${settings.backgroundImagePositionY}%`,
    backgroundRepeat: settings.backgroundImageFit === 'tile' ? 'repeat' : 'no-repeat',
  };
}
