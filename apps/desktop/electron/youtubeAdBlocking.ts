import { ipcMain } from 'electron';
import type { Session, WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import youtubeAdBeta from './youtubeAdBeta.cjs';

const preloadSessions = new WeakSet<Session>();
const installer = youtubeAdBeta.installYoutubeAdBeta.toString();

export function isYoutubePlayerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return ['youtube.com', 'youtube-nocookie.com'].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

export function registerYoutubeAdPreload(ses: Session): void {
  if (preloadSessions.has(ses)) return;
  // Run before the first page script, including embeds and private partitions.
  // The same file supplies the installer for live setting changes below.
  ses.registerPreloadScript({
    type: 'frame',
    filePath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'youtubeAdBeta.cjs'),
  });
  preloadSessions.add(ses);
}

export function setupYoutubeAdBlockingSettings(getEnabled: () => boolean): void {
  ipcMain.on('youtube-ad-beta-enabled', (event) => {
    let enabled = false;
    try {
      if (event.sender.getType() === 'webview' &&
          event.senderFrame && isYoutubePlayerUrl(event.senderFrame.url)) {
        enabled = getEnabled() === true;
      }
    } catch { /* The requesting frame may have navigated or been destroyed. */ }
    event.returnValue = enabled;
  });
}

export async function applyYoutubeAdBeta(contents: WebContents, enabled: boolean): Promise<void> {
  if (contents.isDestroyed()) return;
  try {
    await Promise.all(contents.mainFrame.framesInSubtree.map(async (frame) => {
      try {
        if (frame.detached || !isYoutubePlayerUrl(frame.url)) return;
        await frame.executeJavaScript(`(${installer})(${enabled === true})`);
      } catch { /* A frame may navigate while its settings are being updated. */ }
    }));
  } catch { /* The tab may close before its frame tree can be read. */ }
}
