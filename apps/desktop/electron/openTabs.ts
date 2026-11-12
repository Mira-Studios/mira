export type OpenTab = { id: string; title: string; url: string; windowId: number };

/** Live tab metadata only; never persists private or regular tabs to disk. */
export class OpenTabsRegistry {
  private windows = new Map<number, { scope: string; tabs: OpenTab[] }>();

  update(windowId: number, scope: string, value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const tabs: OpenTab[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id ||
          typeof candidate.url !== 'string' || !candidate.url.trim() || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      tabs.push({ id: candidate.id, title: typeof candidate.title === 'string' ? candidate.title : candidate.url,
        url: candidate.url, windowId });
    }
    const previous = this.windows.get(windowId);
    if (previous?.scope === scope && JSON.stringify(previous.tabs) === JSON.stringify(tabs)) return false;
    this.windows.set(windowId, { scope, tabs });
    return true;
  }

  list(sourceWindowId: number, scope: string): OpenTab[] {
    return [...this.windows.entries()].flatMap(([windowId, entry]) =>
      windowId !== sourceWindowId && entry.scope === scope ? entry.tabs.map(tab => ({ ...tab })) : [],
    );
  }

  has(windowId: number, scope: string, tabId: string): boolean {
    const entry = this.windows.get(windowId);
    return entry?.scope === scope && entry.tabs.some(tab => tab.id === tabId);
  }

  remove(windowId: number): boolean {
    return this.windows.delete(windowId);
  }
}
