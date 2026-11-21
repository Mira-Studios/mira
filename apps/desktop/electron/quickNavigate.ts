import { BrowserWindow, ipcMain, Menu, nativeImage } from 'electron';

const MAX_BYTES = 1024 * 1024;

async function readBounded(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error('Unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BYTES) throw new Error('Too large');
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/** Website icon declarations often point somewhere other than /favicon.ico. */
export function declaredIcons(html: string, page: string): string[] {
  const result: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes.set(
        match[1].toLowerCase(),
        (match[2] ?? match[3] ?? match[4]).replace(/&amp;/gi, '&'),
      );
    }
    if (!/\b(?:icon|apple-touch-icon)\b/i.test(attributes.get('rel') || '')) continue;
    try {
      const url = new URL(attributes.get('href') || '', page);
      if (['http:', 'https:'].includes(url.protocol)) result.push(url.href);
    } catch {
      /* Skip malformed declarations. */
    }
  }
  return [...new Set(result)].slice(0, 8);
}

export function setupQuickNavigate() {
  ipcMain.handle('quick-navigate-menu', (event, input: unknown) => {
    const host = BrowserWindow.fromWebContents(event.sender);
    if (!host || host.webContents !== event.sender || !input || typeof input !== 'object')
      return null;
    const { card, visible, x, y } = input as {
      card?: boolean;
      visible?: boolean;
      x?: number;
      y?: number;
    };
    return new Promise<string | null>((resolve) => {
      const item = (label: string, action: string) => ({ label, click: () => resolve(action) });
      const menu = Menu.buildFromTemplate(
        card
          ? [item('Edit', 'edit'), item('Remove', 'remove')]
          : [
              item('Add Quick Navigate link', 'add'),
              item(visible ? 'Hide Quick Navigate' : 'Show Quick Navigate', 'toggle'),
            ],
      );
      menu.popup({
        window: host,
        ...(Number.isFinite(x) && Number.isFinite(y)
          ? { x: Math.round(x!), y: Math.round(y!) }
          : {}),
        callback: () => resolve(null),
      });
    });
  });

  ipcMain.handle('quick-navigate-favicon', async (event, input: unknown) => {
    const host = BrowserWindow.fromWebContents(event.sender);
    if (!host || host.webContents !== event.sender || !input || typeof input !== 'object')
      return null;
    const { url, source } = input as { url?: unknown; source?: unknown };
    if (typeof url !== 'string') return null;
    let page: URL;
    try {
      page = new URL(url);
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(page.protocol)) return null;
    const download = async (value: string) => {
      const iconUrl = new URL(value);
      if (!['https:', 'http:', 'data:'].includes(iconUrl.protocol) || value.length > MAX_BYTES * 2)
        return null;
      const response = await event.sender.session.fetch(value, {
        credentials: 'omit',
        signal: AbortSignal.timeout(8000),
      });
      const buffer = await readBounded(response);
      const image = nativeImage.createFromBuffer(buffer);
      if (!image.isEmpty()) return image.resize({ width: 32, height: 32 }).toDataURL();
      // NativeImage cannot decode SVG; Chromium's image decoder handles it in the renderer.
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (mime && /^image\/(svg\+xml|x-icon|vnd.microsoft.icon|png|jpeg|webp|gif|avif)$/.test(mime))
        return `data:${mime};base64,${buffer.toString('base64')}`;
      return null;
    };
    const tryIcon = async (value: string) => {
      try {
        return await download(value);
      } catch {
        return null;
      }
    };
    if (typeof source === 'string') {
      const supplied = await tryIcon(source);
      if (supplied) return supplied;
    }
    try {
      const response = await event.sender.session.fetch(page.href, {
        credentials: 'omit',
        signal: AbortSignal.timeout(8000),
      });
      const html = (await readBounded(response)).toString('utf8');
      for (const icon of declaredIcons(html, response.url || page.href)) {
        const result = await tryIcon(icon);
        if (result) return result;
      }
    } catch {
      /* Offline or oversized page: still try the conventional icon. */
    }
    return tryIcon(new URL('/favicon.ico', page).href);
  });
}
