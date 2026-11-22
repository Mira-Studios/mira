import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromiumBookmarks, importableUrl, type ImportedBookmark, type ImportedVisit, type ImportBrowserId } from './browserImportPolicy.ts';
type Source = { directory: string; firefox: boolean; browser: string; name: string; bookmarks: boolean; history: boolean; avatarFile?: string };
export const exists = (file: string) => fs.access(file).then(() => true, () => false);

export function browserImportRoots(platform: string, home: string, roaming: string, local: string): Record<ImportBrowserId, string[]> {
  const roots: Record<ImportBrowserId, string[]> = { edge: [], chrome: [], comet: [], opera: [], 'opera-gx': [], brave: [], firefox: [] };
  const add = (id: ImportBrowserId, root: string, ...parts: string[]) => roots[id].push(path.join(root, ...parts));
  if (platform === 'win32') {
    add('edge', local, 'Microsoft/Edge/User Data'); add('chrome', local, 'Google/Chrome/User Data');
    add('brave', local, 'BraveSoftware/Brave-Browser/User Data');
    for (const location of ['Perplexity/Comet/User Data', 'Comet/User Data', 'Perplexity/Comet']) add('comet', local, location);
    add('opera', roaming, 'Opera Software/Opera Stable'); add('opera-gx', roaming, 'Opera Software/Opera GX Stable');
    add('firefox', roaming, 'Mozilla/Firefox');
  } else if (platform === 'darwin') {
    add('edge', roaming, 'Microsoft Edge'); add('chrome', roaming, 'Google/Chrome'); add('brave', roaming, 'BraveSoftware/Brave-Browser');
    add('comet', roaming, 'Comet'); add('comet', roaming, 'Perplexity/Comet');
    add('opera', roaming, 'com.operasoftware.Opera'); add('opera-gx', roaming, 'com.operasoftware.OperaGX'); add('firefox', roaming, 'Firefox');
  } else {
    add('edge', roaming, 'microsoft-edge'); add('chrome', roaming, 'google-chrome'); add('brave', roaming, 'BraveSoftware/Brave-Browser');
    add('comet', roaming, 'comet'); add('opera', roaming, 'opera'); add('opera-gx', roaming, 'opera-gx');
    add('firefox', home, '.mozilla/firefox'); add('firefox', home, 'snap/firefox/common/.mozilla/firefox'); add('firefox', home, '.var/app/org.mozilla.firefox/.mozilla/firefox');
  }
  return roots;
}

