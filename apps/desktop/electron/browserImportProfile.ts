import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProfileStore } from './profileStore.ts';
import { mergeImportedBookmarks } from './bookmarkImportPolicy.ts';
import type { ImportedBookmark, ImportedVisit } from './browserImportPolicy.ts';
import { DEFAULT_HISTORY_RETENTION_DAYS, pruneHistoryEntries } from './historyPolicy.ts';

/** Initialize a new, unopened profile. No live Chromium storage is touched. */
export function createImportedProfile(store: ProfileStore, name: string, data: { bookmarks: ImportedBookmark[]; history: ImportedVisit[] }, avatar?: Buffer) {
  const names = new Set(store.read().profiles.map(profile => profile.name.toLowerCase()));
  const base = name.trim().slice(0, 52) || 'Imported profile';
  let unique = base;
  for (let suffix = 2; names.has(unique.toLowerCase()); suffix++) unique = `${base} (${suffix})`;
  const bookmarks = mergeImportedBookmarks([], [{ source: name, bookmarks: data.bookmarks }]);
  const seen = new Set<string>();
  const history = pruneHistoryEntries(data.history.filter(visit => {
    const key = JSON.stringify([visit.url, visit.visitedAt]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(visit => ({ ...visit, id: randomUUID() })).sort((a, b) => b.visitedAt - a.visitedAt), DEFAULT_HISTORY_RETENTION_DAYS);
  const profile = store.create(unique, (directory, profile) => {
    if (avatar) { fs.writeFileSync(path.join(directory, 'profile-avatar.png'), avatar, { flag: 'wx' }); profile.hasAvatar = true; }
    fs.writeFileSync(path.join(directory, 'browser-import-bookmarks.v1.json'), JSON.stringify({ id: randomUUID(), bookmarks: bookmarks.bookmarks }), { flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify(history), { flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'getting-started.v1.json'), JSON.stringify({ version: 1, completed: ['import'], dismissed: false }), { flag: 'wx' });
  });
  return { profile, bookmarkCount: bookmarks.count, historyCount: history.length };
}
