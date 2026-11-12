import { confirmDialog } from '../components/appDialogs';
import { useEffect, useMemo, useState } from 'react';
import { useTabs } from '../features/tabs/TabsProvider';
import {
  clearHistoryEntries,
  deleteHistoryEntry,
  listHistoryEntries,
  subscribeHistoryChanges,
} from '../features/history/clientHistory';
import type { HistoryEntry } from '../features/history/clientHistory';
import { getBrowserSettings } from '../features/settings/browserSettings';

function formatDayHeading(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function getDayKey(ts: number): string {
  const date = new Date(ts);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function History() {
  const { navigate } = useTabs();
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [retention, setRetention] = useState(() => getBrowserSettings().historyRetentionDays);

  useEffect(() => {
    let mounted = true;
    let revision = 0;
    const refresh = () => {
      const currentRevision = ++revision;
      setRetention(getBrowserSettings().historyRetentionDays);
      listHistoryEntries()
        .then((list) => {
          if (!mounted || currentRevision !== revision) return;
          setItems(Array.isArray(list) ? list : []);
        })
        .catch(() => {
          if (!mounted || currentRevision !== revision) return;
          setItems([]);
        })
        .finally(() => {
          if (!mounted || currentRevision !== revision) return;
          setLoading(false);
        });
      };
    refresh();
    const unsubscribe = subscribeHistoryChanges(refresh);

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const sections = useMemo(() => {
    const grouped: Array<{ dayKey: string; heading: string; entries: HistoryEntry[] }> = [];
    const map = new Map<string, number>();

    for (const entry of items) {
      const dayKey = getDayKey(entry.visitedAt);
      const existingIdx = map.get(dayKey);
      if (existingIdx !== undefined) {
        grouped[existingIdx].entries.push(entry);
        continue;
      }
      map.set(dayKey, grouped.length);
      grouped.push({
        dayKey,
        heading: formatDayHeading(entry.visitedAt),
        entries: [entry],
      });
    }

    return grouped;
  }, [items]);

  const onDelete = async (entryId: string) => {
    const deleted = await deleteHistoryEntry(entryId).catch(() => false);
    if (!deleted) return;
    setItems((prev) => prev.filter((item) => item.id !== entryId));
  };

  const onClearAll = async () => {
    if (!items.length || isClearing) return;
    if (!await confirmDialog({ title: 'Clear browsing history?', confirmLabel: 'Clear all' })) return;

    setIsClearing(true);
    const cleared = await clearHistoryEntries().catch(() => false);
    if (cleared) {
      setItems([]);
    }
    setIsClearing(false);
  };

  return (
    <div style={{ padding: 20, background: 'var(--bg)', color: 'var(--text1)', minHeight: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ marginTop: 0, marginBottom: 12 }}>History</h2>
        <button
          onClick={onClearAll}
          disabled={loading || !items.length || isClearing}
          className="theme-btn theme-btn-nav"
          style={{ padding: '6px 10px', marginBottom: 12 }}
        >
          Clear all
        </button>
      </div>

      {loading && <div>Loading history...</div>}
      {!loading && items.length === 0 && (
        <div className="theme-text2">{retention === 0 ? 'Browsing history is turned off.' : retention === 'forever' ? 'No history yet. History is kept until you delete it.' : `No history yet. Entries are kept for ${retention} ${retention === 1 ? 'day' : 'days'}.`}</div>
      )}

      {sections.map((section) => (
        <section key={section.dayKey} style={{ marginBottom: 20 }}>
          <h3 style={{ margin: '8px 0', fontSize: 14 }} className="theme-text2">
            {section.heading}
          </h3>
          <div className="theme-panel" style={{ borderRadius: 8, overflow: 'hidden' }}>
            {section.entries.map((entry) => (
              <div
                key={entry.id}
                style={{
                  borderBottom: '1px solid var(--tabBorder)',
                  display: 'flex',
                  alignItems: 'stretch',
                }}
              >
                <button
                  onClick={() => navigate(entry.url)}
                  className="theme-btn theme-btn-nav"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    borderRadius: 0,
                    borderWidth: 0,
                    padding: '10px 12px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        title={entry.title}
                      >
                        {entry.title}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        className="theme-text2"
                        title={entry.url}
                      >
                        {entry.url}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, flexShrink: 0 }} className="theme-text3">
                      {formatTime(entry.visitedAt)}
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => void onDelete(entry.id)}
                  className="theme-btn theme-btn-nav"
                  title="Delete history entry"
                  aria-label={`Delete history entry for ${entry.title}`}
                  style={{
                    borderRadius: 0,
                    borderWidth: 0,
                    borderLeft: '1px solid var(--tabBorder)',
                    padding: '10px 12px',
                    flexShrink: 0,
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
