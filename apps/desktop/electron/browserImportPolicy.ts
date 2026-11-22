export type ImportBrowserId = 'edge' | 'chrome' | 'comet' | 'opera' | 'opera-gx' | 'brave' | 'firefox';
export const IMPORT_BROWSERS: { id: ImportBrowserId; name: string }[] = [
  { id: 'edge', name: 'Microsoft Edge' }, { id: 'chrome', name: 'Google Chrome' },
  { id: 'comet', name: 'Comet' }, { id: 'opera', name: 'Opera' },
  { id: 'opera-gx', name: 'Opera GX' }, { id: 'brave', name: 'Brave' }, { id: 'firefox', name: 'Firefox' },
];
export type ImportedBookmark = { title: string; type: 'bookmark' | 'folder'; url?: string; children?: ImportedBookmark[] };
export type ImportedVisit = { url: string; title: string; visitedAt: number };
export type ImportProfile = { id: string; name: string; bookmarks: boolean; history: boolean; avatar?: string };
export type DetectedBrowser = { id: ImportBrowserId; name: string; installed: boolean; profiles: ImportProfile[] };
export type BatchImportResult = {
  groups: { source: string; bookmarks: ImportedBookmark[] }[];
  historyCount: number;
  profiles: { id: string; name: string; sourceId: string; bookmarkCount: number; historyCount: number }[];
  failures: { sourceId: string; message: string }[];
};

export function importableUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32768) return;
  try { const url = new URL(value); if (['http:', 'https:', 'file:'].includes(url.protocol)) return url.href; } catch { /* Invalid bookmark. */ }
}
export function chromiumBookmarks(value: unknown): ImportedBookmark[] {
  let count = 0;
  const convert = (raw: unknown, depth: number): ImportedBookmark | undefined => {
    if (!raw || typeof raw !== 'object' || depth > 32 || ++count > 50_000) return;
    const node = raw as { name?: unknown; type?: unknown; url?: unknown; children?: unknown[] };
    const title = typeof node.name === 'string' ? node.name.slice(0, 1000) : '';
    if (node.type === 'url') { const url = importableUrl(node.url); if (url) return { type: 'bookmark', title: title || url, url }; }
    if (node.type === 'folder' && Array.isArray(node.children)) return { type: 'folder', title: title || 'Bookmarks', children: node.children.flatMap(child => convert(child, depth + 1) ?? []) };
  };
  const roots = value && typeof value === 'object' ? (value as { roots?: Record<string, unknown> }).roots : undefined;
  return roots && typeof roots === 'object' ? Object.values(roots).flatMap(root => convert(root, 0) ?? []) : [];
}
