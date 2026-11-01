import ContextMenu from './ContextMenu';
import { usePromptPresence } from '../hooks/usePromptPresence';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Globe,
  History,
  Lock,
  Plus,
  Printer,
  RotateCw,
  Settings2,
  SquareArrowOutUpRight,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useTabs } from '../features/tabs/TabsProvider';
import { useBookmarks } from '../features/bookmarks/BookmarksProvider';
import DownloadButton from './DownloadButton';
import DeviceConnectionsButton from './DeviceConnectionsButton';
import PageZoomControl from './PageZoomControl';
import {
  BROWSER_SETTINGS_CHANGED_EVENT,
  getBrowserSettings,
  getSearchUrlFromInput,
} from '../features/settings/browserSettings';
import { markPendingHttpsUpgrade, toHttpsUrlFromHttp } from '../features/security/unsecureSitePolicy';
import { electron } from '../electronBridge';

const MENU_ANIMATION_MS = 150;

function ReloadIcon() {
  return <RotateCw size={16} strokeWidth={1.9} aria-hidden="true" />;
}

function BackIcon() {
  return <ChevronLeft size={16} strokeWidth={2.1} aria-hidden="true" />;
}

function ForwardIcon() {
  return <ChevronRight size={16} strokeWidth={2.1} aria-hidden="true" />;
}

type AddressBarProps = {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  inTopBar?: boolean;
};

type AddressMenuAction = {
  id: string;
  label: string;
  shortcut?: string;
  icon: React.ComponentType<{ size?: string | number; className?: string }>;
  danger?: boolean;
  onSelect: () => void;
};

type SitePermissionRequestPayload = {
  requestId: string;
  webContentsId: number;
  origin: string;
  topLevelOrigin: string;
  siteLabel: string;
  label: string;
  permissionIds: string[];
  url: string;
};

type SiteSettingsPageInfo =
  | {
      kind: 'internal' | 'file' | 'unsupported';
      siteLabel: string;
      statusLabel: string;
      origin?: undefined;
    }
  | {
      kind: 'site';
      siteLabel: string;
      statusLabel: string;
      origin: string;
      secure: boolean;
    };

function stripViewSourcePrefix(url: string): string {
  return url.startsWith('view-source:') ? url.slice('view-source:'.length) : url;
}

function readSiteSettingsPageInfo(url: string | undefined): SiteSettingsPageInfo {
  const normalized = stripViewSourcePrefix(url?.trim() ?? '');
  if (!normalized || normalized.startsWith('mira://')) {
    return {
      kind: 'internal',
      siteLabel: 'Mira page',
      statusLabel: 'Internal pages do not use site permissions.',
    };
  }

  try {
    const parsed = new URL(normalized);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') {
      return {
        kind: 'site',
        siteLabel: parsed.hostname || parsed.origin,
        statusLabel: protocol === 'https:' ? 'Connection is secure' : 'Connection is not secure',
        origin: parsed.origin,
        secure: protocol === 'https:',
      };
    }

    if (protocol === 'file:') {
      return {
        kind: 'file',
        siteLabel: 'Local file',
        statusLabel: 'Local files do not use site permission controls.',
      };
    }
  } catch {
    // Fall through to unsupported below.
  }

  return {
    kind: 'unsupported',
    siteLabel: 'This page',
    statusLabel: 'Site settings are not available for this address.',
  };
}

