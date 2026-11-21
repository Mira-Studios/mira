import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  session,
  type Session,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  clampPip,
  normalizePipVideos,
  pipMode,
  type PipMode,
  type PipRect,
  type PipSettings,
  type PipVideo,
} from './pictureInPicturePolicy.ts';
type Candidate = {
  key: string;
  host: BrowserWindow;
  contents: WebContents;
  frame: WebFrameMain;
  video: PipVideo;
  seen: number;
};
type Player = {
  win: BrowserWindow;
  source: Candidate;
  token: string;
  mode: PipMode;
  ready: boolean;
  moving: boolean;
};
export function setupPictureInPicture(options: {
  preload: string;
  load: (win: BrowserWindow) => void;
  hostFor: (contents: WebContents) => BrowserWindow | null | undefined;
  privateHost: (host: BrowserWindow) => boolean;
  scope: (host: BrowserWindow) => string;
}) {
  const registeredSessions = new WeakSet<Session>();
  const registerSession = (target: Session) => {
    if (registeredSessions.has(target)) return;
    target.registerPreloadScript({
      type: 'frame',
      filePath: path.join(path.dirname(options.preload), 'pictureInPicturePreload.cjs'),
    });
    registeredSessions.add(target);
  };
  registerSession(session.defaultSession);
  // The player must not share a renderer process with the browser shell.
  // It receives a video-only stream over authenticated local signaling and
  // does not need the source site's cookies, storage, or session preloads.
  const playerSession = session.fromPartition('mira-picture-in-picture-player', { cache: false });
  const candidates = new Map<string, Candidate>();
  const active = new Map<number, number | null>();
  const settings = new Map<number, PipSettings>();
  const hosts = new Set<number>();
  const dismissed = new Set<string>();
  const mediaThrottling = new Map<number, { contents: WebContents; previous: boolean }>();
  const placements: Record<string, Partial<Record<PipMode, PipRect>>> = {};
  let placementTimer: ReturnType<typeof setTimeout> | undefined;
  let placementsDirty = false;
  const file = path.join(app.getPath('userData'), 'picture-in-picture.v1.json');
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version === 1 && value.placements && typeof value.placements === 'object')
      for (const [scope, modes] of Object.entries(value.placements)) {
        if (!/^[a-zA-Z0-9:-]{1,100}$/.test(scope) || !modes || typeof modes !== 'object') continue;
        for (const mode of ['window', 'desktop'] as const) {
          const rect = (modes as Record<string, PipRect>)[mode];
          if (
            rect &&
            [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
            rect.width > 0 &&
            rect.height > 0
          ) {
            placements[scope] ??= {};
            placements[scope][mode] = rect;
          }
        }
      }
  } catch {
    /* Placement preferences are optional. */
  }
  let player: Player | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keyFor = (host: BrowserWindow) =>
    options.privateHost(host) ? `private:${host.id}` : options.scope(host);
  const preferences = (host: BrowserWindow) =>
    settings.get(host.id) ?? { onTabSwitch: true, onWindowHidden: true };
  const refreshThrottling = () => {
    const wanted = new Map<number, WebContents>();
    for (const source of candidates.values()) {
      const prefs = preferences(source.host);
      if (
        source.video.playing &&
        (prefs.onTabSwitch || prefs.onWindowHidden) &&
        !source.host.isDestroyed() &&
        !source.host.webContents.isDestroyed() &&
        !source.contents.isDestroyed()
      ) {
        wanted.set(source.host.webContents.id, source.host.webContents);
        wanted.set(source.contents.id, source.contents);
      }
    }
    if (
      player &&
      !player.source.host.isDestroyed() &&
      !player.source.host.webContents.isDestroyed() &&
      !player.source.contents.isDestroyed()
    ) {
      wanted.set(player.source.host.webContents.id, player.source.host.webContents);
      wanted.set(player.source.contents.id, player.source.contents);
    }
    for (const [id, contents] of wanted) {
      if (!mediaThrottling.has(id)) {
        mediaThrottling.set(id, { contents, previous: contents.getBackgroundThrottling() });
        contents.setBackgroundThrottling(false);
      }
    }
    const released = [...mediaThrottling].filter(([id]) => !wanted.has(id));
    // Restore guest visibility before allowing the host compositor to throttle.
    released.sort(
      ([, a], [, b]) =>
        Number(a.contents.isDestroyed() || a.contents.getType() !== 'webview') -
        Number(b.contents.isDestroyed() || b.contents.getType() !== 'webview'),
    );
    for (const [id, value] of released) {
      try {
        if (!value.contents.isDestroyed()) value.contents.setBackgroundThrottling(value.previous);
      } catch {
        /* The guest may be closing. */
      }
      mediaThrottling.delete(id);
    }
  };
  const sendSource = (source: Candidate, channel: string, value: unknown) => {
    try {
      if (!source.frame.isDestroyed()) source.frame.send(channel, value);
    } catch {
      /* The source frame navigated. */
    }
  };
  const persistPlacements = () => {
    if (!placementsDirty) return;
    try {
      const persisted = Object.fromEntries(
        Object.entries(placements).filter(([id]) => !id.startsWith('private:')),
      );
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, placements: persisted }));
      renameSync(`${file}.tmp`, file);
      placementsDirty = false;
    } catch {
      /* A placement save must not interrupt playback. */
    }
  };
  const remember = () => {
    if (!player || player.moving || player.win.isDestroyed() || player.source.host.isDestroyed())
      return;
    if (
      player.mode === 'window' &&
      (player.source.host.isMinimized() ||
        !player.source.host.isVisible() ||
        player.win.isMinimized())
    )
      return;
    const { source, mode, win } = player;
    const bounds = win.getBounds();
    const origin = source.host.getContentBounds();
    const key = keyFor(source.host);
    placements[key] ??= {};
    placements[key][mode] =
      mode === 'window' ? { ...bounds, x: bounds.x - origin.x, y: bounds.y - origin.y } : bounds;
    const alternateMode = mode === 'window' ? 'desktop' : 'window';
    const alternate = placements[key][alternateMode];
    if (alternate)
      placements[key][alternateMode] = { ...alternate, width: bounds.width, height: bounds.height };
    if (options.privateHost(source.host)) return;
    placementsDirty = true;
    clearTimeout(placementTimer);
    placementTimer = setTimeout(persistPlacements, 200);
    placementTimer.unref();
  };
  const close = (dismiss = false) => {
    const current = player;
    if (!current) return;
    remember();
    player = null;
    if (dismiss) dismissed.add(current.source.key);
    sendSource(current.source, 'mira-pip-stop', { token: current.token });
    if (!current.source.host.isDestroyed())
      current.source.host.webContents.send('pip-source-active', null);
    if (!current.win.isDestroyed()) current.win.destroy();
    refreshThrottling();
  };
  const setExactBounds = (win: BrowserWindow, bounds: PipRect) => {
    win.setMinimumSize(
      Math.max(1, Math.min(238, bounds.width - 2)),
      Math.max(1, Math.min(133, bounds.height - 2)),
    );
    win.setBounds(bounds);
    // Windows can round frameless bounds at fractional display scales.
    // Correct against the actual native rectangle so repeated restores do not drift.
    for (let attempt = 0; attempt < 2; attempt++) {
      const actual = win.getBounds();
      if (
        actual.x === bounds.x &&
        actual.y === bounds.y &&
        actual.width === bounds.width &&
        actual.height === bounds.height
      )
        break;
      win.setBounds({
        x: bounds.x + bounds.x - actual.x,
        y: bounds.y + bounds.y - actual.y,
        width: Math.max(1, bounds.width + bounds.width - actual.width),
        height: Math.max(1, bounds.height + bounds.height - actual.height),
      });
    }
  };
  const place = (mode: PipMode) => {
    const current = player;
    if (!current || current.win.isDestroyed() || current.source.host.isDestroyed()) return;
    const { source, win } = current;
    if (mode === 'window' && (source.host.isMinimized() || !source.host.isVisible())) return;
    const hostBounds = source.host.getContentBounds();
    const saved = placements[keyFor(source.host)]?.[mode];
    const lastSize = placements[keyFor(source.host)]?.[mode === 'window' ? 'desktop' : 'window'];
    const display = saved
      ? screen.getDisplayMatching(saved)
      : screen.getDisplayMatching(hostBounds);
    const rect =
      mode === 'window' && saved
        ? { ...saved, x: saved.x + hostBounds.x, y: saved.y + hostBounds.y }
        : (saved ?? (lastSize ? { width: lastSize.width, height: lastSize.height } : undefined));
    const bounds = clampPip(
      rect,
      mode === 'window' ? hostBounds : display.workArea,
      source.video.width / source.video.height,
    );
    current.moving = true;
    win.setAlwaysOnTop(mode === 'desktop', 'floating');
    setExactBounds(win, bounds);
    current.mode = mode;
    current.moving = false;
    if (current.ready && (mode === 'desktop' || source.host.isFocused() || win.isFocused())) {
      if (win.isMinimized()) win.restore();
      win.showInactive();
      if (mode === 'window') win.moveTop();
    }
    win.webContents.send('pip-state', {
      ...source.video,
      muted: source.video.muted || source.contents.isAudioMuted(),
      mode,
      themeId: preferences(source.host).themeId,
    });
  };
  const start = (source: Candidate, mode: PipMode) => {
    close();
    const token = randomUUID();
    const win = new BrowserWindow({
      width: 360,
      height: 203,
      minWidth: 240,
      minHeight: 135,
      frame: false,
      resizable: true,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#141414',
      title: 'Picture in picture',
      webPreferences: {
        preload: options.preload,
        session: playerSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    player = {
      win,
      source,
      token,
      mode,
      ready: false,
      moving: false,
    };
    refreshThrottling();
    source.host.webContents.send('pip-source-active', source.contents.id);
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('close', () => {
      if (player?.win === win) close(true);
    });
    const adjusted = () => {
      if (!player || player.win !== win || player.moving) return;
      if (
        player.mode === 'window' &&
        (source.host.isMinimized() || !source.host.isVisible() || win.isMinimized())
      )
        return;
      {
        const area =
          player.mode === 'window'
            ? source.host.getContentBounds()
            : screen.getDisplayMatching(win.getBounds()).workArea;
        const bounded = clampPip(win.getBounds(), area, source.video.width / source.video.height);
        const actual = win.getBounds();
        if (
          actual.x !== bounded.x ||
          actual.y !== bounded.y ||
          actual.width !== bounded.width ||
          actual.height !== bounded.height
        ) {
          player.moving = true;
          setExactBounds(win, bounded);
          player.moving = false;
        }
      }
      remember();
    };
    win.on('move', adjusted);
    win.on('resize', adjusted);
    win.on('focus', () => schedule());
    win.on('blur', () => schedule());
    options.load(win);
    place(mode);
  };
  const hidden = (host: BrowserWindow) => !host.isVisible() || host.isMinimized();
  const evaluate = () => {
    const now = Date.now();
    for (const [key, source] of candidates) {
      if (
        source.contents.isDestroyed() ||
        source.host.isDestroyed() ||
        source.frame.isDestroyed() ||
        now - source.seen > 5000
      )
        candidates.delete(key);
    }
    refreshThrottling();
    for (const source of candidates.values()) {
      if (!hidden(source.host) && active.get(source.host.id) === source.contents.id)
        dismissed.delete(source.key);
    }
    if (player) {
      const current = candidates.get(player.source.key);
      if (!current) {
        close();
        return;
      }
      player.source = current;
      const mode = pipMode(
        preferences(current.host),
        hidden(current.host),
        active.get(current.host.id) === current.contents.id,
      );
      if (!mode || dismissed.has(current.key)) {
        close();
        return;
      }
      if (mode !== player.mode) {
        remember();
        place(mode);
      }
      // Keep the in-window presentation visually attached without native owner
      // relationships, which can crash Electron's guest compositor on minimize.
      if (player && mode === 'window' && player.ready) {
        if (current.host.isFocused() || player.win.isFocused()) {
          if (!player.win.isVisible()) player.win.showInactive();
          if (current.host.isFocused()) player.win.moveTop();
        } else if (player.win.isVisible()) player.win.hide();
      }
      if (player)
        player.win.webContents.send('pip-state', {
          ...current.video,
          muted: current.video.muted || current.contents.isAudioMuted(),
          mode,
          themeId: preferences(current.host).themeId,
        });
      return;
    }
    const source = [...candidates.values()]
      .filter(
        (source) =>
          source.video.playing &&
          !source.video.ended &&
          active.has(source.host.id) &&
          !dismissed.has(source.key) &&
          pipMode(
            preferences(source.host),
            hidden(source.host),
            active.get(source.host.id) === source.contents.id,
          ),
      )
      .sort((a, b) => b.video.area - a.video.area || b.seen - a.seen)[0];
    if (source)
      start(
        source,
        pipMode(
          preferences(source.host),
          hidden(source.host),
          active.get(source.host.id) === source.contents.id,
        )!,
      );
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(evaluate, 100);
  };
  ipcMain.on('mira-pip-videos', (event, value: unknown) => {
    if (event.sender.isDestroyed() || event.sender.getType() !== 'webview' || !event.senderFrame)
      return;
    const host = options.hostFor(event.sender);
    if (!host || !hosts.has(host.id)) return;
    const frame = event.senderFrame;
    const prefix = `${event.sender.id}:${frame.processId}:${frame.routingId}:`;
    const videos = normalizePipVideos(value);
    const keep = new Set(videos.map((video) => `${prefix}${video.id}`));
    for (const key of candidates.keys())
      if (key.startsWith(prefix) && !keep.has(key)) {
        candidates.delete(key);
        dismissed.delete(key);
      }
    for (const video of videos) {
      const key = `${prefix}${video.id}`;
      candidates.set(key, { key, host, contents: event.sender, frame, video, seen: Date.now() });
    }
    refreshThrottling();
    schedule();
  });
  ipcMain.handle('settings-set-picture-in-picture', (event, value: Partial<PipSettings> = {}) => {
    const host = BrowserWindow.fromWebContents(event.sender);
    if (!host || event.sender !== host.webContents || !hosts.has(host.id)) return false;
    settings.set(host.id, {
      onTabSwitch: value.onTabSwitch !== false,
      onWindowHidden: value.onWindowHidden !== false,
      themeId: typeof value.themeId === 'string' ? value.themeId : undefined,
    });
    refreshThrottling();
    schedule();
    return true;
  });
  ipcMain.on('pip-ready', (event) => {
    if (!player || player.ready || event.sender !== player.win.webContents) return;
    player.ready = true;
    place(player.mode);
    player.win.webContents.send('pip-start', { token: player.token });
    sendSource(player.source, 'mira-pip-start', {
      token: player.token,
      id: player.source.video.id,
    });
  });
  ipcMain.on('pip-signal', (event, payload: { token?: string; data?: unknown }) => {
    const current = player;
    if (
      !current ||
      payload?.token !== current.token ||
      !payload.data ||
      JSON.stringify(payload.data).length > 100_000
    )
      return;
    if (event.sender === current.win.webContents)
      sendSource(current.source, 'mira-pip-signal', payload);
    else if (
      event.sender === current.source.contents &&
      event.senderFrame?.processId === current.source.frame.processId &&
      event.senderFrame?.routingId === current.source.frame.routingId
    )
      current.win.webContents.send('pip-signal', payload);
  });
  ipcMain.on('pip-command', (event, value: { action?: string; value?: unknown }) => {
    const current = player;
    if (!current || event.sender !== current.win.webContents) return;
    if (value?.action === 'close') {
      close(true);
      return;
    }
    if (value?.action === 'return') {
      const { host, contents } = current.source;
      if (host.isMinimized()) host.restore();
      host.show();
      host.focus();
      host.webContents.send('pip-return-to-tab', contents.id);
      close(true);
      if (!host.isDestroyed()) host.focus();
      return;
    }
    if (!['play', 'pause', 'seek', 'mute', 'volume'].includes(value?.action ?? '')) return;
    if (
      value.action === 'mute' &&
      value.value === false &&
      current.source.contents.isAudioMuted()
    ) {
      current.source.contents.setAudioMuted(false);
      current.source.host.webContents.send('pip-tab-unmuted', current.source.contents.id);
    }
    const request = { token: current.token, ...value };
    if (['play', 'mute', 'volume'].includes(value.action!)) {
      void current.source.frame
        .executeJavaScript(`window.__miraPipMedia.control(${JSON.stringify(request)})`, true)
        .catch(() => undefined);
    } else sendSource(current.source, 'mira-pip-command', request);
  });
  app.on('before-quit', () => {
    close();
    clearTimeout(placementTimer);
    persistPlacements();
  });
  return {
    registerSession,
    isWindow: (id: number) => player?.win.id === id,
    isSourceWindow: (id: number) => player?.source.host.id === id,
    track(host: BrowserWindow) {
      hosts.add(host.id);
      host.on('focus', schedule);
      host.on('blur', schedule);
      host.on('hide', schedule);
      host.on('show', schedule);
      host.on('minimize', schedule);
      host.on('restore', schedule);
      const follow = () => {
        if (
          player?.source.host === host &&
          player.mode === 'window' &&
          !host.isMinimized() &&
          host.isVisible()
        )
          place('window');
      };
      host.on('move', follow);
      host.on('resize', follow);
      host.once('closed', () => {
        if (player?.source.host === host) close();
        hosts.delete(host.id);
        settings.delete(host.id);
        active.delete(host.id);
        for (const [key, candidate] of candidates)
          if (candidate.host === host) {
            candidates.delete(key);
            dismissed.delete(key);
          }
        if (options.privateHost(host)) delete placements[keyFor(host)];
        refreshThrottling();
      });
    },
    setActive(host: BrowserWindow, id: number | null) {
      active.set(host.id, id);
      schedule();
    },
  };
}
