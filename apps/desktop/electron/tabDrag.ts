export type TabDropLayout = {
  left: number; top: number; right: number; bottom: number;
  vertical: boolean;
  tabs: { id?: string; index: number; midpoint: number }[];
};

export function tabDropIndex(layout: TabDropLayout, x: number, y: number, draggedId?: string): number | null {
  if (x < layout.left || x > layout.right || y < layout.top || y > layout.bottom) return null;
  const coordinate = layout.vertical ? y : x;
  const removed = layout.tabs.find(tab => draggedId && tab.id === draggedId);
  const remaining = layout.tabs.filter(tab => !removed || tab !== removed);
  const index = remaining.find(tab => coordinate < tab.midpoint)?.index
    ?? (remaining.length ? remaining[remaining.length - 1].index + 1 : 0);
  return removed && removed.index < index ? index - 1 : index;
}

export function detachedTabBounds(workArea: { width: number; height: number }, x: number, y: number,
  offsetX = 140, offsetY = 18) {
  return {
    x: Math.round(x - offsetX), y: Math.round(y - offsetY),
    width: Math.min(900, Math.round(workArea.width * 0.75)),
    height: Math.min(650, Math.round(workArea.height * 0.75)),
  };
}
