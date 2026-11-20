import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 50 * 1024 * 1024;
const LOCAL_SOURCE = /^local:([a-f0-9]{64})$/;
const EXTENSIONS = ['png', 'jpg', 'webp', 'gif', 'bmp'] as const;
const SCHEME = 'mira-background';
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

class ImageError extends Error {}

function friendlyError(error: unknown): Error {
  if (error instanceof ImageError) return error;
  const details = error as { name?: string; code?: string; cause?: { code?: string } };
  const code = details?.cause?.code ?? details?.code;
  if (details?.name === 'TimeoutError' || details?.name === 'AbortError')
    return new Error('The download timed out. Try again.');
  if (code === 'ENOSPC') return new Error('Not enough disk space to save the image.');
  if (code === 'EACCES' || code === 'EPERM')
    return new Error(
      'Mira cannot access this file. Choose another image or check file permissions.',
    );
  if (code === 'ENOENT') return new Error('The image file could not be found. Choose it again.');
  if (code?.includes('CERT') || code?.includes('SSL') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    return new Error('The image website has a certificate problem. Try another image URL.');
  if (
    error instanceof TypeError ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET'
  )
    return new Error(
      'Could not reach the image URL. Check the address and your connection, then try again.',
    );
  return new Error('Could not load or save this image. Try another image.');
}

export function setupBackgroundImages() {
  const directory = path.join(app.getPath('userData'), 'background-images');
  const pending = new Map<string, Promise<string>>();
  const imageUrl = (name: string) => `${SCHEME}://image/${name}`;
  const findImage = async (key: string) => {
    for (const extension of EXTENSIONS) {
      const name = `${key}.${extension}`;
      try {
        await fs.access(path.join(directory, name));
        return imageUrl(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return null;
  };
  const finish = async (temporary: string, key: string) => {
    const file = await fs.open(temporary, 'r');
    const header = Buffer.alloc(16);
    try {
      await file.read(header, 0, header.length, 0);
    } finally {
      await file.close();
    }
    const extension = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'png'
      : header[0] === 255 && header[1] === 216 && header[2] === 255
        ? 'jpg'
        : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
          ? 'webp'
          : /^GIF8[79]a/.test(header.toString('ascii', 0, 6))
            ? 'gif'
            : header.toString('ascii', 0, 2) === 'BM'
              ? 'bmp'
              : null;
    if (!extension)
      throw new ImageError('Could not read this image. Choose a PNG, JPG, WebP, GIF, or BMP file.');
    const name = `${key}.${extension}`;
    await fs.rename(temporary, path.join(directory, name));
    return imageUrl(name);
  };
  const registeredSessions = new WeakSet<Electron.Session>();
  const registerSession = (target: Electron.Session) => {
    if (registeredSessions.has(target)) return;
    registeredSessions.add(target);
    target.protocol.handle(SCHEME, async (request) => {
      const url = new URL(request.url);
      if (
        url.host !== 'image' ||
        !/^\/[a-f0-9]{64}\.(png|jpg|webp|gif|bmp)$/.test(url.pathname) ||
        !['GET', 'HEAD'].includes(request.method)
      )
        return new Response(null, { status: 404 });
      try {
        return await net.fetch(pathToFileURL(path.join(directory, url.pathname.slice(1))).href);
      } catch {
        return new Response(null, { status: 404 });
      }
    });
  };
  const attachWindow = (win: BrowserWindow) => {
    registerSession(win.webContents.session);
    const publish = () => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send('background-window-visible', win.isVisible() && !win.isMinimized());
    };
    win.on('minimize', publish);
    win.on('restore', publish);
    win.on('show', publish);
    win.on('hide', publish);
  };
  for (const win of BrowserWindow.getAllWindows()) attachWindow(win);
  app.on('browser-window-created', (_event, win) => attachWindow(win));
  ipcMain.handle('background-window-visible', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return !!win && win.webContents === event.sender && win.isVisible() && !win.isMinimized();
  });
  const load = async (source: string): Promise<string> => {
    const local = LOCAL_SOURCE.exec(source);
    let key = local?.[1];
    if (!key) {
      const url = new URL(source);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new ImageError('Enter an image URL starting with http:// or https://.');
      key = createHash('sha256').update(url.href).digest('hex');
    }
    const cached = await findImage(key);
    if (cached) return cached;
    if (local) throw new ImageError('The saved image is missing. Choose the image again.');
    const response = await fetch(source, {
      signal: AbortSignal.timeout(60_000),
      credentials: 'omit',
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new ImageError('Image not found (404). Check the URL.');
      if (response.status === 401 || response.status === 403)
        throw new ImageError(
          `This website blocks the download (${response.status}). Download the image yourself and choose the file.`,
        );
      if (response.status === 429)
        throw new ImageError('This website is receiving too many requests (429). Try again later.');
      throw new ImageError(
        `The website could not send the image (${response.status}). Try again later or use another URL.`,
      );
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel();
      throw new ImageError('This image exceeds 50 MB. Choose a smaller file.');
    }
    if (response.headers.get('content-type')?.includes('text/html')) {
      await response.body?.cancel();
      throw new ImageError('This URL opens a webpage. Use a direct image URL instead.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ImageError('The image download was empty. Try another URL.');
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    let length = 0;
    try {
      file = await fs.open(temporary, 'w');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_BYTES)
          throw new ImageError('This image exceeds 50 MB. Choose a smaller file.');
        await file.writeFile(value);
      }
      await file.close();
      file = undefined;
      if (!length) throw new ImageError('The image download was empty. Try another URL.');
      return await finish(temporary, key);
    } finally {
      await reader.cancel().catch(() => {});
      await file?.close();
      await fs.rm(temporary, { force: true });
    }
  };
  ipcMain.handle('background-image-load', async (event, source: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || event.sender !== win.webContents)
      throw new Error('Unavailable outside the browser interface.');
    registerSession(event.sender.session);
    if (typeof source !== 'string' || source.length > 8192)
      throw new Error('Invalid image source.');
    const existing = pending.get(source);
    if (existing) return existing;
    const request = load(source).catch((error: unknown) => {
      throw friendlyError(error);
    });
    pending.set(source, request);
    try {
      return await request;
    } finally {
      pending.delete(source);
    }
  });
  ipcMain.handle('background-image-choose', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || event.sender !== win.webContents)
      throw new Error('Unavailable outside the browser interface.');
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose a background image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const selected = result.filePaths[0];
      if ((await fs.stat(selected)).size > MAX_BYTES)
        throw new ImageError('This image exceeds 50 MB. Choose a smaller file.');
      await fs.mkdir(directory, { recursive: true });
      const key = createHash('sha256').update(randomUUID()).digest('hex');
      const temporary = path.join(directory, `${key}.tmp`);
      try {
        await fs.copyFile(selected, temporary);
        if ((await fs.stat(temporary)).size > MAX_BYTES)
          throw new ImageError('This image exceeds 50 MB. Choose a smaller file.');
        await finish(temporary, key);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return `local:${key}`;
    } catch (error) {
      throw friendlyError(error);
    }
  });
}
