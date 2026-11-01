/** Keep each group in its existing order and avoid changing unchanged state. */
export function orderPinnedTabs<T extends { isPinned?: boolean }>(tabs: T[]): T[] {
  let sawRegular = false;
  for (const tab of tabs) {
    if (!tab.isPinned) sawRegular = true;
    else if (sawRegular) return [...tabs.filter(tab => tab.isPinned), ...tabs.filter(tab => !tab.isPinned)];
  }
  return tabs;
}


/** Reorder inside a group, or explicitly move a tab across the pin boundary. */
export function moveTabInGroup<T extends { id: string; isPinned?: boolean }>(
  tabs: T[], id: string, toIndex: number, options?: { isPinned?: boolean },
): T[] {
  const fromIndex = tabs.findIndex(tab => tab.id === id);
  if (fromIndex < 0 || !Number.isFinite(toIndex)) return tabs;
  const original = tabs[fromIndex];
  const moved = options?.isPinned === undefined ? original : { ...original, isPinned: options.isPinned };
  const remaining = tabs.filter(tab => tab.id !== id);
  const pins = remaining.filter(tab => tab.isPinned).length;
  const min = moved.isPinned ? 0 : pins;
  const max = moved.isPinned ? pins : remaining.length;
  const target = Math.max(min, Math.min(Math.floor(toIndex), max));
  if (target === fromIndex && !!moved.isPinned === !!original.isPinned) return tabs;
  remaining.splice(target, 0, moved);
  return remaining;
}
