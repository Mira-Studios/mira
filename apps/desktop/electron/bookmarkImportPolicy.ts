import type { ImportedBookmark } from './browserImportPolicy.ts';

export type StoredBookmark = ImportedBookmark & { id: string; parentId?: string; createdAt: number; updatedAt: number; children?: StoredBookmark[] };
export type BookmarkImportGroup = { source: string; bookmarks: ImportedBookmark[] };

/** Preserve existing trees and omit URLs already present, including across sources. */
export function mergeImportedBookmarks(existing: StoredBookmark[], groups: BookmarkImportGroup[]) {
  const seen = new Set<string>();
  const canonical = (url: string) => { try { return new URL(url).href; } catch { return url; } };
  const collect = (items: ImportedBookmark[]) => items.forEach(item => {
    if (item.url) seen.add(canonical(item.url));
    if (item.children) collect(item.children);
  });
  collect(existing);
  let count = 0;
  const now = Date.now();
  const stamp = (item: ImportedBookmark, parentId?: string): StoredBookmark | undefined => {
    if (item.type === 'bookmark') {
      if (!item.url || seen.has(canonical(item.url))) return;
      seen.add(canonical(item.url)); count++;
    }
    const id = crypto.randomUUID();
    const children = item.children?.flatMap(child => stamp(child, id) ?? []);
    if (item.type === 'folder' && !children?.length) return;
    return { ...item, id, parentId, children, createdAt: now, updatedAt: now };
  };
  const added = groups.flatMap(group => stamp({ type: 'folder', title: `Imported from ${group.source}`, children: group.bookmarks }) ?? []);
  return { bookmarks: [...existing, ...added], count };
}
