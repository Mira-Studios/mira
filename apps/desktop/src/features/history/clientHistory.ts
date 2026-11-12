import { electron } from '../../electronBridge';
import { BROWSER_SETTINGS_CHANGED_EVENT, BROWSER_SETTINGS_STORAGE_KEY, getBrowserSettings } from '../settings/browserSettings';
import { pruneHistoryEntries } from '../../../electron/historyPolicy';

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
}

const DEV_HISTORY_KEY = 'mira_history';
const HISTORY_CHANGED_EVENT = 'mira:history-changed';

function prune(entries: HistoryEntry[]): HistoryEntry[] {
  return pruneHistoryEntries(entries, getBrowserSettings().historyRetentionDays);
}

function loadLocal(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(DEV_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    return prune(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

function saveLocal(entries: HistoryEntry[]) {
  localStorage.setItem(DEV_HISTORY_KEY, JSON.stringify(prune(entries)));
  window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
}

/** Refresh history views after mutations or a retention change in any window. */
export function subscribeHistoryChanges(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DEV_HISTORY_KEY || event.key === BROWSER_SETTINGS_STORAGE_KEY || event.key === null) callback();
  };
  window.addEventListener(HISTORY_CHANGED_EVENT, callback);
  window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, callback);
  window.addEventListener('storage', onStorage);
  electron?.ipcRenderer.on('history-changed', callback);
  return () => {
    window.removeEventListener(HISTORY_CHANGED_EVENT, callback);
    window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, callback);
    window.removeEventListener('storage', onStorage);
    electron?.ipcRenderer.off('history-changed', callback);
  };
}

/**
 * Adds a new visit entry unless the URL is internal or a near-duplicate of the latest visit.
 */
export async function addHistoryEntry(url: string, title: string): Promise<void> {
  if (electron?.isPrivate || getBrowserSettings().historyRetentionDays === 0) return;
  const normalized = url.trim();
  if (!normalized || normalized.startsWith('mira://')) return;

  if (electron?.ipcRenderer) {
    await electron.ipcRenderer.invoke('history-add', {
      url: normalized,
      title: title.trim() || normalized,
    });
    return;
  }

  const now = Date.now();
  const entries = loadLocal();
  const latest = entries[0];
  if (latest && latest.url === normalized && now - latest.visitedAt < 1500) {
    return;
  }

  saveLocal([
    {
      id: crypto.randomUUID(),
      url: normalized,
      title: title.trim() || normalized,
      visitedAt: now,
    },
    ...entries,
  ]);
}

/**
 * Updates a stored history title for an existing URL, or creates an entry in fallback mode.
 */
export async function updateHistoryEntryTitle(url: string, title: string): Promise<boolean> {
  if (electron?.isPrivate || getBrowserSettings().historyRetentionDays === 0) return false;
  const normalizedUrl = url.trim();
  const normalizedTitle = title.trim();
  if (!normalizedUrl || normalizedUrl.startsWith('mira://') || !normalizedTitle) return false;
  if (normalizedTitle === normalizedUrl) return false;

  if (electron?.ipcRenderer) {
    return !!(await electron.ipcRenderer.invoke<boolean>('history-update-title', {
      url: normalizedUrl,
      title: normalizedTitle,
    }));
  }

  const entries = loadLocal();
  const match = entries.find((entry) => entry.url === normalizedUrl);
  if (match) {
    if (match.title === normalizedTitle) return false;
    match.title = normalizedTitle;
    saveLocal(entries);
  } else {
    saveLocal([
      {
        id: crypto.randomUUID(),
        url: normalizedUrl,
        title: normalizedTitle,
        visitedAt: Date.now(),
      },
      ...entries,
    ]);
  }

  return true;
}

/**
 * Returns history entries newest-first with retention pruning applied.
 */
export async function listHistoryEntries(): Promise<HistoryEntry[]> {
  if (electron?.ipcRenderer) {
    const list = await electron.ipcRenderer.invoke<HistoryEntry[]>('history-list');
    return prune(Array.isArray(list) ? list : []);
  }

  const entries = loadLocal();
  // Reading must not broadcast another change and recursively refresh subscribers.
  localStorage.setItem(DEV_HISTORY_KEY, JSON.stringify(entries));
  return entries;
}

/**
 * Deletes a single history record by id.
 */
export async function deleteHistoryEntry(id: string): Promise<boolean> {
  const normalizedId = id.trim();
  if (!normalizedId) return false;

  if (electron?.ipcRenderer) {
    return !!(await electron.ipcRenderer.invoke<boolean>('history-delete', normalizedId));
  }

  const entries = loadLocal();
  const next = entries.filter((entry) => entry.id !== normalizedId);
  if (next.length === entries.length) return false;
  saveLocal(next);
  return true;
}

/**
 * Clears all retained history entries.
 */
export async function clearHistoryEntries(): Promise<boolean> {
  if (electron?.ipcRenderer) {
    return !!(await electron.ipcRenderer.invoke<boolean>('history-clear'));
  }

  const entries = loadLocal();
  if (!entries.length) return false;
  saveLocal([]);
  return true;
}
