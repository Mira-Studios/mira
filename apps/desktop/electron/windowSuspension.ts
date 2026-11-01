import { ImageView, View, nativeImage, webContents } from 'electron';
import type { BrowserWindow, NativeImage } from 'electron';
import { MinimizedWindowLifecycle } from './minimizedWindowLifecycle.ts';

export function createWindowPreviewImage(image: NativeImage, contentWidth: number): NativeImage {
  const size = image.getSize();
  const scale = Math.min(1, 1280 / size.width, 800 / size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  // Keep one small source bitmap, without high-DPI representations. Its scale factor
  // preserves the window's logical size so ImageView fills it rather than centering a thumbnail.
  const thumbnail = image.resize({ width, height });
  return nativeImage.createFromBitmap(thumbnail.toBitmap({ scaleFactor: 1 }), {
    width,
    height,
    scaleFactor: width / Math.max(1, contentWidth),
  });
}

export function setupWindowSuspension(
  win: BrowserWindow,
  prepareRestore: () => (() => void) | null,
  restore: () => void,
  canSuspend: () => Promise<boolean>,
): MinimizedWindowLifecycle {
  const shellView = win.contentView;
  let previewContainer: View | null = null;
  const resizeShell = () => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    shellView.setBounds({ x: 0, y: 0, width, height });
  };
  const ensurePreviewContainer = () => {
    if (previewContainer) return previewContainer;
    // A sibling native overlay survives renderer surface replacement. An image
    // parented inside WebContentsView can flash when Chromium recreates that view.
    previewContainer = new View();
    win.setContentView(previewContainer);
    previewContainer.addChildView(shellView);
    resizeShell();
    win.on('resize', resizeShell);
    return previewContainer;
  };
  const lifecycle = new MinimizedWindowLifecycle({
    isMinimized: () => !win.isDestroyed() && win.isMinimized(),
    async capture() {
      if (!(await canSuspend())) return null;
      if (!prepareRestore()) return null;
      const image = await win.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: false,
      });
      if (image.isEmpty() || win.isDestroyed()) return null;
      const preview = new ImageView();
      preview.setImage(createWindowPreviewImage(image, win.getContentBounds().width));
      let attached = false;
      const resize = () => {
        const { width, height } = win.getContentBounds();
        preview.setBounds({ x: 0, y: 0, width, height });
      };
      return {
        show() {
          const container = ensurePreviewContainer();
          resize();
          container.addChildView(preview);
          win.on('resize', resize);
          attached = true;
        },
        dispose() {
          win.removeListener('resize', resize);
          if (attached && !win.isDestroyed()) previewContainer?.removeChildView(preview);
          preview.setImage(nativeImage.createEmpty());
          attached = false;
        },
      };
    },
    async unload() {
      if (!(await canSuspend()) || win.isDestroyed() || !win.isMinimized()) return false;
      const commitRestore = prepareRestore();
      if (!commitRestore) return false;
      commitRestore();
      // Navigating the shell destroys its webview guests and releases their renderers.
      // A unique opaque document also moves the shell away from the app's shared origin.
      await win.webContents.loadURL(
        `data:text/html,<title>Mira</title><!--${win.id}-${Date.now()}-->`,
      );
      if (win.isDestroyed()) return true;
      // Never terminate another window's renderer if Chromium has shared its process.
      const processId = win.webContents.getOSProcessId();
      const shared = webContents
        .getAllWebContents()
        .some(
          (contents) =>
            contents !== win.webContents &&
            !contents.isDestroyed() &&
            contents.getOSProcessId() === processId,
        );
      if (processId && !shared) {
        // Keep automatic crash recovery suppressed until the deliberate exit is delivered.
        await new Promise<void>((resolve) => {
          win.webContents.once('render-process-gone', () => resolve());
          win.webContents.forcefullyCrashRenderer();
        });
      }
      return true;
    },
    restore,
    onError: (error) => console.error('Could not suspend minimized window', error),
  });
  win.on('minimize', () => lifecycle.minimize());
  win.on('restore', () => lifecycle.activate());
  win.on('show', () => {
    if (!win.isMinimized()) lifecycle.activate();
  });
  win.on('focus', () => {
    if (!win.isMinimized()) lifecycle.activate();
  });
  win.once('closed', () => lifecycle.close());
  return lifecycle;
}

export async function revealRestoredWindow(
  win: BrowserWindow,
  lifecycle: MinimizedWindowLifecycle,
): Promise<boolean> {
  const token = lifecycle.restoreToken;
  if (token === undefined || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  try {
    // Renderer layout readiness precedes compositor presentation. A successful
    // surface copy is the paint barrier before exposing the whole window chrome.
    const frame = await win.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: false,
    });
    if (win.isDestroyed() || frame.isEmpty() || lifecycle.restoreToken !== token) return false;
    return lifecycle.ready();
  } catch {
    // Navigation/crash recovery will report readiness again; retain the image meanwhile.
    return false;
  }
}
