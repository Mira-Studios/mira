export type WebApp = {
  id: string;
  name: string;
  manifestUrl: string;
  startUrl: string;
  scope: string;
  iconUrl?: string;
  themeColor?: string;
};

export type InstalledWebApp = WebApp & { installedAt: number; launcherName?: string };
export type WebAppWindowInfo = InstalledWebApp & { iconDataUrl?: string };
export const WEB_APP_TITLEBAR_HEIGHT = 40;

export function webAppLauncherLabel(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 80) || 'Web app'
  );
}
export type WebAppState = { webContentsId: number; app: WebApp | null; installed: boolean };
export type WebAppResult = { ok: boolean; error?: string; warning?: string };

export function isWebAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export function isWithinWebAppScope(value: string, scope: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(scope);
    return (
      isWebAppUrl(value) && url.origin === base.origin && url.pathname.startsWith(base.pathname)
    );
  } catch {
    return false;
  }
}

// Resolve against the manifest URL, then enforce the document's security origin.
export function parseWebAppManifest(
  raw: unknown,
  manifestUrl: string,
  pageUrl: string,
): WebApp | null {
  if (!raw || typeof raw !== 'object' || !isWebAppUrl(pageUrl) || !isWebAppUrl(manifestUrl))
    return null;
  const data = raw as Record<string, unknown>;
  const name = typeof data.name === 'string' && data.name.trim() ? data.name : data.short_name;
  if (typeof name !== 'string' || !name.trim() || typeof data.start_url !== 'string') return null;
  const display = Array.isArray(data.display_override)
    ? [...data.display_override, data.display]
    : [data.display];
  if (
    !display.some((value) =>
      ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'].includes(String(value)),
    )
  )
    return null;
  try {
    const start = new URL(data.start_url, manifestUrl);
    if (!isWebAppUrl(start.href) || start.origin !== new URL(pageUrl).origin) return null;
    const defaultScope = new URL('.', start);
    let scope = typeof data.scope === 'string' ? new URL(data.scope, manifestUrl) : defaultScope;
    scope.search = '';
    scope.hash = '';
    if (!isWithinWebAppScope(start.href, scope.href)) scope = defaultScope;
    if (!isWithinWebAppScope(pageUrl, scope.href)) return null;
    const identity = typeof data.id === 'string' ? new URL(data.id, start.origin) : new URL(start);
    if (identity.origin !== start.origin || !isWebAppUrl(identity.href)) return null;
    identity.hash = '';
    const icons = Array.isArray(data.icons) ? data.icons : [];
    const iconUrls = icons.flatMap((icon: unknown) => {
      if (!icon || typeof icon !== 'object') return [];
      const entry = icon as Record<string, unknown>;
      if (typeof entry.src !== 'string') return [];
      let url: string;
      try {
        url = new URL(entry.src, manifestUrl).href;
      } catch {
        return [];
      }
      const suitable =
        typeof entry.sizes === 'string' &&
        entry.sizes
          .split(/\s+/)
          .some(
            (size) =>
              size === 'any' || (/^(\d+)x\1$/.test(size) && Number(size.split('x')[0]) >= 192),
          );
      return isWebAppUrl(url) && suitable ? [url] : [];
    });
    if (!iconUrls.length) return null;
    const cleanName = Array.from(name.trim())
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join('')
      .slice(0, 120);
    if (!cleanName) return null;
    return {
      id: identity.href,
      name: cleanName,
      manifestUrl,
      startUrl: start.href,
      scope: scope.href,
      iconUrl: iconUrls[0],
      themeColor:
        typeof data.theme_color === 'string' && /^#[\da-f]{6}$/i.test(data.theme_color)
          ? data.theme_color
          : undefined,
    };
  } catch {
    return null;
  }
}
