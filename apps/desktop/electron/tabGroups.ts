export const TAB_GROUP_COLORS = {
  blue: '#7aa8ff', purple: '#bb96f5', pink: '#ee91bf', red: '#ef8585',
  orange: '#e8a66d', yellow: '#dfc66e', green: '#86c69a', gray: '#a5abb5',
} as const;
export type TabGroupColor = keyof typeof TAB_GROUP_COLORS;
export type TabGroup = { id: string; name: string; color: TabGroupColor; collapsed: boolean };
export function normalizeTabGroup(value: unknown): TabGroup | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const group = value as Record<string, unknown>;
  if (typeof group.id !== 'string' || !group.id.trim() || group.id.length > 100) return undefined;
  return {
    id: group.id,
    name: typeof group.name === 'string' ? group.name.trim().slice(0, 60) : '',
    color: typeof group.color === 'string' && Object.hasOwn(TAB_GROUP_COLORS, group.color) ? group.color as TabGroupColor : 'blue',
    collapsed: group.collapsed === true,
  };
}
/** Pack group members together without changing the order of groups or their tabs. */
export function orderGroupedTabs<T extends { isPinned?: boolean; group?: TabGroup }>(tabs: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const tab of tabs) if (!tab.isPinned && tab.group) {
    const members = groups.get(tab.group.id) ?? [];
    members.push(tab); groups.set(tab.group.id, members);
  }
  const result: T[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (tab.isPinned) { result.push(tab.group ? { ...tab, group: undefined } : tab); continue; }
    if (!tab.group) result.push(tab);
    else if (!seen.has(tab.group.id)) { result.push(...groups.get(tab.group.id)!); seen.add(tab.group.id); }
  }
  return result.every((tab, index) => tab === tabs[index]) ? tabs : result;
}


/** Move an entire group past a tab or another group, preserving member order. */
export function moveTabGroup<T extends { id: string; isPinned?: boolean; group?: TabGroup }>(
  tabs: T[], groupId: string, targetId: string, after: boolean,
): T[] {
  const members = tabs.filter(tab => tab.group?.id === groupId);
  const target = tabs.find(tab => tab.id === targetId);
  if (!members.length || !target || target.group?.id === groupId || target.isPinned) return tabs;
  const remaining = tabs.filter(tab => tab.group?.id !== groupId);
  const targets = remaining.flatMap((tab, index) => (target.group ? tab.group?.id === target.group.id : tab.id === targetId) ? [index] : []);
  const index = after ? targets[targets.length - 1] + 1 : targets[0];
  remaining.splice(index, 0, ...members);
  return remaining.every((tab, index) => tab === tabs[index]) ? tabs : remaining;
}

/** Place a removed tab immediately before or after its remaining group members. */
export function removeTabFromGroup<T extends { id: string; group?: TabGroup }>(tabs: T[], id: string, side: 'before' | 'after' = 'after'): T[] {
  const source = tabs.find(tab => tab.id === id);
  if (!source?.group) return tabs;
  const remaining = tabs.filter(tab => tab.id !== id);
  const members = remaining.flatMap((tab, index) => tab.group?.id === source.group!.id ? [index] : []);
  const index = members.length
    ? side === 'before' ? members[0] : members[members.length - 1] + 1
    : tabs.indexOf(source);
  remaining.splice(index, 0, { ...source, group: undefined });
  return remaining;
}