export default function AddressBar({ inputRef, inTopBar = false }: AddressBarProps) {
  const {
    tabs,
    activeId,
    navigate,
    goBack,
    goForward,
    reload,
    reloadIgnoringCache,
    clearCacheAndReload,
    stopLoading,
    isPageLoading,
    newTab,
    openHistory,
    openDownloads,
    openBookmarks,
    setActive,
    printPage,
  } = useTabs();
  const { addBookmark, bookmarks, deleteBookmark } = useBookmarks();
  const [input, setInput] = useState('');
  const [reloadMenuAnchor, setReloadMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const closeReloadMenu = useCallback(() => setReloadMenuAnchor(null), []);
  useEffect(() => { setReloadMenuAnchor(null); }, [activeId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [siteSettingsOpen, setSiteSettingsOpen] = useState(false);
  const [siteSettingsClosing, setSiteSettingsClosing] = useState(false);
  const [permissionRequests, setPermissionRequests] = useState<SitePermissionRequestPayload[]>([]);
  const [animationsEnabled, setAnimationsEnabled] = useState(
    () => getBrowserSettings().animationsEnabled,
  );
  const [showBookmarkButton, setShowBookmarkButton] = useState(
    () => getBrowserSettings().showBookmarkButton,
  );
  const menuRef = useRef<HTMLDivElement | null>(null);
  const siteSettingsRef = useRef<HTMLDivElement | null>(null);
  const menuCloseTimerRef = useRef<number | null>(null);
  const siteSettingsCloseTimerRef = useRef<number | null>(null);

  const clearMenuCloseTimer = useCallback(() => {
    if (menuCloseTimerRef.current === null) return;
    window.clearTimeout(menuCloseTimerRef.current);
    menuCloseTimerRef.current = null;
  }, []);

  const closeMenu = useCallback(() => {
    if (!menuOpen) return;
    clearMenuCloseTimer();
    if (!animationsEnabled) {
      setMenuOpen(false);
      setMenuClosing(false);
      return;
    }

    setMenuOpen(false);
    setMenuClosing(true);
    menuCloseTimerRef.current = window.setTimeout(() => {
      setMenuClosing(false);
      menuCloseTimerRef.current = null;
    }, MENU_ANIMATION_MS);
  }, [menuOpen, animationsEnabled, clearMenuCloseTimer]);

  const openMenu = useCallback(() => {
    clearMenuCloseTimer();
    setMenuClosing(false);
    setMenuOpen(true);
  }, [clearMenuCloseTimer]);

  const clearSiteSettingsCloseTimer = useCallback(() => {
    if (siteSettingsCloseTimerRef.current === null) return;
    window.clearTimeout(siteSettingsCloseTimerRef.current);
    siteSettingsCloseTimerRef.current = null;
  }, []);

  const closeSiteSettings = useCallback(() => {
    if (!siteSettingsOpen) return;
    clearSiteSettingsCloseTimer();
    setSiteSettingsOpen(false);
    if (!animationsEnabled) {
      setSiteSettingsClosing(false);
      return;
    }

    setSiteSettingsClosing(true);
    siteSettingsCloseTimerRef.current = window.setTimeout(() => {
      setSiteSettingsClosing(false);
      siteSettingsCloseTimerRef.current = null;
    }, MENU_ANIMATION_MS);
  }, [siteSettingsOpen, animationsEnabled, clearSiteSettingsCloseTimer]);

  const closeMenusForDeviceChooser = useCallback(() => {
    closeMenu();
    closeSiteSettings();
  }, [closeMenu, closeSiteSettings]);

  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeId);
    if (!activeTab) return;

    if (activeTab.url === getBrowserSettings().newTabPage) {
      setInput('');
    } else {
      setInput(activeTab.url);
    }
  }, [tabs, activeId]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const activePageInfo = readSiteSettingsPageInfo(activeTab?.url);
  const activePermissionRequest = permissionRequests[0] ?? null;
  const { displayed: displayedPermissionRequest, closing: permissionClosing, animated: permissionAnimated } = usePromptPresence(activePermissionRequest);

  const isSupportedProtocol = (value: string) => {
    const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*:)/i);
    if (!schemeMatch) return false;
    const scheme = schemeMatch[1].toLowerCase();
    return (
      scheme === 'http:' ||
      scheme === 'https:' ||
      scheme === 'file:' ||
      scheme === 'about:' ||
      scheme === 'mira:' ||
      scheme === 'data:' ||
      scheme === 'view-source:'
    );
  };

  const isIpv4Host = (hostname: string) => {
    const parts = hostname.split('.');
    if (parts.length !== 4) return false;
    return parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const value = Number.parseInt(part, 10);
      return value >= 0 && value <= 255;
    });
  };

  const isLikelyDomainOrHost = (hostname: string) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'localhost') return true;
    if (isIpv4Host(normalized)) return true;
    if (normalized.includes(':')) return true; // IPv6 style host
    if (!normalized.includes('.')) return false;

    const labels = normalized.split('.');
    return labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9-]+$/i.test(label) &&
        !label.startsWith('-') &&
        !label.endsWith('-'),
    );
  };

  const isLikelyDomainOrUrl = (value: string) => {
    if (/\s/.test(value)) return false;
    if (isSupportedProtocol(value)) return true;

    // Check for host:port format (e.g., localhost:3000) before rejecting as unknown scheme
    const schemeLikeMatch = value.match(/^([a-z][a-z0-9+.-]*):(.*)/i);
    if (schemeLikeMatch) {
      const afterColon = schemeLikeMatch[2];
      // If after colon is just a port number, it's host:port, not a scheme
      const isPort = /^\d+$/.test(afterColon) && Number(afterColon) > 0 && Number(afterColon) <= 65535;
      if (!isPort) return false;
    }

    const candidate = value.startsWith('//') ? `https:${value}` : `https://${value}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return isLikelyDomainOrHost(parsed.hostname);
    } catch {
      return false;
    }
  };

  const go = () => {
    const raw = input.trim();
    if (!raw) return;

    let finalUrl: string;
    if (isSupportedProtocol(raw)) {
      if (/^http:\/\//i.test(raw)) {
        const httpsUrl = toHttpsUrlFromHttp(raw);
        if (httpsUrl) {
          markPendingHttpsUpgrade(raw, httpsUrl);
          navigate(httpsUrl);
          return;
        }
      }
      finalUrl = raw;
    } else if (isLikelyDomainOrUrl(raw)) {
      finalUrl = raw.startsWith('//') ? `https:${raw}` : `https://${raw}`;
    } else {
      const settings = getBrowserSettings();
      finalUrl = getSearchUrlFromInput(
        raw,
        settings.searchEngine,
        settings.searchEngineShortcutsEnabled,
        settings.searchEngineShortcutPrefix,
        settings.searchEngineShortcutChars,
      );
    }

    navigate(finalUrl);
  };

  const canGoBack = activeTab && activeTab.historyIndex > 0;
  const canGoForward = activeTab && activeTab.historyIndex < activeTab.history.length - 1;

  // Check if current page is already bookmarked
  const isCurrentPageBookmarked = activeTab ? 
    bookmarks.some(bookmark => 
      bookmark.type === 'bookmark' && bookmark.url === activeTab.url
    ) : false;

  const getCurrentPageBookmark = () => {
    if (!activeTab) return null;
    return bookmarks.find(bookmark => 
      bookmark.type === 'bookmark' && bookmark.url === activeTab.url
    ) || null;
  };

  const handleBookmarkCurrentPage = () => {
    if (!activeTab || !activeTab.url) return;
    
    // Don't allow bookmarking error pages
    if (activeTab.url.startsWith('mira://errors/')) return;
    
    if (isCurrentPageBookmarked) {
      // Remove the bookmark
      const currentBookmark = getCurrentPageBookmark();
      if (currentBookmark) {
        deleteBookmark(currentBookmark.id);
      }
      return;
    }

    addBookmark({
      title: activeTab.title || activeTab.url,
      type: 'bookmark',
      url: activeTab.url,
    });
  };

  const newTabPage = getBrowserSettings().newTabPage;
  const primaryModifierLabel = electron?.isMacOS ? 'Cmd' : 'Ctrl';
  const openNewWindow = () => {
    if (electron?.ipcRenderer) {
      electron.ipcRenderer.invoke('window-new').catch(() => undefined);
      return;
    }
    window.open(window.location.href, '_blank', 'noopener,noreferrer');
  };
  const closeWindow = () => {
    if (electron?.ipcRenderer) {
      electron.ipcRenderer.invoke('window-close').catch(() => undefined);
      return;
    }
    window.close();
  };

  const respondToPermissionRequest = useCallback(
    async (decision: 'allow' | 'block' | 'dismiss') => {
      const pendingRequest = displayedPermissionRequest;
      if (!pendingRequest || permissionClosing || pendingRequest.requestId !== activePermissionRequest?.requestId) return;

      const ipc = electron?.ipcRenderer;
      setPermissionRequests((current) => current.filter((entry) => entry.requestId !== pendingRequest.requestId));
      if (!ipc) return;

      try {
        await ipc.invoke<{
          ok?: boolean;
        }>('site-permission-request-respond', {
          requestId: pendingRequest.requestId,
          decision,
        });
      } catch {
        // Ignore request-response failures. The request has already been removed from the queue.
      }
    },
    [activePermissionRequest, displayedPermissionRequest, permissionClosing],
  );

  useEffect(() => {
    const syncSettings = () => {
      setAnimationsEnabled(getBrowserSettings().animationsEnabled);
      setShowBookmarkButton(getBrowserSettings().showBookmarkButton);
    };
    syncSettings();
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
    return () => window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
  }, []);

  useEffect(() => {
    return () => {
      clearMenuCloseTimer();
      clearSiteSettingsCloseTimer();
    };
  }, [clearMenuCloseTimer, clearSiteSettingsCloseTimer]);

  useEffect(() => {
    const menuVisible = menuOpen || menuClosing;
    if (!menuVisible && !siteSettingsOpen && !siteSettingsClosing) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (siteSettingsRef.current?.contains(target)) return;
      if (menuVisible) {
        closeMenu();
      }
      closeSiteSettings();
    };

    // Close popups when clicking on webview (window loses focus)
    const onBlur = () => {
      if (menuVisible) {
        closeMenu();
      }
      closeSiteSettings();
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [menuOpen, menuClosing, closeMenu, siteSettingsOpen, siteSettingsClosing, closeSiteSettings]);

  useEffect(() => {
    clearSiteSettingsCloseTimer();
    setSiteSettingsOpen(false);
    setSiteSettingsClosing(false);
  }, [activeId, clearSiteSettingsCloseTimer]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onSitePermissionRequest = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || !payload) return;
      const candidate = payload as Partial<SitePermissionRequestPayload>;
      const requestId = typeof candidate.requestId === 'string' ? candidate.requestId.trim() : '';
      const origin = typeof candidate.origin === 'string' ? candidate.origin.trim() : '';
      const topLevelOrigin = typeof candidate.topLevelOrigin === 'string' ? candidate.topLevelOrigin.trim() : '';
      const siteLabel = typeof candidate.siteLabel === 'string' ? candidate.siteLabel.trim() : '';
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      const permissionIds = Array.isArray(candidate.permissionIds)
        ? candidate.permissionIds.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
      const webContentsId =
        typeof candidate.webContentsId === 'number' && Number.isFinite(candidate.webContentsId)
          ? Math.floor(candidate.webContentsId)
          : -1;

      if (!requestId || !origin || !label || webContentsId <= 0) return;
      setPermissionRequests((current) => {
        if (current.some((entry) => entry.requestId === requestId)) return current;
        return current.concat({
          requestId,
          webContentsId,
          origin,
          topLevelOrigin,
          siteLabel: siteLabel || origin,
          label,
          permissionIds,
          url,
        });
      });
    };

    ipc.on('site-permission-request', onSitePermissionRequest);
    return () => ipc.off('site-permission-request', onSitePermissionRequest);
  }, []);

  const openBrowserSettingsPage = () => {
    const existingSettingsTab = tabs.find((tab) => tab.url === 'mira://Settings');

    if (existingSettingsTab) {
      setActive(existingSettingsTab.id);
    } else if (activeTab?.url === newTabPage) {
      navigate('mira://Settings');
    } else {
      newTab('mira://Settings');
    }
  };

  const openBrowserSettingsPageWithOrigin = (origin: string) => {
    const url = `mira://Settings#section=privacy-security&subsection=site-permissions&site=${encodeURIComponent(origin)}`;
    const existingSettingsTab = tabs.find((tab) => tab.url.startsWith('mira://Settings'));

    if (existingSettingsTab) {
      // Navigate the existing settings tab and activate it
      navigate(url, existingSettingsTab.id);
      setActive(existingSettingsTab.id);
    } else if (activeTab?.url === newTabPage) {
      navigate(url);
    } else {
      newTab(url);
    }
  };

  const menuActions: AddressMenuAction[] = [
    {
      id: 'new-tab',
      label: 'New Tab',
      shortcut: `${primaryModifierLabel}+T`,
      icon: Plus,
      onSelect: () => newTab(),
    },
    {
      id: 'new-window',
      label: 'New Window',
      shortcut: `${primaryModifierLabel}+N`,
      icon: SquareArrowOutUpRight,
      onSelect: openNewWindow,
    },
    {
      id: 'history',
      label: 'History',
      shortcut: `${primaryModifierLabel}+${electron?.isMacOS ? 'Y' : 'H'}`,
      icon: History,
      onSelect: openHistory,
    },
    {
      id: 'downloads',
      label: 'Downloads',
      shortcut: `${primaryModifierLabel}+J`,
      icon: Download,
      onSelect: openDownloads,
    },
    {
      id: 'bookmarks',
      label: 'Bookmarks',
      shortcut: `${primaryModifierLabel}+Shift+O`,
      icon: Bookmark,
      onSelect: openBookmarks,
    },
    {
      id: 'print',
      label: 'Print...',
      shortcut: `${primaryModifierLabel}+P`,
      icon: Printer,
      onSelect: printPage,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings2,
      onSelect: openBrowserSettingsPage,
    },
    {
      id: 'close-window',
      label: 'Close Window',
      icon: X,
      danger: true,
      onSelect: closeWindow,
    },
  ];

  const onSelectMenuAction = (action: AddressMenuAction) => {
    action.onSelect();
    closeMenu();
  };

  const menuVisible = menuOpen || menuClosing;
  const toggleSiteSettingsPanel = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (siteSettingsOpen) {
      closeSiteSettings();
      return;
    }
    closeMenu();
    clearSiteSettingsCloseTimer();
    setSiteSettingsClosing(false);
    setSiteSettingsOpen(true);
  };

  const siteSettingsStatusIcon = activePageInfo.kind === 'site'
    ? activePageInfo.secure
      ? Lock
      : TriangleAlert
    : activePageInfo.kind === 'file'
      ? FileText
      : Globe;
  const SiteSettingsStatusIcon = siteSettingsStatusIcon;

  return (
    <div
      className={inTopBar ? 'address-bar-in-topbar' : undefined}
      onDoubleClick={inTopBar ? (event) => event.stopPropagation() : undefined}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        padding: inTopBar ? '0' : 'var(--layoutAddressBarPaddingY, 6px)',
        gap: 4,
        background: inTopBar ? 'transparent' : 'var(--surfaceBgHover, var(--tabBgHover))',
        borderTop: inTopBar ? undefined : '1px solid var(--surfaceBorder, var(--tabBorder))',
        flex: inTopBar ? 1 : undefined,
        minWidth: 0,
      }}
    >
      <button
        onClick={goBack}
        disabled={!canGoBack}
        title="Back"
        className="theme-btn theme-btn-nav nav-icon-btn"
        style={{
          padding: '4px 8px',
          height: 'var(--layoutNavButtonHeight, 30px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <BackIcon />
      </button>

      <button
        onClick={goForward}
        disabled={!canGoForward}
        title="Forward"
        className="theme-btn theme-btn-nav nav-icon-btn"
        style={{
          padding: '4px 8px',
          height: 'var(--layoutNavButtonHeight, 30px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ForwardIcon />
      </button>

      <button
        onClick={isPageLoading ? stopLoading : reload}
        onContextMenu={(event) => {
          event.preventDefault();
          closeMenu();
          closeSiteSettings();
          if (getBrowserSettings().nativeTextFieldContextMenu && electron?.ipcRenderer) {
            setReloadMenuAnchor(null);
            void electron.ipcRenderer.invoke('reload-show-native-context-menu', {
              x: event.clientX,
              y: event.clientY,
            }).then((action: unknown) => {
              if (action === 'reload') reload();
              if (action === 'hard-reload') reloadIgnoringCache();
              if (action === 'clear-cache-reload') clearCacheAndReload();
            }).catch(() => undefined);
            return;
          }
          setReloadMenuAnchor({ x: event.clientX, y: event.clientY });
        }}
        aria-haspopup="menu"
        aria-expanded={!!reloadMenuAnchor}
        title={isPageLoading ? 'Stop loading' : 'Reload'}
        aria-label={isPageLoading ? 'Stop loading' : 'Reload'}
        className="theme-btn theme-btn-nav nav-icon-btn"
        style={{
          padding: '4px 8px',
          height: 'var(--layoutNavButtonHeight, 30px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isPageLoading ? <X size={16} strokeWidth={1.9} aria-hidden="true" /> : <ReloadIcon />}
      </button>

      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onContextMenu={(e) => {
            const settings = getBrowserSettings();
            if (!settings.nativeTextFieldContextMenu) return;
            const ipc = electron?.ipcRenderer;
            if (!ipc) return;

            e.preventDefault();
            e.currentTarget.focus();
            void ipc
              .invoke('renderer-show-native-text-context-menu', {
                x: e.clientX,
                y: e.clientY,
              })
              .catch(() => undefined);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            go();
            e.currentTarget.blur();
          }}
          placeholder="Enter URL"
          className="theme-input"
          style={{
            width: '100%',
            borderRadius: 999,
            padding: '6px 14px',
            minHeight: 'var(--layoutNavButtonHeight, 30px)',
            fontSize: 16,
            paddingRight: showBookmarkButton ? '40px' : '14px',
          }}
        />
        {showBookmarkButton && (
          <button
            onClick={handleBookmarkCurrentPage}
            disabled={!activeTab || !activeTab.url || activeTab.url.startsWith('mira://errors/')}
            title={isCurrentPageBookmarked ? "Remove bookmark" : "Bookmark this page"}
            className="theme-btn theme-btn-nav"
            style={{
              position: 'absolute',
              right: '6px',
              top: '50%',
              transform: 'translateY(-50%)',
              padding: '4px',
              height: '24px',
              width: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isCurrentPageBookmarked ? 'var(--accent)' : 'inherit',
              background: 'transparent',
              border: 'none',
              borderRadius: '4px',
            }}
          >
            <Bookmark
              size={14}
              strokeWidth={isCurrentPageBookmarked ? 2.5 : 1.9}
              fill={isCurrentPageBookmarked ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
          </button>
        )}
      </div>

      <PageZoomControl key={`zoom-${activeId}`} animationsEnabled={animationsEnabled} onOpen={closeMenusForDeviceChooser} />

      <DeviceConnectionsButton key={activeId} animationsEnabled={animationsEnabled}
        onOpen={closeMenusForDeviceChooser} otherMenuOpen={menuOpen || siteSettingsOpen} />

      <div ref={siteSettingsRef} style={{ position: 'relative' }}>
        <button
          onClick={(e) => toggleSiteSettingsPanel(e)}
          title="Site settings"
          className={`theme-btn theme-btn-nav nav-icon-btn site-settings-trigger ${
            siteSettingsOpen ? 'site-settings-trigger-open' : ''
          }`}
          aria-haspopup="dialog"
          aria-expanded={siteSettingsOpen}
          style={{
            padding: '4px 8px',
            height: 'var(--layoutNavButtonHeight, 30px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Settings2 size={16} strokeWidth={2} aria-hidden="true" />
        </button>

        {(siteSettingsOpen || siteSettingsClosing) && (
          <div
            className={`theme-panel site-settings-panel ${
              animationsEnabled
                ? siteSettingsOpen
                  ? 'site-settings-panel-open'
                  : 'site-settings-panel-closing'
                : ''
            }`}
            role="dialog"
            aria-label="Site settings"
          >
            <div className="site-settings-panel-header">
              <div className="site-settings-panel-title-row">
                <span
                  className={`site-settings-panel-status-icon site-settings-panel-status-icon-${
                    activePageInfo.kind === 'site' && activePageInfo.secure
                      ? 'secure'
                      : activePageInfo.kind === 'site'
                        ? 'warning'
                        : 'neutral'
                  }`}
                >
                  <SiteSettingsStatusIcon size={15} strokeWidth={2} aria-hidden="true" />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="site-settings-panel-title">{activePageInfo.siteLabel}</div>
                  <div className="site-settings-panel-subtitle">{activePageInfo.statusLabel}</div>
                </div>
              </div>
              {activePageInfo.kind === 'site' && (
                <div className="site-settings-panel-origin">{activePageInfo.origin}</div>
              )}
            </div>

            {activePageInfo.kind !== 'site' ? (
              <div className="site-settings-panel-empty">{activePageInfo.statusLabel}</div>
            ) : (
              <div className="site-settings-panel-content">
                {/* Button to open settings */}
                <button
                  type="button"
                  className="theme-btn theme-btn-nav site-settings-open-settings-btn"
                  onClick={() => {
                    closeSiteSettings();
                    openBrowserSettingsPageWithOrigin(activePageInfo.siteLabel);
                  }}
                >
                  Manage Permissions for This Site
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <DownloadButton />

      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          onClick={() => {
            if (menuOpen) {
              closeMenu();
              return;
            }
            closeSiteSettings();
            openMenu();
          }}
          title="Menu"
          className={`theme-btn theme-btn-nav nav-icon-btn address-menu-trigger ${
            menuOpen ? 'address-menu-trigger-open' : ''
          }`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          style={{
            padding: '4px 8px',
            height: 'var(--layoutNavButtonHeight, 30px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: 2,
          }}
        >
          <ChevronDown
            size={16}
            strokeWidth={2.1}
            aria-hidden="true"
            className="address-menu-trigger-icon"
          />
        </button>

        {menuVisible && (
          <div
            className={`theme-panel address-menu-panel ${
              animationsEnabled
                ? menuOpen
                  ? 'address-menu-panel-open'
                  : 'address-menu-panel-closing'
                : ''
            }`}
            role="menu"
            aria-label="Browser menu"
            style={{ zIndex: 1200 }}
          >
            {menuActions.slice(0, 6).map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className={`theme-btn address-menu-item ${action.danger ? 'address-menu-item-danger' : ''}`}
                  onClick={() => onSelectMenuAction(action)}
                >
                  <Icon size={14} className="address-menu-item-icon" />
                  <span className="address-menu-item-label">{action.label}</span>
                  {action.shortcut ? (
                    <span className="address-menu-item-shortcut">{action.shortcut}</span>
                  ) : (
                    <span className="address-menu-item-shortcut address-menu-item-shortcut-empty" />
                  )}
                </button>
              );
            })}
            <hr className="address-menu-divider" />
            {menuActions.slice(6).map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className={`theme-btn address-menu-item ${action.danger ? 'address-menu-item-danger' : ''}`}
                  onClick={() => onSelectMenuAction(action)}
                >
                  <Icon size={14} className="address-menu-item-icon" />
                  <span className="address-menu-item-label">{action.label}</span>
                  {action.shortcut ? (
                    <span className="address-menu-item-shortcut">{action.shortcut}</span>
                  ) : (
                    <span className="address-menu-item-shortcut address-menu-item-shortcut-empty" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {displayedPermissionRequest && (
        <div key={displayedPermissionRequest.requestId} className={`site-permission-anchor ${permissionAnimated ? permissionClosing ? 'prompt-motion-out' : 'prompt-motion-in' : ''}`} inert={permissionClosing} aria-hidden={permissionClosing || undefined}>
        <div
          className="theme-panel site-permission-prompt prompt-motion-panel"
          role="dialog"
          aria-labelledby="site-permission-prompt-title"
          aria-describedby="site-permission-prompt-message"
        >
          <div className="site-permission-prompt-title-row">
            <div className="site-permission-prompt-heading">
              <div id="site-permission-prompt-title" className="site-permission-prompt-title">
                {displayedPermissionRequest.siteLabel}
              </div>
              {displayedPermissionRequest.topLevelOrigin && displayedPermissionRequest.topLevelOrigin !== displayedPermissionRequest.origin && (
                <div className="site-permission-prompt-origin">
                  On {displayedPermissionRequest.topLevelOrigin}
                </div>
              )}
            </div>
            <button
              type="button"
              className="theme-btn theme-btn-nav site-permission-prompt-close"
              aria-label="Dismiss permission request"
              onClick={() => { void respondToPermissionRequest('dismiss'); }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div id="site-permission-prompt-message" className="site-permission-prompt-message">
            {displayedPermissionRequest.permissionIds.includes('storage-access')
              ? 'Use cross-site cookies?'
              : `${displayedPermissionRequest.label}?`}
          </div>
          <div className="site-permission-prompt-actions">
            <button
              type="button"
              onClick={() => {
                void respondToPermissionRequest('block');
              }}
              className="theme-btn theme-btn-nav site-permission-prompt-btn"
            >
              Block
            </button>
            <button
              type="button"
              onClick={() => {
                void respondToPermissionRequest('allow');
              }}
              className="theme-btn theme-btn-nav site-permission-prompt-btn site-permission-prompt-btn-primary"
            >
              Allow
            </button>
          </div>
        </div>
        </div>
      )}
      <ContextMenu
        open={!!reloadMenuAnchor}
        anchor={reloadMenuAnchor}
        onClose={closeReloadMenu}
        entries={[
          { type: 'item', label: 'Reload', shortcut: `${primaryModifierLabel}+R`, onSelect: reload },
          { type: 'item', label: 'Hard reload', shortcut: `${primaryModifierLabel}+Shift+R`, onSelect: reloadIgnoringCache },
          { type: 'item', label: 'Clear cache and reload', shortcut: `${primaryModifierLabel}+${electron?.isMacOS ? 'Option' : 'Alt'}+Shift+R`, onSelect: clearCacheAndReload },
        ]}
      />
    </div>
  );
}
