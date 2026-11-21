import { useEffect, useState } from 'react';
import { electron } from '../../electronBridge';
import { scopedCollectionKey } from '../storage/collectionStorage';
import { saveBrowserSettings } from '../settings/browserSettings';
import miraLogo from '../../assets/mira_logo.png';

export type QuickLink = { id: string; name: string; url: string; favicon?: string };
export const QUICK_NAVIGATE_EDITOR = 'mira:quick-navigate-editor';
const CHANGED = 'mira:quick-navigate-changed';
const key = scopedCollectionKey('mira.quick-navigate.v1');
const iconAttempts = new Set<string>();

export function normalizeQuickUrl(value: string): string {
  const input = value.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
  if (!['https:', 'http:', 'mira:'].includes(url.protocol))
    throw new Error('Enter a website address or Mira page.');
  return url.href;
}

export function getQuickLinks(): QuickLink[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(data)
      ? data.filter(
          (item): item is QuickLink =>
            item &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            typeof item.url === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function write(links: QuickLink[]) {
  localStorage.setItem(key, JSON.stringify(links));
  window.dispatchEvent(new Event(CHANGED));
}

export function saveQuickLink(input: Omit<QuickLink, 'id'> & { id?: string }): QuickLink {
  const url = normalizeQuickUrl(input.url);
  const link = {
    ...input,
    id: input.id || crypto.randomUUID(),
    url,
    name: input.name.trim() || new URL(url).hostname,
  };
  const links = getQuickLinks();
  const index = links.findIndex((item) => item.id === link.id);
  if (index < 0) links.push(link);
  else links[index] = link;
  write(links);
  return link;
}

export function removeQuickLink(id: string) {
  write(getQuickLinks().filter((item) => item.id !== id));
}

export async function cacheQuickFavicon(link: QuickLink, source?: string) {
  iconAttempts.add(`${link.id}:${link.url}`);
  try {
    const downloaded = link.url.startsWith('mira:')
      ? miraLogo
      : await electron?.ipcRenderer.invoke<string | null>('quick-navigate-favicon', {
          url: link.url,
          source,
        });
    if (!downloaded) return;
    // Chromium decodes SVG and ICO too; persist a bounded PNG rather than a remote URL.
    const image = new Image();
    image.src = downloaded;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, 0, 0, 32, 32);
    const favicon = canvas.toDataURL('image/png');
    // Read again: a rename or removal during the download must win.
    write(
      getQuickLinks().map((item) =>
        item.id === link.id && item.url === link.url ? { ...item, favicon } : item,
      ),
    );
  } catch {
    /* A missing favicon never blocks adding a link. */
  }
}

export function openQuickNavigateEditor(link?: Partial<QuickLink>) {
  window.dispatchEvent(new CustomEvent(QUICK_NAVIGATE_EDITOR, { detail: link || {} }));
}

export async function showQuickNavigateMenu(
  x: number,
  y: number,
  link?: QuickLink,
  visible = true,
) {
  try {
    const action = await electron?.ipcRenderer.invoke<string | null>('quick-navigate-menu', {
      x,
      y,
      card: !!link,
      visible,
    });
    if (action === 'add') openQuickNavigateEditor();
    if (action === 'edit' && link) openQuickNavigateEditor(link);
    if (action === 'remove' && link) removeQuickLink(link.id);
    if (action === 'toggle') saveBrowserSettings({ showQuickNavigate: !visible });
  } catch {
    /* The window may close while its menu is open. */
  }
}

export function useQuickLinks() {
  const [links, setLinks] = useState(getQuickLinks);
  useEffect(() => {
    for (const link of links) {
      const attempt = `${link.id}:${link.url}`;
      if (link.favicon?.startsWith('data:image/png') || iconAttempts.has(attempt)) continue;
      iconAttempts.add(attempt);
      void cacheQuickFavicon(link, link.favicon);
    }
  }, [links]);
  useEffect(() => {
    const refresh = () => setLinks(getQuickLinks());
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) refresh();
    };
    window.addEventListener(CHANGED, refresh);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener('storage', storage);
    };
  }, []);
  return links;
}
