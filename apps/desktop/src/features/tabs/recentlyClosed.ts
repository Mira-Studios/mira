import type { Tab } from './types';

export type RecentlyClosedEntry = {
  id: string;
  tabs: Tab[];
  activeId: string;
  closedAt: number;
  isGroup: boolean;
};

type ClosingGroup = { id: string; tabs: Tab[]; activeId: string; closedAt: number };

export function addClosedTab(entries: RecentlyClosedEntry[], tab: Tab, batch?: ClosingGroup, limit = 25): RecentlyClosedEntry[] {
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
  return [...entries.filter(item => item.id !== entry.id), entry].slice(-limit);
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