export async function profilesAt(root: string, firefox: boolean): Promise<Source[]> {
  const candidates = new Map<string, string>([[root, 'Default']]);
  const avatars = new Map<string, string>();
  const children = async (directory: string) => (await fs.readdir(directory, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).slice(0, 128);
  for (const entry of await children(root)) candidates.set(path.join(root, entry.name), entry.name);
  for (const parent of firefox ? ['Profiles'] : ['_side_profiles']) {
    for (const entry of await children(path.join(root, parent))) {
      candidates.set(path.join(root, parent, entry.name), entry.name);
      if (!firefox) candidates.set(path.join(root, parent, entry.name, 'Default'), entry.name);
    }
  }
  if (firefox) {
    const ini = await fs.readFile(path.join(root, 'profiles.ini'), 'utf8').catch(() => '');
    for (const section of ini.split(/\r?\n\[/)) {
      const location = section.match(/^Path=(.+)$/m)?.[1].trim();
      if (!location) continue;
      const name = section.match(/^Name=(.+)$/m)?.[1].trim() || path.basename(location);
      candidates.set(/^IsRelative=0\s*$/m.test(section) ? location : path.resolve(root, location), name);
    }
  } else {
    try {
      const local = JSON.parse(await fs.readFile(path.join(root, 'Local State'), 'utf8'));
      for (const [folder, value] of Object.entries(local.profile?.info_cache || {})) {
        if (path.basename(folder) !== folder) continue;
        const metadata = value as { name?: string; gaia_picture_file_name?: string; profile_picture_file_name?: string };
        const directory = path.join(root, folder);
        if (typeof metadata.name === 'string') candidates.set(directory, metadata.name);
        const avatar = metadata.gaia_picture_file_name || metadata.profile_picture_file_name;
        if (typeof avatar === 'string' && path.basename(avatar) === avatar) avatars.set(directory, avatar);
      }
    } catch { /* Profile folder names are sufficient if metadata is unavailable. */ }
  }
  const profiles: Source[] = [];
  for (const [directory, name] of candidates) {
    const bookmarks = await exists(path.join(directory, firefox ? 'places.sqlite' : 'Bookmarks'));
    const history = await exists(path.join(directory, firefox ? 'places.sqlite' : 'History'));
    if (bookmarks || history) profiles.push({ directory, name, firefox, bookmarks, history, browser: '', avatarFile: avatars.get(directory) });
  }
  return profiles;
}

/** Read cached pictures only; discovery never contacts the source browser's account. */
export async function readProfileAvatar(source: Source): Promise<Buffer | undefined> {
  const directory = await fs.realpath(source.directory).catch(() => '');
  if (!directory) return;
  for (const name of [source.avatarFile, 'Google Profile Picture.png', 'Edge Profile Picture.png', 'Profile Picture.png', 'avatar.png']) {
    if (!name || path.basename(name) !== name) continue;
    try {
      const file = await fs.realpath(path.join(directory, name));
      const relative = path.relative(directory, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const stat = await fs.stat(file);
      if (stat.size > 1024 * 1024 || !stat.isFile()) continue;
      const buffer = await fs.readFile(file);
      if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (buffer[0] === 255 && buffer[1] === 216)) return buffer;
    } catch { /* A profile without a cached picture uses the profile icon. */ }
  }
}

function database(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
  return db;
}

export async function readBrowserSource(source: Source, options: { bookmarks: boolean; history: boolean }): Promise<{ bookmarks: ImportedBookmark[]; history: ImportedVisit[] }> {
  const result: { bookmarks: ImportedBookmark[]; history: ImportedVisit[] } = { bookmarks: [], history: [] };
  if (options.bookmarks && source.bookmarks && !source.firefox) {
    const file = path.join(source.directory, 'Bookmarks');
    if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error('The bookmark file is too large to import.');
    result.bookmarks = chromiumBookmarks(JSON.parse(await fs.readFile(file, 'utf8')));
  }
  if ((options.bookmarks && source.bookmarks && source.firefox) || (options.history && source.history)) {
    const db = database(path.join(source.directory, source.firefox ? 'places.sqlite' : 'History'));
    try {
      if (source.firefox && options.bookmarks) {
        const rows = db.prepare('SELECT b.id,b.parent,b.type,b.title,b.guid,p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk=p.id ORDER BY b.position LIMIT 50000').all() as { id: number; parent: number; type: number; title: string | null; guid: string; url: string | null }[];
        const byParent = new Map<number, typeof rows>();
        for (const row of rows) { const list = byParent.get(row.parent) || []; list.push(row); byParent.set(row.parent, list); }
        const convert = (row: typeof rows[number], depth = 0): ImportedBookmark[] => {
          if (depth > 32) return [];
          if (row.type === 1) { const url = importableUrl(row.url); return url ? [{ type: 'bookmark', title: row.title || url, url }] : []; }
          if (row.type !== 2) return [];
          const children = (byParent.get(row.id) || []).flatMap(child => convert(child, depth + 1));
          if (row.guid === 'root________') return children;
          return [{ type: 'folder', title: row.title || ({ toolbar_____: 'Bookmarks toolbar', menu________: 'Bookmarks menu', unfiled_____: 'Other bookmarks', mobile______: 'Mobile bookmarks' } as Record<string, string>)[row.guid] || 'Bookmarks', children }];
        };
        result.bookmarks = (byParent.get(0) || []).flatMap(row => convert(row));
      }
      if (options.history && source.history) {
        const rows = db.prepare(source.firefox
          ? 'SELECT url,title,last_visit_date AS time FROM moz_places WHERE last_visit_date IS NOT NULL AND hidden=0 ORDER BY last_visit_date DESC LIMIT 10000'
          : 'SELECT url,title,CAST(last_visit_time AS REAL) AS time FROM urls WHERE hidden=0 ORDER BY last_visit_time DESC LIMIT 10000').all() as { url: string; title: string; time: number }[];
        result.history = rows.flatMap(row => {
          const url = importableUrl(row.url);
          const visitedAt = Number(row.time) / 1000 - (source.firefox ? 0 : 11644473600000);
          return url && Number.isFinite(visitedAt) && visitedAt > 0 && visitedAt <= Date.now() + 86400000 ? [{ url, title: row.title || url, visitedAt }] : [];
        });
      }
    } finally { db.close(); }
  }
  return result;
}


