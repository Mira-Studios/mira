import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bookmark as BookmarkIcon,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  Globe,
  History,
  PanelsTopLeft,
  Pencil,
  Plus,
  Settings2,
  UserRound,
} from 'lucide-react';
import { electron } from '../electronBridge';
import { useBookmarks, type Bookmark } from '../features/bookmarks/BookmarksProvider';
import { useTabs } from '../features/tabs/TabsProvider';
import TabFavicon from '../features/tabs/TabFavicon';
import { useProfiles, profileAction, profileError } from '../features/profiles/useProfiles';
import { openProfileEditor } from '../features/profiles/profileEditor';
import { saveBrowserSettings } from '../features/settings/browserSettings';
import { useSidebarSettings } from '../features/sidebar/useSidebarSettings';
import { SIDEBAR_SECTION_LABELS, type SidebarSection } from '../features/sidebar/sidebarSettings';
import './BrowserSidebar.css';
import SidebarTooltip from './SidebarTooltip';

const SidebarTooltips = createContext(true);

function SectionHeading({
  label,
  icon,
  onOpen,
  action,
}: {
  label: string;
  icon: ReactNode;
  onOpen: () => void;
  action?: ReactNode;
}) {
  const tooltips = useContext(SidebarTooltips);
  return (
    <div className="browser-sidebar-section-heading">
      <button
        type="button"
        className="theme-btn theme-btn-nav browser-sidebar-item browser-sidebar-section-link"
        data-sidebar-tooltip={tooltips ? label : undefined}
        aria-label={label}
        onClick={onOpen}
      >
        <span className="browser-sidebar-icon">{icon}</span>
        <span className="browser-sidebar-label">{label}</span>
      </button>
      {action && <span className="browser-sidebar-section-action">{action}</span>}
    </div>
  );
}

