import { useTabs } from '../features/tabs/TabsProvider';
import TabFavicon from '../features/tabs/TabFavicon';
import { TAB_GROUP_COLORS } from '../../electron/tabGroups';
import { PanelsTopLeft } from 'lucide-react';

export default function RecentlyClosed() {
  const { recentlyClosed, restoreRecentlyClosed } = useTabs();
  return (
    <main style={{ minHeight: '100%', padding: '32px 24px', background: 'var(--bg)', color: 'var(--text1)' }}>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <h1 style={{ fontSize: 26, margin: '0 0 24px' }}>Recently Closed</h1>
        <p className="theme-text2">Closed tabs, groups, and windows are shared across the app and kept for two days.</p>
        {!recentlyClosed.length && <p className="theme-text2">No recently closed tabs or windows.</p>}
        {[...recentlyClosed].reverse().map(entry => {
          const first = entry.tabs[0];
          const group = !entry.isWindow && entry.isGroup ? first.group : undefined;
          return (
            <section key={entry.id} style={{ borderBottom: '1px solid var(--tabBorder)', padding: '16px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    {entry.isWindow ? <PanelsTopLeft size={16} aria-hidden /> : group ? <span style={{ width: 10, height: 10, borderRadius: '50%', background: TAB_GROUP_COLORS[group.color], flexShrink: 0 }} /> : <TabFavicon url={first.url} src={first.favicon} size={16} deferred />}
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.isWindow ? 'Window' : group ? group.name || 'Unnamed group' : first.title}</strong>
                  </div>
                  <div className="theme-text2" style={{ fontSize: 12, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.isWindow || group ? `${entry.tabs.length} ${entry.tabs.length === 1 ? 'tab' : 'tabs'}` : first.url}
                    {' · '}{new Date(entry.closedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </div>
                </div>
                <button className="theme-btn theme-btn-nav" style={{ padding: '7px 14px', borderRadius: 12 }} onClick={() => restoreRecentlyClosed(entry.id)}>{entry.isWindow ? 'Restore window' : group ? 'Restore group' : 'Restore'}</button>
              </div>
              {(entry.isWindow || group) && <details style={{ marginTop: 10 }}>
                <summary className="theme-text2" style={{ cursor: 'pointer', fontSize: 13 }}>Show tabs</summary>
                {entry.tabs.map(tab => <div key={tab.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 0 16px', fontSize: 13 }}>
                  <TabFavicon url={tab.url} src={tab.favicon} size={16} deferred />
                  <span title={tab.url} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title}</span>
                </div>)}
              </details>}
            </section>
          );
        })}
      </div>
    </main>
  );
}
