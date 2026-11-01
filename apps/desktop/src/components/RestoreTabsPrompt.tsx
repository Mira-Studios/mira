import { useTabs } from '../features/tabs/TabsProvider';

export default function RestoreTabsPrompt() {
  const {
    restorePromptOpen,
    restoreTabCount,
    restoreWindowCount,
    restoreTabsFromPreviousSession,
    restoreWindowsFromPreviousSession,
    discardPreviousSession,
  } = useTabs();

  if (!restorePromptOpen) return null;

  return (
    <div
      data-mira-prevent-suspension="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'color-mix(in srgb, var(--bg) 70%, transparent)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div
        className="theme-panel"
        style={{
          width: 420,
          maxWidth: 'calc(100vw - 32px)',
          borderRadius: 10,
          padding: 16,
        }}
      >
        <h3 style={{ margin: '0 0 8px 0' }} className="theme-text1">
          Restore Previous Session?
        </h3>
        <p style={{ margin: '0 0 14px 0', fontSize: 13, lineHeight: 1.4 }} className="theme-text2">
          Mira found {restoreTabCount} tab{restoreTabCount === 1 ? '' : 's'} across{' '}
          {restoreWindowCount} window{restoreWindowCount === 1 ? '' : 's'} from your last session.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            onClick={discardPreviousSession}
            className="theme-btn theme-btn-nav"
            style={{
              padding: '7px 12px',
            }}
          >
            Start Fresh
          </button>
          <button
            onClick={restoreTabsFromPreviousSession}
            className="theme-btn theme-btn-nav"
            style={{
              padding: '7px 12px',
            }}
          >
            Restore Tabs
          </button>
          <button
            onClick={restoreWindowsFromPreviousSession}
            className="theme-btn theme-btn-go"
            style={{
              padding: '7px 12px',
            }}
          >
            Restore Windows
          </button>
        </div>
      </div>
    </div>
  );
}