function SidebarBookmarks() {
  const tooltips = useContext(SidebarTooltips);
  const { bookmarks } = useBookmarks();
  const { newTab, openBookmarks, tabs } = useTabs();
  const [folders, setFolders] = useState<Set<string>>(() => new Set());
  const icons = useMemo(() => new Map(tabs.map((tab) => [tab.url, tab.favicon])), [tabs]);
  const renderBookmark = (bookmark: Bookmark, depth: number, parent: string) => {
    const isFolder = bookmark.type === 'folder';
    const opened = folders.has(bookmark.id);
    const label = bookmark.title || bookmark.url || 'Untitled';
    const tooltip = parent ? `${parent} / ${label}` : label;
    return (
      <li key={bookmark.id}>
        <button
          type="button"
          className="theme-btn theme-btn-nav browser-sidebar-item"
          data-sidebar-tooltip={tooltips ? tooltip : undefined}
          aria-label={tooltip}
          aria-expanded={isFolder ? opened : undefined}
          style={{ '--sidebar-item-depth': depth } as React.CSSProperties}
          onClick={() => {
            if (isFolder)
              setFolders((previous) => {
                const next = new Set(previous);
                if (next.has(bookmark.id)) next.delete(bookmark.id);
                else next.add(bookmark.id);
                return next;
              });
            else if (bookmark.url) newTab(bookmark.url);
          }}
          onAuxClick={(event) => {
            if (event.button === 1 && bookmark.url && !isFolder) {
              event.preventDefault();
              newTab(bookmark.url, { activate: false });
            }
          }}
        >
          <span className="browser-sidebar-icon">
            {isFolder ? (
              opened ? (
                <FolderOpen size={18} />
              ) : (
                <Folder size={18} />
              )
            ) : bookmark.url && icons.get(bookmark.url) ? (
              <TabFavicon url={bookmark.url} src={icons.get(bookmark.url)} size={18} deferred />
            ) : (
              <Globe size={18} />
            )}
          </span>
          <span className="browser-sidebar-label">{label}</span>
          {isFolder && (
            <span className="browser-sidebar-folder-caret">
              {opened ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          )}
        </button>
        {isFolder && opened && (
          <ul className="browser-sidebar-list">
            {bookmark.children?.map((child) => renderBookmark(child, depth + 1, tooltip))}
            {!bookmark.children?.length && <li className="browser-sidebar-empty">Empty folder</li>}
          </ul>
        )}
      </li>
    );
  };
  return (
    <>
      <SectionHeading label="Bookmarks" icon={<BookmarkIcon size={16} />} onOpen={openBookmarks} />
      <ul className="browser-sidebar-list">
        {bookmarks.map((bookmark) => renderBookmark(bookmark, 0, ''))}
      </ul>
      {!bookmarks.length && <p className="browser-sidebar-empty">No bookmarks</p>}
    </>
  );
}

function SidebarProfiles() {
  const tooltips = useContext(SidebarTooltips);
  const state = useProfiles();
  const { newTab } = useTabs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = async (id: string) => {
    if (busy || id === state.currentId) return;
    setBusy(true);
    setError('');
    try {
      await profileAction('profiles-open', id);
    } catch (failure) {
      setError(profileError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionHeading
        label="Profiles"
        icon={<UserRound size={16} />}
        onOpen={() => newTab('mira://Settings#section=profiles')}
        action={
          <button
            type="button"
            className="theme-btn theme-btn-nav browser-sidebar-icon-button"
            aria-label="Add profile"
            data-sidebar-tooltip="Add profile"
            onClick={() => openProfileEditor()}
          >
            <Plus size={16} />
          </button>
        }
      />
      <ul className="browser-sidebar-list">
        {state.profiles.map((profile) => (
          <li key={profile.id} className="browser-sidebar-profile-row">
            <button
              type="button"
              className={`theme-btn theme-btn-nav browser-sidebar-item ${profile.id === state.currentId ? 'browser-sidebar-item-current' : ''}`}
              data-sidebar-tooltip={tooltips ? profile.name : undefined}
              aria-label={profile.name}
              aria-current={profile.id === state.currentId ? 'true' : undefined}
              disabled={busy}
              onClick={() => void open(profile.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                openProfileEditor(profile);
              }}
            >
              <span className="browser-sidebar-icon">
                {profile.avatar ? (
                  <img src={profile.avatar} alt="" className="browser-sidebar-avatar" />
                ) : (
                  <UserRound size={18} />
                )}
              </span>
              <span className="browser-sidebar-label">{profile.name}</span>
              {profile.id === state.currentId && (
                <Check size={13} className="browser-sidebar-current-check" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="theme-btn theme-btn-nav browser-sidebar-icon-button browser-sidebar-profile-edit"
              aria-label={`Edit ${profile.name}`}
              data-sidebar-tooltip={`Edit ${profile.name}`}
              onClick={() => openProfileEditor(profile)}
            >
              <Pencil size={14} />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="browser-sidebar-error" role="alert" data-sidebar-tooltip={error}>
          {error}
        </p>
      )}
    </>
  );
}

function SidebarRecentlyClosed() {
  const tooltips = useContext(SidebarTooltips);
  const { recentlyClosed, restoreRecentlyClosed, openRecentlyClosed } = useTabs();
  const entries = [...recentlyClosed].reverse().slice(0, 12);
  return (
    <>
      <SectionHeading
        label="Recently closed"
        icon={<History size={16} />}
        onOpen={openRecentlyClosed}
      />
      <ul className="browser-sidebar-list">
        {entries.map((entry) => {
          const first = entry.tabs[0];
          if (!first) return null;
          const label = entry.isWindow
            ? `Window · ${entry.tabs.length} tabs`
            : entry.isGroup
              ? `${first.group?.name || 'Group'} · ${entry.tabs.length} tabs`
              : first.title || first.url;
          return (
            <li key={entry.id}>
              <button
                type="button"
                className="theme-btn theme-btn-nav browser-sidebar-item"
                data-sidebar-tooltip={tooltips ? `Restore ${label}` : undefined}
                aria-label={`Restore ${label}`}
                onClick={() => restoreRecentlyClosed(entry.id, { animate: true })}
              >
                <span className="browser-sidebar-icon">
                  {entry.isWindow || entry.isGroup ? (
                    <PanelsTopLeft size={18} />
                  ) : (
                    <TabFavicon url={first.url} src={first.favicon} size={18} deferred />
                  )}
                </span>
                <span className="browser-sidebar-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {!entries.length && <p className="browser-sidebar-empty">No recently closed tabs</p>}
    </>
  );
}

const sectionComponents: Record<SidebarSection, React.ComponentType> = {
  bookmarks: SidebarBookmarks,
  profiles: SidebarProfiles,
  'recently-closed': SidebarRecentlyClosed,
};

export default function BrowserSidebar({ hidden = false }: { hidden?: boolean }) {
  const settings = useSidebarSettings();
  const { newTab } = useTabs();
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [tooltipTarget, setTooltipTarget] = useState<HTMLElement | null>(null);
  const [tooltipDismissKey, setTooltipDismissKey] = useState(0);
  const dismissTooltip = () => {
    setTooltipTarget(null);
    setTooltipDismissKey((value) => value + 1);
  };
  useEffect(() => {
    const blur = () => {
      setHovered(false);
      setKeyboardFocus(false);
      setTooltipTarget(null);
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, []);
  useEffect(() => {
    if (!settings.sidebarEnabled || hidden) {
      setHovered(false);
      setKeyboardFocus(false);
      setTooltipTarget(null);
    }
  }, [settings.sidebarEnabled, hidden]);
  if (!settings.sidebarEnabled || hidden) return null;
  const expanded =
    settings.sidebarMode === 'expanded' ||
    (settings.sidebarMode === 'hover' && (hovered || keyboardFocus));
  const sections = settings.sidebarSectionOrder.filter(
    (section) =>
      settings.sidebarSections.includes(section) &&
      (!electron?.isPrivate || section !== 'profiles'),
  );
  const tooltips = !expanded && settings.sidebarShowTooltips;
  const CollapseIcon = (settings.sidebarSide === 'left') === expanded ? ChevronLeft : ChevronRight;
  const toggleLabel =
    settings.sidebarMode === 'hover'
      ? 'Keep sidebar open'
      : expanded
        ? 'Collapse sidebar'
        : 'Expand sidebar';
  return (
    <SidebarTooltips.Provider value={tooltips}>
      <aside
        aria-label="Browser sidebar"
        data-side={settings.sidebarSide}
        data-expanded={expanded}
        data-mode={settings.sidebarMode}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setTooltipTarget(null);
        }}
        onMouseOver={(event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>('[data-sidebar-tooltip]')
              : null;
          setTooltipTarget(target);
        }}
        onMouseOut={(event) => {
          if (tooltipTarget?.contains(event.relatedTarget as Node | null)) return;
          const next =
            event.relatedTarget instanceof Element
              ? event.relatedTarget.closest<HTMLElement>('[data-sidebar-tooltip]')
              : null;
          setTooltipTarget(next && event.currentTarget.contains(next) ? next : null);
        }}
        onScrollCapture={dismissTooltip}
        onKeyDown={(event) => {
          if (event.key === 'Escape') dismissTooltip();
        }}
        onPointerDownCapture={() => {
          setKeyboardFocus(false);
          dismissTooltip();
        }}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) {
            const keyboard = event.target.matches(':focus-visible');
            setKeyboardFocus(keyboard);
            setTooltipTarget(
              keyboard ? event.target.closest<HTMLElement>('[data-sidebar-tooltip]') : null,
            );
          }
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setKeyboardFocus(false);
          setTooltipTarget(null);
        }}
        className={`browser-sidebar ${expanded ? 'browser-sidebar-expanded' : ''} ${settings.animationsEnabled ? 'browser-sidebar-animated' : ''}`}
      >
        <div className="browser-sidebar-sections">
          {sections.map((section) => {
            const Content = sectionComponents[section];
            return (
              <section
                key={section}
                className="browser-sidebar-section"
                aria-label={SIDEBAR_SECTION_LABELS[section]}
                data-sidebar-section={section}
              >
                <Content />
              </section>
            );
          })}
        </div>
        <div className="browser-sidebar-footer">
          <button
            type="button"
            className="theme-btn theme-btn-nav browser-sidebar-item"
            data-sidebar-tooltip={tooltips ? 'Sidebar settings' : undefined}
            aria-label="Sidebar settings"
            onClick={() => newTab('mira://Settings#section=layout')}
          >
            <span className="browser-sidebar-icon">
              <Settings2 size={18} />
            </span>
            <span className="browser-sidebar-label">Sidebar settings</span>
          </button>
          <button
            type="button"
            className="theme-btn theme-btn-nav browser-sidebar-item browser-sidebar-toggle"
            data-sidebar-tooltip={tooltips ? toggleLabel : undefined}
            aria-label={toggleLabel}
            aria-expanded={expanded}
            onClick={() =>
              saveBrowserSettings({
                sidebarMode:
                  settings.sidebarMode === 'hover' || !expanded ? 'expanded' : 'collapsed',
              })
            }
          >
            <span className="browser-sidebar-icon">
              <CollapseIcon size={18} />
            </span>
            <span className="browser-sidebar-label">{toggleLabel}</span>
          </button>
        </div>
      </aside>
      <SidebarTooltip
        target={tooltipTarget}
        side={settings.sidebarSide}
        enabled={tooltips}
        animated={settings.animationsEnabled}
        dismissKey={tooltipDismissKey}
      />
    </SidebarTooltips.Provider>
  );
}
