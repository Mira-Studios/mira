import type { Tab } from '../src/features/tabs/types';

export type RecentlyClosedEntry = {
  id: string;
  tabs: Tab[];
  activeId: string;
  closedAt: number;
  isGroup: boolean;
  isWindow?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  isMaximized?: boolean;
  isFullScreen?: boolean;
};

export const RECENTLY_CLOSED_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

export function pruneRecentlyClosed(entries: RecentlyClosedEntry[], now = Date.now(), limit = Number.POSITIVE_INFINITY): RecentlyClosedEntry[] {
  return entries.filter(entry => entry.tabs.length > 0 && Number.isFinite(entry.closedAt)
    && entry.closedAt > now - RECENTLY_CLOSED_RETENTION_MS && entry.closedAt <= now)
    .sort((a, b) => a.closedAt - b.closedAt).slice(-limit);
}

export function addClosedWindow(entries: RecentlyClosedEntry[], snapshot: {
  tabs: Tab[]; activeId: string;
  bounds?: RecentlyClosedEntry['bounds']; isMaximized?: boolean; isFullScreen?: boolean;
}, limit = Number.POSITIVE_INFINITY): RecentlyClosedEntry[] {
  if (!snapshot.tabs.length) return entries;
  return pruneRecentlyClosed([...entries, {
    ...snapshot, id: crypto.randomUUID(), closedAt: Date.now(), isGroup: false, isWindow: true,
    tabs: snapshot.tabs.map(tab => ({ ...tab, history: [...tab.history], group: tab.group && { ...tab.group } })),
  }], Date.now(), limit);
}

type ClosingGroup = { id: string; tabs: Tab[]; activeId: string; closedAt: number };

export function addClosedTab(entries: RecentlyClosedEntry[], tab: Tab, batch?: ClosingGroup, limit = Number.POSITIVE_INFINITY): RecentlyClosedEntry[] {
  const url = tab.url.trim().toLowerCase().split(/[?#]/, 1)[0].replace(/\/+$/, '');
  if (!url || url === 'mira://newtab' || url === 'about:blank') return entries;
  const previous = batch && entries.find(entry => entry.id === batch.id);
  const saved = { ...tab, history: [...tab.history], group: tab.group && { ...tab.group } };
  const members = [...(previous?.tabs ?? []), saved];
  const entry: RecentlyClosedEntry = {
    id: batch?.id ?? crypto.randomUUID(),
    tabs: batch ? batch.tabs.flatMap(member => members.filter(item => item.id === member.id)) : members,
    activeId: batch?.activeId ?? tab.id,
    closedAt: batch?.closedAt ?? Date.now(),
    isGroup: !!batch,
  };
  return pruneRecentlyClosed([...entries.filter(item => item.id !== entry.id), entry], Date.now(), limit);
}

export function restoreClosedEntry(entry: RecentlyClosedEntry): { tabs: Tab[]; activeId: string } {
  const selected = entry.tabs.find(tab => tab.id === entry.activeId) ?? entry.tabs[0];
  let activeId = '';
  const tabs = entry.tabs.map(tab => {
    const id = crypto.randomUUID();
    const active = tab === selected;
    if (active) activeId = id;
    return {
      ...tab, id, history: [...tab.history], group: tab.group && { ...tab.group },
      isSleeping: false, restoreDeferred: !active, reloadToken: 0, lastActiveAt: Date.now(),
      transferredGuestInstance: undefined, detachedTransferId: undefined,
      transferredWebContentsId: undefined, authFlowSourceTabId: undefined, authFlowInitialUrl: undefined,
    };
  });
  return { tabs, activeId };
}
