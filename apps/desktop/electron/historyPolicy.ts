export type HistoryRetentionDays = 0 | 1 | 7 | 30 | 90 | 365 | 'forever';
export const DEFAULT_HISTORY_RETENTION_DAYS: HistoryRetentionDays = 7;
export const HISTORY_RETENTION_OPTIONS: ReadonlyArray<{ value: HistoryRetentionDays; label: string }> = [
  { value: 0, label: 'Never save history' },
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
  { value: 'forever', label: 'Forever' },
];

export function normalizeHistoryRetentionDays(value: unknown): HistoryRetentionDays {
  return HISTORY_RETENTION_OPTIONS.find(option => option.value === value)?.value ?? DEFAULT_HISTORY_RETENTION_DAYS;
}

export function pruneHistoryEntries<T extends { visitedAt: number }>(
  entries: T[], retention: HistoryRetentionDays, now = Date.now(),
): T[] {
  if (retention === 0) return [];
  const cutoff = retention === 'forever' ? -Infinity : now - retention * 24 * 60 * 60 * 1000;
  return entries.filter(entry => entry && Number.isFinite(entry.visitedAt) && entry.visitedAt >= cutoff)
    .sort((a, b) => b.visitedAt - a.visitedAt);
}
