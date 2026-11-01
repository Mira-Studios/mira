import type { Tab } from './types';

export type NavigationMetadata = { sameDocument?: boolean; title?: string };

/** URL changes inside a document do not invalidate its title or favicon. */
export function getNavigationMetadata(
  tab: Pick<Tab, 'url' | 'title' | 'favicon'>,
  url: string,
  metadata: NavigationMetadata = {},
): Pick<Tab, 'title' | 'favicon'> {
  const sameDocument = metadata.sameDocument || url === tab.url;
  let sameOrigin = false;
  try {
    const previous = new URL(tab.url);
    sameOrigin = previous.origin !== 'null' && previous.origin === new URL(url).origin;
  } catch { /* Internal URLs have their own metadata. */ }
  return {
    title: metadata.title?.trim() || (sameDocument ? tab.title : url),
    favicon: sameDocument || sameOrigin ? tab.favicon : undefined,
  };
}

/** Chromium can publish an empty icon list while the current icon is still valid. */
export function getUpdatedFavicon(current: string | undefined, incoming: unknown): string | undefined {
  return typeof incoming === 'string' && incoming.trim() ? incoming.trim() : current;
}


/** Only the main document can nominate a tab icon, including a CDN-hosted icon. */
export function selectPageFavicon(pageUrl: string, declared: string[], reported: string[]): string | undefined {
  const resolve = (value: string) => {
    try { return new URL(value, pageUrl).href; } catch { return undefined; }
  };
  const declaredUrls = new Set(declared.map(resolve).filter(Boolean));
  if (!declaredUrls.size) {
    try {
      const page = new URL(pageUrl);
      if (/^https?:$/.test(page.protocol)) declaredUrls.add(new URL('/favicon.ico', page).href);
    } catch { /* No default icon for internal pages. */ }
  }
  return reported.map(resolve).find((url) => !!url && declaredUrls.has(url));
}
