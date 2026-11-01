import { normalizeTabGroup, orderGroupedTabs, moveTabGroup as moveGroupTabs, removeTabFromGroup, TAB_GROUP_COLORS, type TabGroup } from '../../../electron/tabGroups';
import { promptDialog } from '../../components/appDialogs';
import { createContext, useContext, useState, useReducer, useCallback, useEffect, useRef } from 'react';
import { electron } from '../../electronBridge';
import { 
  getBrowserSettings, 
  saveBrowserSettings, 
  BROWSER_SETTINGS_CHANGED_EVENT,
  getTabSleepAfterMs,
  type StartupRestoreBehavior,
} from '../settings/browserSettings';
import { addHistoryEntry, updateHistoryEntryTitle } from '../history/clientHistory';
import { useBookmarks } from '../bookmarks/BookmarksProvider';
import miraLogo from '../../assets/mira_logo.png';
import { type Tab } from './types';
import { addClosedTab, restoreClosedEntry, type RecentlyClosedEntry } from './recentlyClosed';
import { orderPinnedTabs, moveTabInGroup } from './pinnedTabs';
import { nextPageZoom, type PageZoomAction } from '../../../electron/pageZoomPolicy';
import { getNavigationMetadata, getUpdatedFavicon, type NavigationMetadata } from './tabMetadata';
import {
  captureTabState,
  restoreTabState,
  suspendJavaScript,
  resumeJavaScript,
  pauseAnimations,
  resumeAnimations,
  throttleTimers,
  restoreTimers,
} from './tabStateManagement';
import { isLikelyAuthUrl } from './popupFlows';

const SESSION_STORAGE_KEY = 'mira.session.tabs.v1';
const IPC_OPEN_TAB_DEDUPE_WINDOW_MS = 500;
const INTERNAL_FAVICON_URL = miraLogo;

type FindInPageOptions = {
  forward?: boolean;
  findNext?: boolean;
  matchCase?: boolean;
};

type ScrollPageCommand = 'page-down' | 'page-up' | 'top' | 'bottom';

type FindInPageMatchState = {
  activeMatchOrdinal: number;
  matches: number;
};

type WebviewElement = {
  loadURL?: (url: string, options?: unknown) => void;
  goBack?: () => void;
  goForward?: () => void;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  reload: () => void;
  reloadIgnoringCache?: () => void;
  isCurrentlyAudible?: () => boolean;
  isAudioMuted?: () => boolean;
  setAudioMuted?: (muted: boolean) => void;
  stop?: () => void;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  setZoomFactor?: (factor: number) => void;
  getZoomFactor?: () => number;
  findInPage: (text: string, options?: FindInPageOptions) => number;
  stopFindInPage?: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  openDevTools: () => void;
  closeDevTools: () => void;
  isDevToolsOpened: () => boolean;
  getWebContentsId?: () => number;
  getAttribute?: (qualifiedName: string) => string | null;
  guestinstance?: string;
  print?: (options?: unknown, callback?: (success: boolean, failureReason: string) => void) => void;
} | null;

type SessionSnapshot = {
  tabs: Tab[];
  activeId: string;
  savedAt: number;
};

type SessionRestoreState = {
  hasPendingRestore: boolean;
  tabCount: number;
  windowCount: number;
};

type SessionRestoreMode = 'tabs' | 'windows';

type DetachedTabWindowPosition = {
  screenX: number;
  screenY: number;
};

type MoveTabToNewWindowOptions = {
  dragMode?: boolean;
  pointerOffsetX?: number;
  pointerOffsetY?: number;
};

type NewTabToRightOptions = {
  activate?: boolean;
  activateDelayMs?: number;
  authFlowSourceTabId?: string;
  authFlowInitialUrl?: string;
};

type DetachedTabTransferPayload = {
  transferId: string;
  tab: Tab;
  guestInstance?: string;
  webContentsId?: number;
};

type MailtoDispatchResponse = {
  handled?: boolean;
  openedExternally?: boolean;
  url?: string;
  title?: string;
};

type TabsContextType = {
  tabs: Tab[];
  tabAudioState: Record<string, { audible: boolean; muted: boolean }>;
  syncTabAudio: (id: string) => void;
  toggleTabMuted: (id: string) => void;
  isPageLoading: boolean;
  setTabLoading: (id: string, loading: boolean) => void;
  activeId: string;
  newTab: (url?: string, options?: { activate?: boolean; activateDelayMs?: number }) => void;
  newTabToRight: (id: string, url?: string, options?: NewTabToRightOptions) => string | undefined;
  reloadTab: (id: string) => void;
  duplicateTab: (id: string) => void;
  toggleTabPinned: (id: string) => void;
  createTabGroup: (tabId: string) => Promise<void>;
  moveTabToGroup: (tabId: string, groupId?: string, side?: 'before' | 'after') => void;
  moveTabGroup: (groupId: string, targetId: string, after: boolean) => void;
  updateTabGroup: (groupId: string, patch: Partial<Pick<TabGroup, 'name' | 'color' | 'collapsed'>>) => void;
  ungroupTabs: (groupId: string) => void;
  closeTabGroup: (groupId: string) => Promise<void>;
  recentlyClosed: RecentlyClosedEntry[];
  restoreRecentlyClosed: (id: string) => void;
  openRecentlyClosed: () => void;
  reopenLastClosedTab: () => void;
  openHistory: () => void;
  openDownloads: () => void;
  openBookmarks: () => void;
  toggleBookmarksBar: () => void;
  bookmarkCurrentPage: () => void;
  bookmarkAllTabs: () => void;
  closeWindow: () => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  moveTab: (fromId: string, toId: string) => void;
  moveTabToIndex: (tabId: string, toIndex: number, options?: { isPinned?: boolean }) => void;
  moveActiveTabBy: (delta: -1 | 1) => void;
  moveTabToNewWindow: (
    id: string,
    position?: DetachedTabWindowPosition,
    options?: MoveTabToNewWindowOptions,
  ) => void;
  navigate: (url: string, tabId?: string, options?: { fromWebview?: boolean }) => void;
  navigateToNewTabPage: () => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  reloadIgnoringCache: () => void;
  clearCacheAndReload: () => void;
  stopLoading: () => void;
  searchInPage: (query: string, options?: FindInPageOptions) => void;
  findInPageNext: (forward?: boolean) => void;
  stopFindInPage: () => void;
  findInPageActiveMatchOrdinal: number;
  findInPageMatches: number;
  updateFindInPageMatches: (
    tabId: string,
    requestId: number,
    activeMatchOrdinal: number,
    matches: number,
  ) => void;
  toggleDevTools: () => void;
  updateTabMetadata: (id: string, metadata: { title?: string; favicon?: string | null }) => void;
  syncNavigationHistory: (id: string, history: string[], index: number, offset: number, metadata?: NavigationMetadata) => void;
  printPage: () => void;
  savePage: () => void;
  openFile: () => void;
  openViewSource: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  toggleFullScreen: () => void;
  scrollPage: (command: ScrollPageCommand) => void;
  registerWebview: (id: string, el: WebviewElement) => void;
  getWebContentsIdForTab: (id: string) => number | undefined;
  setActive: (id: string) => void;
  restorePromptOpen: boolean;
  restoreTabCount: number;
  restoreWindowCount: number;
  restoreTabsFromPreviousSession: () => void;
  restoreWindowsFromPreviousSession: () => void;
  discardPreviousSession: () => void;
};

const TabsContext = createContext<TabsContextType>(null!);
/**
 * Accessor hook for tab state and tab/window actions.
 */
export const useTabs = () => useContext(TabsContext);
const MAX_RECENTLY_CLOSED_TABS = 25;
const REOPEN_CLOSED_TAB_DEDUPE_WINDOW_MS = 400;
const REOPEN_CLOSED_TAB_ACTIVATE_DELAY_MS = 120;
const IPC_OPEN_TAB_ACTIVATE_DELAY_MS = 110;

/**
 * Checks whether a URL points to the configured new-tab experience.
 */
function isNewTabUrl(url: string, defaultTabUrl: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized === 'mira://newtab' || normalized === defaultTabUrl.trim().toLowerCase();
}

function isSessionEphemeralTabUrl(url: string): boolean {
  return url.trim().toLowerCase() === 'mira://newtab';
}

function filterRestorableTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((tab) => tab.isPinned || tab.group || !isSessionEphemeralTabUrl(tab.url));
}

function createInitialTab(url: string): Tab {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    url,
    title: url.startsWith('mira://') ? 'New Tab' : url,
    favicon: url.startsWith('mira://') ? INTERNAL_FAVICON_URL : undefined,
    history: [url],
    historyIndex: 0,
    reloadToken: 0,
    isSleeping: false,
    lastActiveAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMailtoNavigationUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol.toLowerCase() !== 'mailto:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function toInternalMailtoTabUrl(url: string): string | null {
  const normalizedMailtoUrl = normalizeMailtoNavigationUrl(url);
  if (!normalizedMailtoUrl) return null;
  return `mira://mailto?url=${encodeURIComponent(normalizedMailtoUrl)}`;
}

function isMailtoNavigationUrl(url: string): boolean {
  return normalizeMailtoNavigationUrl(url) !== null;
}

function normalizeTabNavigationUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function normalizeTab(value: unknown, defaultTabUrl: string): Tab | null {
  if (!isRecord(value)) return null;

  const id = typeof value.id === 'string' ? value.id : crypto.randomUUID();
  const url = normalizeTabNavigationUrl(
    typeof value.url === 'string' && value.url.trim() ? value.url : defaultTabUrl,
  );
  const title =
    typeof value.title === 'string' && value.title.trim()
      ? value.title.trim()
      : url.startsWith('mira://')
        ? 'New Tab'
        : url;
  const favicon = url.startsWith('mira://')
    ? INTERNAL_FAVICON_URL
    : typeof value.favicon === 'string' && value.favicon.trim()
      ? value.favicon.trim()
      : undefined;
  const historyRaw = Array.isArray(value.history) ? value.history : [url];
  const history = historyRaw.filter(
    (entry): entry is string => typeof entry === 'string' && !!entry.trim(),
  ).map((entry) => normalizeTabNavigationUrl(entry));
  const normalizedHistory = history.length ? history : [url];
  const historyIndexRaw =
    typeof value.historyIndex === 'number' ? value.historyIndex : normalizedHistory.length - 1;
  const historyIndex = Math.min(
    Math.max(Math.floor(historyIndexRaw), 0),
    normalizedHistory.length - 1,
  );
  const reloadToken =
    typeof value.reloadToken === 'number' && Number.isFinite(value.reloadToken)
      ? value.reloadToken
      : 0;
  const isSleeping = typeof value.isSleeping === 'boolean' ? value.isSleeping : false;
  const lastActiveAt =
    typeof value.lastActiveAt === 'number' && Number.isFinite(value.lastActiveAt)
      ? value.lastActiveAt
      : Date.now();

  return {
    id,
    url,
    title,
    favicon,
    isPinned: value.isPinned === true,
    group: value.isPinned === true ? undefined : normalizeTabGroup(value.group),
    history: normalizedHistory,
    historyIndex,
    reloadToken,
    isSleeping,
    lastActiveAt,
  };
}

function normalizeOpenUrlInNewTabRequest(
  value: unknown,
): { url: string; sourceWebContentsId?: number } | null {
  if (typeof value === 'string') {
    const normalizedUrl = normalizeTabNavigationUrl(value);
    if (!normalizedUrl || normalizedUrl.toLowerCase() === 'about:blank') return null;
    return { url: normalizedUrl };
  }

  if (!isRecord(value)) return null;

  const normalizedUrl = typeof value.url === 'string' ? normalizeTabNavigationUrl(value.url) : '';
  if (!normalizedUrl || normalizedUrl.toLowerCase() === 'about:blank') return null;

  const sourceWebContentsId =
    typeof value.sourceWebContentsId === 'number' && Number.isFinite(value.sourceWebContentsId)
      ? Math.floor(value.sourceWebContentsId)
      : undefined;

  return sourceWebContentsId && sourceWebContentsId > 0
    ? { url: normalizedUrl, sourceWebContentsId }
    : { url: normalizedUrl };
}

/**
 * Parses and validates a serialized session snapshot.
 */
function parseSnapshot(raw: string | null, defaultTabUrl: string): SessionSnapshot | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;

    const tabsRaw = Array.isArray(parsed.tabs) ? parsed.tabs : [];
    const tabs = tabsRaw
      .map((tab) => normalizeTab(tab, defaultTabUrl))
      .filter((tab): tab is Tab => tab !== null);
    const restorableTabs = filterRestorableTabs(tabs);
    if (!restorableTabs.length) return null;

    const activeIdRaw =
      typeof parsed.activeId === 'string' ? parsed.activeId : restorableTabs[0].id;
    const activeId = restorableTabs.some((tab) => tab.id === activeIdRaw)
      ? activeIdRaw
      : restorableTabs[0].id;

    return {
      tabs: restorableTabs,
      activeId,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function normalizeDetachedTabTransfer(
  value: unknown,
  defaultTabUrl: string,
): DetachedTabTransferPayload | null {
  if (!isRecord(value)) return null;

  const transferId = typeof value.transferId === 'string' ? value.transferId.trim() : '';
  if (!transferId) return null;

  const tab = normalizeTab(value.tab, defaultTabUrl);
  if (!tab) return null;

  const guestInstance =
    typeof value.guestInstance === 'string' && value.guestInstance.trim()
      ? value.guestInstance.trim()
      : undefined;
  const webContentsId =
    typeof value.webContentsId === 'number' && Number.isFinite(value.webContentsId)
      ? Math.floor(value.webContentsId)
      : undefined;

  return {
    transferId,
    tab,
    guestInstance,
    webContentsId,
  };
}

function isDefaultSnapshot(snapshot: SessionSnapshot, defaultTabUrl: string): boolean {
  return snapshot.tabs.length === 1 && !snapshot.tabs[0].isPinned && !snapshot.tabs[0].group && snapshot.tabs[0].url === defaultTabUrl;
}

/**
 * Provides tab lifecycle state and browser-like tab actions to the app tree.
 */
export default function TabsProvider({ children }: { children: React.ReactNode }) {
  const { addBookmark, deleteBookmark, bookmarks } = useBookmarks();
  const initialTabUrlRef = useRef(getBrowserSettings().newTabPage);
  const initialTabRef = useRef<Tab>(createInitialTab(initialTabUrlRef.current));
  const [tabs, setTabs] = useReducer(
    (current: Tab[], update: Tab[] | ((current: Tab[]) => Tab[])) =>
      orderGroupedTabs(orderPinnedTabs(typeof update === 'function' ? update(current) : update)),
    [initialTabRef.current],
  );
  const toggleTabPinned = useCallback((id: string) => {
    setTabs(current => current.map(tab => tab.id === id ? { ...tab, isPinned: !tab.isPinned } : tab));
  }, [setTabs]);
  const creatingGroupRef = useRef(false);
  const createTabGroup = useCallback(async (tabId: string) => {
    if (creatingGroupRef.current) return;
    creatingGroupRef.current = true;
    try {
      const name = await promptDialog({ title: 'New tab group', defaultValue: '', confirmLabel: 'Create' });
      if (name === null) return;
      const id = crypto.randomUUID();
      setTabs(current => {
        const colors = Object.keys(TAB_GROUP_COLORS) as TabGroup['color'][];
        const count = new Set(current.flatMap(tab => tab.group ? [tab.group.id] : [])).size;
        const group: TabGroup = { id, name: name.trim().slice(0, 60), color: colors[count % colors.length], collapsed: false };
        return current.map(tab => tab.id === tabId ? { ...tab, isPinned: false, group } : tab);
      });
    } finally {
      creatingGroupRef.current = false;
    }
  }, []);
  const updateTabGroup = useCallback((groupId: string, patch: Partial<Pick<TabGroup, 'name' | 'color' | 'collapsed'>>) => {
    setTabs(current => current.map(tab => tab.group?.id === groupId
      ? { ...tab, group: normalizeTabGroup({ ...tab.group, ...patch }) } : tab));
  }, []);
  const moveTabToGroup = useCallback((tabId: string, groupId?: string, side?: 'before' | 'after') => {
    setTabs(current => {
      if (!groupId) return removeTabFromGroup(current, tabId, side);
      const group = current.find(tab => tab.group?.id === groupId)?.group;
      return current.map(tab => tab.id === tabId
        ? { ...tab, isPinned: group ? false : tab.isPinned, group: group ? { ...group, collapsed: false } : undefined }
        : group && tab.group?.id === group.id ? { ...tab, group: { ...group, collapsed: false } } : tab);
    });
  }, []);
  const moveTabGroup = useCallback((groupId: string, targetId: string, after: boolean) => {
    setTabs(current => moveGroupTabs(current, groupId, targetId, after));
  }, []);
  const ungroupTabs = useCallback((groupId: string) => {
    setTabs(current => current.map(tab => tab.group?.id === groupId ? { ...tab, group: undefined } : tab));
  }, []);
  const [activeId, setActiveId] = useState(initialTabRef.current.id);
  const [tabAudioState, setTabAudioState] = useState<Record<string, { audible: boolean; muted: boolean }>>({});
  const [loadingTabIds, setLoadingTabIds] = useState<Set<string>>(() => new Set());
  const setTabLoading = useCallback((id: string, loading: boolean) => {
    setLoadingTabIds((current) => {
      if (current.has(id) === loading) return current;
      const next = new Set(current);
      if (loading) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [tabSleepAfterMs, setTabSleepAfterMs] = useState(() =>
    getTabSleepAfterMs(getBrowserSettings()),
  );
  const [restorePromptOpen, setRestorePromptOpen] = useState(false);
  const [pendingSession, setPendingSession] = useState<SessionSnapshot | null>(null);
  const [restoreTabCountState, setRestoreTabCountState] = useState(0);
  const [restoreWindowCount, setRestoreWindowCount] = useState(1);
  const [isBootstrapReady, setIsBootstrapReady] = useState(false);
  const [findInPageMatchesByTab, setFindInPageMatchesByTab] = useState<
    Record<string, FindInPageMatchState>
  >({});

  const webviewMap = useRef<Record<string, WebviewElement>>({});
  const hydratedRef = useRef(false);
  const recentIpcTabOpenRef = useRef<{ url: string; openedAt: number } | null>(null);
  const didConsumeIncomingUrlsRef = useRef(false);
  const startupIncomingUrlsRef = useRef<string[]>([]);
  const tabsRef = useRef<Tab[]>([initialTabRef.current]);
  const activeIdRef = useRef(initialTabRef.current.id);
  const lastFindQueryByTabRef = useRef<Record<string, string>>({});
  const activeFindRequestIdByTabRef = useRef<Record<string, number>>({});
  const navigateRef = useRef<
    (url: string, tabId?: string, options?: { fromWebview?: boolean }) => void
  >(() => undefined);
  const newTabRef = useRef<(url?: string) => void>(() => undefined);
  const tabSleepTimerRef = useRef<number | null>(null);
  const [recentlyClosed, setRecentlyClosed] = useState<RecentlyClosedEntry[]>([]);
  const recentlyClosedRef = useRef<RecentlyClosedEntry[]>([]);
  const closingGroupTabsRef = useRef(new Map<string, { id: string; tabs: Tab[]; activeId: string; closedAt: number }>());
  const closingGroupRef = useRef(false);
  const lastReopenClosedTabAtRef = useRef(0);
  const reopenTabActivationTimerRef = useRef<number | null>(null);
  const zoomFactorByTabRef = useRef<Record<string, number>>({});
  const bootDetachedTransferHandledRef = useRef(false);
  const activeFindInPageMatches = findInPageMatchesByTab[activeId] ?? {
    activeMatchOrdinal: 0,
    matches: 0,
  };
  const applyRestoredSnapshot = useCallback(
    (snapshot: SessionSnapshot) => {
      if (!snapshot.tabs.length) return;

      const now = Date.now();
      const restoredTabs = snapshot.tabs.map((tab) => ({
        ...tab,
        restoreDeferred: tab.id !== snapshot.activeId,
        // A new window has no live frozen document to resume from the old session.
        isSleeping: false,
        frozenState: undefined,
        ...(tab.id === snapshot.activeId ? { lastActiveAt: now } : {}),
      }));

      setTabs(restoredTabs);
      setActiveId(snapshot.activeId);

      setPendingSession(null);
      setRestoreTabCountState(0);
      setRestorePromptOpen(false);
      setRestoreWindowCount(1);
    },
    [],
  );

  const clearFindInPageMatchesForTab = useCallback((tabId: string) => {
    setFindInPageMatchesByTab((current) => {
      if (!(tabId in current)) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }, []);

  const applyDetachedTransfer = useCallback((payload: unknown) => {
    if (bootDetachedTransferHandledRef.current) return true;
    const detachedTransfer = normalizeDetachedTabTransfer(
      payload,
      getBrowserSettings().newTabPage,
    );
    if (!detachedTransfer) return false;

    bootDetachedTransferHandledRef.current = true;
    const now = Date.now();
    const transferredTab: Tab = {
      ...detachedTransfer.tab,
      isSleeping: false,
      lastActiveAt: now,
      transferredGuestInstance: detachedTransfer.guestInstance,
      detachedTransferId: detachedTransfer.transferId,
      transferredWebContentsId: detachedTransfer.webContentsId,
    };
    startupIncomingUrlsRef.current = [];
    setTabs([transferredTab]);
    setActiveId(transferredTab.id);

    if (!detachedTransfer.guestInstance) {
      const ipc = electron?.ipcRenderer;
      if (ipc) {
        window.requestAnimationFrame(() => {
          void ipc
            .invoke('detached-tab-transfer-complete', detachedTransfer.transferId)
            .catch(() => undefined);
        });
      }
    }

    return true;
  }, []);

  const updateFindInPageMatches = useCallback(
    (tabId: string, requestId: number, activeMatchOrdinal: number, matches: number) => {
      const activeRequestId = activeFindRequestIdByTabRef.current[tabId];
      if (typeof activeRequestId === 'number' && requestId !== activeRequestId) {
        return;
      }

      const nextActiveMatchOrdinal =
        Number.isFinite(activeMatchOrdinal) && activeMatchOrdinal > 0
          ? Math.floor(activeMatchOrdinal)
          : 0;
      const nextMatches = Number.isFinite(matches) && matches > 0 ? Math.floor(matches) : 0;

      setFindInPageMatchesByTab((current) => {
        const existing = current[tabId];
        if (
          existing &&
          existing.activeMatchOrdinal === nextActiveMatchOrdinal &&
          existing.matches === nextMatches
        ) {
          return current;
        }
        return {
          ...current,
          [tabId]: {
            activeMatchOrdinal: nextActiveMatchOrdinal,
            matches: nextMatches,
          },
        };
      });
    },
    [],
  );

  const persistSession = (nextTabs: Tab[], nextActiveId: string) => {
    if (electron?.isPrivate) return;
    const restorableTabs = filterRestorableTabs(nextTabs);
    const hasExplicitActiveId = restorableTabs.some((tab) => tab.id === nextActiveId);
    const fallbackActiveId =
      restorableTabs.length > 0
        ? restorableTabs.reduce(
            (candidate, tab) => (tab.lastActiveAt > candidate.lastActiveAt ? tab : candidate),
            restorableTabs[0],
          ).id
        : undefined;
    const safeActiveId = hasExplicitActiveId ? nextActiveId : fallbackActiveId;

    if (!restorableTabs.length || !safeActiveId) {
      if (electron?.ipcRenderer) {
        electron.ipcRenderer.invoke('session-save-window', null).catch(() => undefined);
        return;
      }
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // Ignore storage failures (quota/private mode).
      }
      return;
    }

    const snapshot: SessionSnapshot = {
      tabs: restorableTabs,
      activeId: safeActiveId,
      savedAt: Date.now(),
    };

    if (electron?.ipcRenderer) {
      electron.ipcRenderer.invoke('session-save-window', snapshot).catch(() => undefined);
      return;
    }

    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Ignore storage failures (quota/private mode).
    }
  };

  useEffect(() => {
    const syncTabSleepTimeout = () => {
      setTabSleepAfterMs(getTabSleepAfterMs(getBrowserSettings()));
    };

    syncTabSleepTimeout();
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncTabSleepTimeout);
    return () => window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncTabSleepTimeout);
  }, []);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onDetachedTabBootstrap = (_event: unknown, payload: unknown) => {
      applyDetachedTransfer(payload);
    };

    ipc.on('window-detached-tab-bootstrap', onDetachedTabBootstrap);
    return () => ipc.off('window-detached-tab-bootstrap', onDetachedTabBootstrap);
  }, [applyDetachedTransfer]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) {
      startupIncomingUrlsRef.current = [];
      const settings = getBrowserSettings();
      const restoreBehavior: StartupRestoreBehavior = settings.startupRestoreBehavior;
      const currentDefaultTabUrl = getBrowserSettings().newTabPage;
      const snapshot = parseSnapshot(
        localStorage.getItem(SESSION_STORAGE_KEY),
        currentDefaultTabUrl,
      );
      if (snapshot && !isDefaultSnapshot(snapshot, currentDefaultTabUrl)) {
        if (restoreBehavior === 'ask') {
          setPendingSession(snapshot);
          setRestoreTabCountState(snapshot.tabs.length);
          setRestorePromptOpen(true);
        } else if (restoreBehavior === 'fresh') {
          localStorage.removeItem(SESSION_STORAGE_KEY);
        } else {
          applyRestoredSnapshot(snapshot);
        }
      }
      hydratedRef.current = true;
      setIsBootstrapReady(true);
      return;
    }

    let cancelled = false;
    const bootstrapSessionRestore = async () => {
      try {
        if (electron?.isPrivate) {
          hydratedRef.current = true;
          setIsBootstrapReady(true);
          return;
        }
        const [queuedUrlsRaw, initialWindowUrlRaw] = await Promise.all([
          ipc
            .invoke<string[]>('incoming-urls-consume')
            .then((urls) =>
              Array.isArray(urls)
                ? urls
                    .filter((candidate): candidate is string => typeof candidate === 'string')
                    .map((candidate) => candidate.trim())
                    .filter(Boolean)
                : [],
            )
            .catch(() => []),
          ipc
            .invoke<string>('window-consume-initial-url')
            .then((url) => (typeof url === 'string' ? url.trim() : ''))
            .catch(() => ''),
        ]);
        if (cancelled || bootDetachedTransferHandledRef.current) return;

        const queuedUrls = initialWindowUrlRaw
          ? [initialWindowUrlRaw, ...queuedUrlsRaw]
          : queuedUrlsRaw;
        startupIncomingUrlsRef.current = queuedUrls;

        const windowRestore = await ipc.invoke<SessionSnapshot | null>(
          'session-take-window-restore',
        );
        if (cancelled || bootDetachedTransferHandledRef.current) return;

        if (windowRestore && windowRestore.tabs.length > 0) {
          applyRestoredSnapshot(windowRestore);
          return;
        }

        const restoreState = await ipc.invoke<SessionRestoreState>('session-get-restore-state');
        if (cancelled || bootDetachedTransferHandledRef.current) return;

        if (restoreState?.hasPendingRestore && startupIncomingUrlsRef.current.length === 0) {
          const restoreBehavior: StartupRestoreBehavior =
            getBrowserSettings().startupRestoreBehavior;
          if (restoreBehavior === 'ask') {
            setRestorePromptOpen(true);
            setRestoreTabCountState(Math.max(restoreState.tabCount || 0, 0));
            setRestoreWindowCount(Math.max(restoreState.windowCount || 1, 1));
          } else if (restoreBehavior === 'fresh') {
            await ipc.invoke('session-discard-restore').catch(() => undefined);
          } else {
            const mode: SessionRestoreMode = restoreBehavior === 'windows' ? 'windows' : 'tabs';
            const snapshot = await ipc
              .invoke<SessionSnapshot | null>('session-accept-restore', mode)
              .catch(() => null);
            if (cancelled || !snapshot) return;
            applyRestoredSnapshot(snapshot);
          }
        }
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          setIsBootstrapReady(true);
        }
      }
    };

    void bootstrapSessionRestore();
    return () => {
      cancelled = true;
    };
  }, [applyRestoredSnapshot]);

  const restorePreviousSession = (mode: SessionRestoreMode) => {
    const applyManualRestoreSnapshot = (snapshot: SessionSnapshot) => {
      applyRestoredSnapshot(snapshot);
      persistSession(snapshot.tabs, snapshot.activeId);
    };

    const ipc = electron?.ipcRenderer;
    if (ipc) {
      ipc
        .invoke<SessionSnapshot | null>('session-accept-restore', mode)
        .then((snapshot) => {
          if (!snapshot || !snapshot.tabs.length) {
            setRestorePromptOpen(false);
            return;
          }

          applyManualRestoreSnapshot(snapshot);
        })
        .catch(() => {
          setRestorePromptOpen(false);
        });
      return;
    }

    if (!pendingSession) {
      setRestorePromptOpen(false);
      return;
    }

    applyManualRestoreSnapshot(pendingSession);
  };

  const restoreTabsFromPreviousSession = () => {
    restorePreviousSession('tabs');
  };

  const restoreWindowsFromPreviousSession = () => {
    restorePreviousSession('windows');
  };

  const discardPreviousSession = () => {
    const ipc = electron?.ipcRenderer;
    if (ipc) {
      ipc.invoke('session-discard-restore').catch(() => undefined);
    }
    setRestorePromptOpen(false);
    setPendingSession(null);
    setRestoreTabCountState(0);
    setRestoreWindowCount(1);
    if (!ipc) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
    persistSession(tabs, activeId);
  };

  const registerWebview = (id: string, el: WebviewElement) => {
    if (el) {
      webviewMap.current[id] = el;
    } else {
      delete webviewMap.current[id];
      setTabLoading(id, false);
      setTabAudioState(current => {
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const findTabIdForWebContentsId = useCallback((webContentsId: number): string | undefined => {
    if (!Number.isFinite(webContentsId) || webContentsId <= 0) return undefined;

    for (const [tabId, webview] of Object.entries(webviewMap.current)) {
      if (!webview || typeof webview.getWebContentsId !== 'function') continue;
      try {
        if (webview.getWebContentsId() === webContentsId) {
          return tabId;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }, []);

  const updateTabAudio = useCallback((id: string, audible: boolean, muted: boolean) => {
    setTabAudioState(current => current[id]?.audible === audible && current[id]?.muted === muted
      ? current : { ...current, [id]: { audible, muted } });
  }, []);

  const syncTabAudio = useCallback((id: string) => {
    const webview = webviewMap.current[id];
    if (!webview) return;
    try { updateTabAudio(id, webview.isCurrentlyAudible?.() ?? false, webview.isAudioMuted?.() ?? false); }
    catch { /* The guest may still be attaching or closing. */ }
  }, [updateTabAudio]);

  const toggleTabMuted = useCallback((id: string) => {
    const webview = webviewMap.current[id];
    if (!webview?.setAudioMuted || !webview.isAudioMuted) return;
    try {
      webview.setAudioMuted(!webview.isAudioMuted());
      syncTabAudio(id);
    } catch { /* A closing guest has no audio to control. */ }
  }, [syncTabAudio]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    const onAudioChanged = (_event: unknown, payload: { webContentsId: number; audible: boolean; muted: boolean }) => {
      const id = findTabIdForWebContentsId(payload.webContentsId);
      if (id) updateTabAudio(id, payload.audible === true, payload.muted === true);
    };
    ipc.on('tab-audio-changed', onAudioChanged);
    return () => ipc.off('tab-audio-changed', onAudioChanged);
  }, [findTabIdForWebContentsId, updateTabAudio]);

  const getWebContentsIdForTab = useCallback((id: string): number | undefined => {
    if (!id) return undefined;

    const webview = webviewMap.current[id];
    if (!webview || typeof webview.getWebContentsId !== 'function') return undefined;

    try {
      const candidate = webview.getWebContentsId();
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return Math.floor(candidate);
      }
    } catch {
      return undefined;
    }

    return undefined;
  }, []);

  const miraUrlToName = useCallback((url?: string) => {
    if (!url?.startsWith('mira://')) {
      throw new Error(`Invalid mira url: '${url}'`);
    }
    const sanitized = url.slice(7);
    const route = sanitized.split(/[?#]/, 1)[0];
    switch (route.toLowerCase()) {
      case 'newtab':
        return 'New Tab';
      case 'recently-closed':
        return 'Recently Closed';
      case 'mailto':
        return 'Compose Email';
      case 'themecreator':
        return 'Theme Creator';
      default:
        // return a capitalized version of the url
        return route.charAt(0).toUpperCase() + route.slice(1);
    }
  }, []);

  const resolveMailtoTabTarget = useCallback(
    async (
      url: string,
      options?: { allowExternalFallback?: boolean },
    ): Promise<{ url: string; title?: string } | null> => {
      const normalizedMailtoUrl = normalizeMailtoNavigationUrl(url);
      if (!normalizedMailtoUrl) return null;

      const fallbackUrl = toInternalMailtoTabUrl(normalizedMailtoUrl);
      const ipc = electron?.ipcRenderer;
      if (!ipc) {
        return fallbackUrl ? { url: fallbackUrl, title: 'Compose Email' } : null;
      }

      try {
        const response = await ipc.invoke<MailtoDispatchResponse>('mailto-dispatch', {
          url: normalizedMailtoUrl,
          allowExternalFallback: options?.allowExternalFallback !== false,
        });
        const resolvedUrl =
          typeof response?.url === 'string' ? normalizeTabNavigationUrl(response.url) : '';
        if (resolvedUrl) {
          return {
            url: resolvedUrl,
            title:
              typeof response?.title === 'string' && response.title.trim()
                ? response.title.trim()
                : undefined,
          };
        }
        if (response?.openedExternally) return null;
      } catch {
        // Fall back to the internal compose page below.
      }

      return fallbackUrl ? { url: fallbackUrl, title: 'Compose Email' } : null;
    },
    [],
  );

  const applyResolvedNavigation = useCallback(
    (targetTabId: string, targetUrl: string, explicitTitle?: string) => {
      const normalized = normalizeTabNavigationUrl(targetUrl);
      if (!normalized) return;

      if (!normalized.startsWith('mira://')) {
        addHistoryEntry(normalized, normalized).catch(() => undefined);
      }

      setTabs((t) =>
        t.map((tab) => {
          if (tab.id !== targetTabId) return tab;

          const currentUrl = tab.history[tab.historyIndex];
          if (currentUrl === normalized) {
            return tab;
          }

          const newHistory = tab.history.slice(0, tab.historyIndex + 1).concat(normalized);
          const defaultTitle =
            explicitTitle?.trim()
            || (normalized.startsWith('mira://') ? miraUrlToName(normalized) : normalized);
          return {
            ...tab,
            url: normalized,
            title: defaultTitle,
            favicon: normalized.startsWith('mira://') ? INTERNAL_FAVICON_URL : getNavigationMetadata(tab, normalized).favicon,
            history: newHistory,
            historyIndex: newHistory.length - 1,
            reloadToken: tab.reloadToken,
          };
        }),
      );
    },
    [miraUrlToName],
  );

  const openResolvedNewTab = useCallback(
    (
      targetUrl: string,
      options?: { activate?: boolean; activateDelayMs?: number },
      explicitTitle?: string,
    ) => {
      const shouldActivate = options?.activate !== false;
      const activateDelayMsRaw = options?.activateDelayMs;
      const activateDelayMs =
        typeof activateDelayMsRaw === 'number' && Number.isFinite(activateDelayMsRaw)
          ? Math.max(0, Math.floor(activateDelayMsRaw))
          : 0;
      const normalizedTargetUrl = normalizeTabNavigationUrl(targetUrl);
      if (!normalizedTargetUrl) return;

      const now = Date.now();
      const newEntry: Tab = {
        id: crypto.randomUUID(),
        url: normalizedTargetUrl,
        title:
          explicitTitle?.trim()
          || (normalizedTargetUrl.startsWith('mira://')
            ? miraUrlToName(normalizedTargetUrl)
            : normalizedTargetUrl),
        favicon: normalizedTargetUrl.startsWith('mira://') ? INTERNAL_FAVICON_URL : undefined,
        history: [normalizedTargetUrl],
        historyIndex: 0,
        reloadToken: 0,
        isSleeping: false,
        lastActiveAt: now,
      };
      setTabs((t) =>
        t
          .map((tab) => (tab.id === activeId ? { ...tab, lastActiveAt: now } : tab))
          .concat(newEntry),
      );
      if (shouldActivate) {
        if (activateDelayMs > 0) {
          window.setTimeout(() => {
            setActiveId(newEntry.id);
          }, activateDelayMs);
        } else {
          setActiveId(newEntry.id);
        }
      }
    },
    [activeId, miraUrlToName],
  );

  const openResolvedNewTabToRight = useCallback(
    (
      id: string,
      targetUrl: string,
      options?: NewTabToRightOptions,
      explicitTitle?: string,
    ) => {
      if (!id) return;

      const shouldActivate = options?.activate !== false;
      const activateDelayMsRaw = options?.activateDelayMs;
      const activateDelayMs =
        typeof activateDelayMsRaw === 'number' && Number.isFinite(activateDelayMsRaw)
          ? Math.max(0, Math.floor(activateDelayMsRaw))
          : 0;
      const normalizedTargetUrl = normalizeTabNavigationUrl(targetUrl);
      if (!normalizedTargetUrl) return;

      const authFlowSourceTabId =
        typeof options?.authFlowSourceTabId === 'string' && options.authFlowSourceTabId.trim()
          ? options.authFlowSourceTabId.trim()
          : undefined;
      const authFlowInitialUrl =
        authFlowSourceTabId
          ? typeof options?.authFlowInitialUrl === 'string' && options.authFlowInitialUrl.trim()
            ? options.authFlowInitialUrl.trim()
            : normalizedTargetUrl
          : undefined;
      const now = Date.now();
      const sourceGroup = tabsRef.current.find(tab => tab.id === id)?.group;
      const newEntry: Tab = {
        id: crypto.randomUUID(),
        url: normalizedTargetUrl,
        title:
          explicitTitle?.trim()
          || (normalizedTargetUrl.startsWith('mira://')
            ? miraUrlToName(normalizedTargetUrl)
            : normalizedTargetUrl),
        favicon: normalizedTargetUrl.startsWith('mira://') ? INTERNAL_FAVICON_URL : undefined,
        group: sourceGroup ? { ...sourceGroup, collapsed: false } : undefined,
        history: [normalizedTargetUrl],
        historyIndex: 0,
        reloadToken: 0,
        isSleeping: false,
        lastActiveAt: now,
        authFlowSourceTabId,
        authFlowInitialUrl,
      };

      setTabs((currentTabs) => {
        const sourceIndex = currentTabs.findIndex((tab) => tab.id === id);
        if (sourceIndex === -1) return currentTabs;

        const nextTabs = currentTabs.map((tab) =>
          tab.id === activeId ? { ...tab, lastActiveAt: now, ...(newEntry.group && tab.group?.id === newEntry.group.id ? { group: newEntry.group } : {}) }
            : newEntry.group && tab.group?.id === newEntry.group.id ? { ...tab, group: newEntry.group } : tab,
        );
        nextTabs.splice(sourceIndex + 1, 0, newEntry);
        return nextTabs;
      });

      if (shouldActivate) {
        if (activateDelayMs > 0) {
          window.setTimeout(() => {
            setActiveId(newEntry.id);
          }, activateDelayMs);
        } else {
          setActiveId(newEntry.id);
        }
      }
      return newEntry.id;
    },
    [activeId, miraUrlToName],
  );

  const newTab = useCallback(
    (url?: string, options?: { activate?: boolean; activateDelayMs?: number }) => {
      const defaultNewTabUrl = getBrowserSettings().newTabPage;
      const requestedUrl =
        typeof url === 'string' && url.trim() ? url.trim() : defaultNewTabUrl;
      if (isMailtoNavigationUrl(requestedUrl)) {
        void resolveMailtoTabTarget(requestedUrl).then((resolved) => {
          if (!resolved) return;
          openResolvedNewTab(resolved.url, options, resolved.title);
        });
        return;
      }

      openResolvedNewTab(requestedUrl, options);
    },
    [openResolvedNewTab, resolveMailtoTabTarget],
  );

  const newTabToRight = useCallback(
    (id: string, url?: string, options?: NewTabToRightOptions) => {
      if (!id) return;

      const defaultNewTabUrl = getBrowserSettings().newTabPage;
      const requestedUrl =
        typeof url === 'string' && url.trim() ? url.trim() : defaultNewTabUrl;
      if (isMailtoNavigationUrl(requestedUrl)) {
        void resolveMailtoTabTarget(requestedUrl).then((resolved) => {
          if (!resolved) return;
          openResolvedNewTabToRight(id, resolved.url, options, resolved.title);
        });
        return undefined;
      }

      return openResolvedNewTabToRight(id, requestedUrl, options);
    },
    [openResolvedNewTabToRight, resolveMailtoTabTarget],
  );

  const duplicateTab = useCallback(
    (id: string) => {
      if (!id) return;
      const tabToDuplicate = tabsRef.current.find((tab) => tab.id === id);
      if (!tabToDuplicate) return;

      const sourceUrl = tabToDuplicate.history[tabToDuplicate.historyIndex] ?? tabToDuplicate.url;
      newTabToRight(id, sourceUrl);
    },
    [newTabToRight],
  );

  const openRecentlyClosed = () => {
    const existing = tabs.find(tab => tab.url === 'mira://recently-closed');
    if (existing) setActive(existing.id);
    else newTab('mira://recently-closed');
  };

  const openHistory = () => {
    const activeTab = tabs.find((t) => t.id === activeId);
    const newTabUrl = getBrowserSettings().newTabPage;
    const isNewTab = !!activeTab && isNewTabUrl(activeTab.url, newTabUrl);

    if (isNewTab && activeTab) {
      navigate('mira://history', activeTab.id); // reuse current tab
    } else {
      newTab('mira://history'); // open separate tab
    }
  };

  const openDownloads = () => {
    const existingDownloadsTab = tabs.find(
      (tab) => tab.url.trim().toLowerCase() === 'mira://downloads',
    );
    if (existingDownloadsTab) {
      setActive(existingDownloadsTab.id);
      return;
    }

    const activeTab = tabs.find((tab) => tab.id === activeId);
    const newTabUrl = getBrowserSettings().newTabPage;
    const isNewTab = !!activeTab && isNewTabUrl(activeTab.url, newTabUrl);
    if (isNewTab && activeTab) {
      navigate('mira://downloads', activeTab.id);
      return;
    }

    newTab('mira://downloads');
  };

  const openBookmarks = () => {
    const existingBookmarksTab = tabs.find(
      (tab) => tab.url.trim().toLowerCase() === 'mira://bookmarks',
    );
    if (existingBookmarksTab) {
      setActive(existingBookmarksTab.id);
      return;
    }

    const activeTab = tabs.find((tab) => tab.id === activeId);
    const newTabUrl = getBrowserSettings().newTabPage;
    const isNewTab = !!activeTab && isNewTabUrl(activeTab.url, newTabUrl);
    if (isNewTab && activeTab) {
      navigate('mira://bookmarks', activeTab.id);
      return;
    }

    newTab('mira://bookmarks');
  };

  const toggleBookmarksBar = () => {
    const currentSettings = getBrowserSettings();
    const newSettings = {
      ...currentSettings,
      showBookmarksBar: !currentSettings.showBookmarksBar,
    };
    saveBrowserSettings(newSettings);
  };

  // Helper functions for bookmark operations - now using BookmarksProvider context
  const bookmarkCurrentPage = () => {
    const activeTab = tabs.find(tab => tab.id === activeId);
    if (!activeTab || !activeTab.url) {
      return;
    }
    
    // Don't allow bookmarking error pages
    if (activeTab.url.startsWith('mira://errors/')) {
      return;
    }
    
    // Check if already bookmarked using the context's bookmarks
    const isBookmarked = bookmarks.some((bookmark) => 
      bookmark.type === 'bookmark' && bookmark.url === activeTab.url
    );
    
    if (isBookmarked) {
      // Remove bookmark
      const existingBookmark = bookmarks.find((bookmark) => 
        bookmark.type === 'bookmark' && bookmark.url === activeTab.url
      );
      if (existingBookmark) {
        deleteBookmark(existingBookmark.id);
      }
    } else {
      // Add bookmark using context method
      addBookmark({
        title: activeTab.title || activeTab.url,
        type: 'bookmark',
        url: activeTab.url,
      });
    }
  };

  const bookmarkAllTabs = () => {
    tabs.forEach(tab => {
      if (tab.url && !tab.url.startsWith('mira://errors/')) {
        // Check if already bookmarked
        const isBookmarked = bookmarks.some((bookmark) => 
          bookmark.type === 'bookmark' && bookmark.url === tab.url
        );
        
        if (!isBookmarked) {
          addBookmark({
            title: tab.title || tab.url,
            type: 'bookmark',
            url: tab.url,
          });
        }
      }
    });
  };

  const closeWindow = useCallback(async () => {
    if (electron?.ipcRenderer) {
      return electron.ipcRenderer.invoke<boolean>('window-close').catch(() => false);
    }
    window.close();
    return true;
  }, []);

  const clearTabRuntimeState = useCallback(
    (id: string) => {
      delete lastFindQueryByTabRef.current[id];
      delete activeFindRequestIdByTabRef.current[id];
      delete zoomFactorByTabRef.current[id];
      clearFindInPageMatchesForTab(id);

      // Clean up frozen state when tab is closed
      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.id === id ? { ...tab, frozenState: undefined } : tab
        )
      );
    },
    [clearFindInPageMatchesForTab],
  );

  const rememberRecentlyClosedTabs = useCallback((tabsToRemember: Tab[]) => {
    let entries = recentlyClosedRef.current;
    for (const tab of tabsToRemember) {
      const batch = closingGroupTabsRef.current.get(tab.id);
      if (!electron?.isPrivate) entries = addClosedTab(entries, tab, batch, MAX_RECENTLY_CLOSED_TABS);
      closingGroupTabsRef.current.delete(tab.id);
    }
    recentlyClosedRef.current = entries;
    setRecentlyClosed(entries);
  }, []);

  const finalizeTabClose = useCallback((id: string) => {
    const currentTabs = tabsRef.current;
    if (!currentTabs.some(tab => tab.id === id)) return;
    const currentActiveId = activeIdRef.current;
    const shouldCloseWindow = currentTabs.length === 1 && currentTabs[0]?.id === id;
    if (shouldCloseWindow && !closingGroupTabsRef.current.has(id)) {
      closeWindow();
      return;
    }

    const tabToClose = currentTabs.find((tab) => tab.id === id);
    if (tabToClose) {
      rememberRecentlyClosedTabs([tabToClose]);
    }
    clearTabRuntimeState(id);

    setTabs((existingTabs) => {
      const next = existingTabs.filter((tab) => tab.id !== id);
      if (!next.length) next.push(createInitialTab(getBrowserSettings().newTabPage));
      if (id !== currentActiveId || !next.length) return next;

      const closingIndex = existingTabs.findIndex((tab) => tab.id === id);
      const nextIndex =
        closingIndex >= 0 ? Math.min(closingIndex, next.length - 1) : next.length - 1;
      const nextActive = next[nextIndex];
      if (!nextActive) return next;
      const nextActiveId = nextActive.id;
      const now = Date.now();
      setActiveId(nextActiveId);
      return next.map((tab) =>
        tab.id === nextActiveId ? { ...tab, isSleeping: false, lastActiveAt: now } : tab,
      );
    });
  }, [clearTabRuntimeState, closeWindow, rememberRecentlyClosedTabs]);

  const closeTab = useCallback(async (id: string): Promise<boolean> => {
    const currentTabs = tabsRef.current;
    if (currentTabs.length === 1 && currentTabs[0]?.id === id && !closingGroupTabsRef.current.has(id)) return closeWindow();
    const tabToClose = currentTabs.find((tab) => tab.id === id);
    if (!tabToClose) return true;
    const webContentsId = getWebContentsIdForTab(id);
    if (!tabToClose.url.startsWith('mira://') && webContentsId !== undefined && electron?.ipcRenderer) {
      return electron.ipcRenderer.invoke<boolean>('webview-request-close-tab', {
        tabId: id, webContentsId,
      }).catch(() => false);
    }
    finalizeTabClose(id);
    return true;
  }, [closeWindow, finalizeTabClose, getWebContentsIdForTab]);

  const closeOtherTabs = useCallback(async (id: string) => {
    if (!tabsRef.current.some((tab) => tab.id === id)) return;
    for (const tab of tabsRef.current.filter((tab) => tab.id !== id && !tab.isPinned)) {
      if (!await closeTab(tab.id)) break;
    }
  }, [closeTab]);

  const closeTabsToRight = useCallback(async (id: string) => {
    const index = tabsRef.current.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    for (const tab of tabsRef.current.slice(index + 1).filter(tab => !tab.isPinned)) {
      if (!await closeTab(tab.id)) break;
    }
  }, [closeTab]);

  const closeTabGroup = useCallback(async (groupId: string) => {
    if (closingGroupRef.current) return;
    const members = tabsRef.current.filter(tab => tab.group?.id === groupId);
    if (!members.length) return;
    closingGroupRef.current = true;
    const batch = { id: crypto.randomUUID(), tabs: members, activeId: activeIdRef.current, closedAt: Date.now() };
    for (const tab of members) closingGroupTabsRef.current.set(tab.id, batch);
    const accepted = new Set<string>();
    try {
      for (const tab of members) {
        if (!await closeTab(tab.id)) break;
        accepted.add(tab.id);
      }
    } finally {
      for (const tab of members) {
        if (!accepted.has(tab.id)) closingGroupTabsRef.current.delete(tab.id);
      }
      closingGroupRef.current = false;
    }
  }, [closeTab]);

  const restoreRecentlyClosed = useCallback((id: string) => {
    const entry = recentlyClosedRef.current.find(item => item.id === id);
    if (!entry) return;
    const restored = restoreClosedEntry(entry);
    const entries = recentlyClosedRef.current.filter(item => item.id !== id);
    recentlyClosedRef.current = entries;
    setRecentlyClosed(entries);
    setTabs(current => current.concat(restored.tabs));
    if (reopenTabActivationTimerRef.current !== null) window.clearTimeout(reopenTabActivationTimerRef.current);
    reopenTabActivationTimerRef.current = window.setTimeout(() => {
      reopenTabActivationTimerRef.current = null;
      if (tabsRef.current.some(tab => tab.id === restored.activeId)) setActiveId(restored.activeId);
    }, REOPEN_CLOSED_TAB_ACTIVATE_DELAY_MS);
  }, []);

  const reopenLastClosedTab = useCallback(() => {
    const now = Date.now();
    if (now - lastReopenClosedTabAtRef.current < REOPEN_CLOSED_TAB_DEDUPE_WINDOW_MS) return;
    lastReopenClosedTabAtRef.current = now;
    const entry = recentlyClosedRef.current.at(-1);
    if (entry) restoreRecentlyClosed(entry.id);
  }, [restoreRecentlyClosed]);

  const moveTab = useCallback((fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;

    setTabs((currentTabs) => {
      const fromIndex = currentTabs.findIndex((tab) => tab.id === fromId);
      const toIndex = currentTabs.findIndex((tab) => tab.id === toId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
        return currentTabs;
      }

      const nextTabs = [...currentTabs];
      const [moved] = nextTabs.splice(fromIndex, 1);
      nextTabs.splice(toIndex, 0, moved);
      return nextTabs;
    });
  }, []);

  const moveTabToIndex = useCallback((tabId: string, toIndex: number, options?: { isPinned?: boolean }) => {
    setTabs(current => {
      const source = current.find(tab => tab.id === tabId);
      const target = current[Math.max(0, Math.min(Math.floor(toIndex), current.length - 1))];
      const moved = moveTabInGroup(current, tabId, toIndex, options);
      if (!source || !target || options?.isPinned !== undefined || source.isPinned || target.isPinned
        || source.group?.id === target.group?.id) return moved;
      return moved.map(tab => tab.id === tabId ? { ...tab, group: target.group ? { ...target.group, collapsed: false } : undefined }
        : target.group && tab.group?.id === target.group.id ? { ...tab, group: { ...target.group, collapsed: false } } : tab);
    });
  }, []);

  const moveActiveTabBy = useCallback(
    (delta: -1 | 1) => {
      if (!tabs.length || !activeId) return;
      const currentIndex = tabs.findIndex((tab) => tab.id === activeId);
      if (currentIndex < 0) return;
      const targetIndex = Math.max(0, Math.min(currentIndex + delta, tabs.length - 1));
      if (targetIndex === currentIndex) return;
      moveTabToIndex(activeId, targetIndex);
    },
    [tabs, activeId, moveTabToIndex],
  );

  const finalizeDetachedTabMove = useCallback(
    (id: string) => {
      if (!id) return;
      clearTabRuntimeState(id);

      setTabs((currentTabs) => {
        const nextTabs = currentTabs.filter((tab) => tab.id !== id);
        if (nextTabs.length === currentTabs.length) {
          return currentTabs;
        }

        if (!nextTabs.length) {
          const replacement = createInitialTab(getBrowserSettings().newTabPage);
          setActiveId(replacement.id);
          return [replacement];
        }

        if (id !== activeIdRef.current) {
          return nextTabs;
        }

        const now = Date.now();
        const nextActiveId = nextTabs[0].id;
        setActiveId(nextActiveId);
        return nextTabs.map((tab) =>
          tab.id === nextActiveId ? { ...tab, isSleeping: false, lastActiveAt: now } : tab,
        );
      });
    },
    [clearTabRuntimeState],
  );

  const moveTabToNewWindow = useCallback(
    (id: string, position?: DetachedTabWindowPosition, options?: MoveTabToNewWindowOptions) => {
      const tabToMove = tabsRef.current.find((tab) => tab.id === id);
      if (!tabToMove) return;

      const url = tabToMove.url.trim();
      const ipc = electron?.ipcRenderer;
      if (ipc) {
        const webview = webviewMap.current[id];
        const guestInstanceFromProperty =
          typeof webview?.guestinstance === 'string' ? webview.guestinstance.trim() : '';
        const guestInstanceFromAttribute =
          typeof webview?.getAttribute === 'function'
            ? (webview.getAttribute('guestinstance') ?? '').trim()
            : '';
        const guestInstance = guestInstanceFromProperty || guestInstanceFromAttribute || undefined;
        let webContentsId: number | undefined;
        if (typeof webview?.getWebContentsId === 'function') {
          try {
            const candidate = webview.getWebContentsId();
            if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
              webContentsId = Math.floor(candidate);
            }
          } catch {
            webContentsId = undefined;
          }
        }
        const payload = {
          tab: {
            id: tabToMove.id,
            url: tabToMove.url,
            title: tabToMove.title,
            favicon: tabToMove.favicon,
            isPinned: tabToMove.isPinned,
            group: tabToMove.group,
            history: [...tabToMove.history],
            historyIndex: tabToMove.historyIndex,
            reloadToken: tabToMove.reloadToken,
            isSleeping: false,
            lastActiveAt: Date.now(),
          },
          guestInstance,
          webContentsId,
          dragMode: options?.dragMode === true,
          pointerOffsetX: options?.pointerOffsetX,
          pointerOffsetY: options?.pointerOffsetY,
          position,
        };

        void ipc
          .invoke<{ transferId?: unknown } | null>('window-detach-tab-to-new-window', payload)
          .then((result) => {
            const transferId =
              result && typeof result.transferId === 'string' ? result.transferId.trim() : '';
            if (transferId) {
              return;
            }
            void ipc.invoke('window-new-with-url', url).catch(() => undefined);
            finalizeDetachedTabMove(id);
          })
          .catch(() => {
            void ipc.invoke('window-new-with-url', url).catch(() => undefined);
            finalizeDetachedTabMove(id);
          });
        return;
      }

      window.open(url || window.location.href, '_blank', 'noopener,noreferrer');
      finalizeDetachedTabMove(id);
    },
    [finalizeDetachedTabMove],
  );

  const setActive = useCallback(
    (id: string) => {
      const now = Date.now();
      setTabs((currentTabs) => {
        const groupId = currentTabs.find(tab => tab.id === id)?.group?.id;
        let changed = false;
        const nextTabs = currentTabs.map((original) => {
          const tab = groupId && original.group?.id === groupId && original.group.collapsed
            ? { ...original, group: { ...original.group, collapsed: false } } : original;
          if (tab !== original) changed = true;
          if (tab.id === activeId || tab.id === id) {
            const nextLastActiveAt = now;
            const nextIsSleeping = tab.id === id ? false : tab.isSleeping;
            if (tab.lastActiveAt !== nextLastActiveAt || tab.isSleeping !== nextIsSleeping) {
              changed = true;
              return {
                ...tab,
                lastActiveAt: nextLastActiveAt,
                isSleeping: nextIsSleeping,
              };
            }
          }
          return tab;
        });
        return changed ? nextTabs : currentTabs;
      });
      setActiveId(id);
    },
    [activeId],
  );

  useEffect(() => {
    setTabs((currentTabs) => {
      if (!currentTabs.some((tab) => tab.id === activeId && tab.restoreDeferred)) return currentTabs;
      return currentTabs.map((tab) => tab.id === activeId ? { ...tab, restoreDeferred: false } : tab);
    });
  }, [activeId]);

  const updateTabMetadata = useCallback(
    (id: string, metadata: { title?: string; favicon?: string | null }) => {
      const historyTitleUpdates: Array<{ url: string; title: string }> = [];
      setTabs((currentTabs) => {
        let changed = false;
        const nextTabs = currentTabs.map((tab) => {
          if (tab.id !== id) return tab;

          let nextTitle = tab.title;
          let nextFavicon = tab.favicon;

          if (typeof metadata.title === 'string') {
            const normalizedTitle = metadata.title.trim();
            if (normalizedTitle) {
              nextTitle = normalizedTitle;
              if (!tab.url.startsWith('mira://') && normalizedTitle !== tab.url) {
                historyTitleUpdates.push({ url: tab.url, title: normalizedTitle });
              }
            }
          }

          if (metadata.favicon !== undefined) {
            nextFavicon = getUpdatedFavicon(tab.favicon, metadata.favicon);
          }

          if (nextTitle === tab.title && nextFavicon === tab.favicon) {
            return tab;
          }

          changed = true;
          return {
            ...tab,
            title: nextTitle,
            favicon: nextFavicon,
          };
        });

        return changed ? nextTabs : currentTabs;
      });
      for (const update of historyTitleUpdates) {
        updateHistoryEntryTitle(update.url, update.title).catch(() => undefined);
      }
    },
    [],
  );

  const syncNavigationHistory = useCallback((id: string, history: string[], index: number, offset: number, metadata: NavigationMetadata = {}) => {
    if (!history.length || index < 0 || index >= history.length) return;
    if (!history[index].startsWith('mira://')) {
      void addHistoryEntry(history[index], metadata.title?.trim() || history[index]).catch(() => undefined);
    }
    setTabs((current) => current.map((tab) => {
      if (tab.id !== id) return tab;
      let end = offset;
      while (end < tab.history.length && !tab.history[end].startsWith('mira://')) end++;
      const previous = tab.history.slice(offset, end);
      const sameEntries = previous.length === history.length && previous.every((url, i) => url === history[i]);
      const nextHistory = tab.history.slice(0, offset).concat(history, sameEntries ? tab.history.slice(end) : []);
      const nextIndex = offset + index;
      const url = history[index];
      const nextMetadata = getNavigationMetadata(tab, url, metadata);
      if (sameEntries && tab.historyIndex === nextIndex && tab.url === url
        && tab.title === nextMetadata.title && tab.favicon === nextMetadata.favicon) return tab;
      return {
        ...tab, url, history: nextHistory, historyIndex: nextIndex,
        ...nextMetadata,
      };
    }));
  }, []);

  const navigate = useCallback(
    (url: string, tabId?: string, options?: { fromWebview?: boolean }) => {
      const targetTabId = tabId ?? activeId;
      const requestedUrl = url.trim();
      if (isMailtoNavigationUrl(requestedUrl)) {
        void resolveMailtoTabTarget(requestedUrl).then((resolved) => {
          if (!resolved) return;
          applyResolvedNavigation(targetTabId, resolved.url, resolved.title);
        });
        return;
      }

      const normalizedRequestedUrl = normalizeTabNavigationUrl(requestedUrl);
      const targetTab = tabsRef.current.find((tab) => tab.id === targetTabId);
      const targetWebview = webviewMap.current[targetTabId];
      const shouldUseLiveWebview =
        options?.fromWebview !== true
        && !!targetTab
        && !!targetWebview
        && !targetTab.url.startsWith('mira://')
        && !normalizedRequestedUrl.startsWith('mira://')
        && typeof targetWebview.loadURL === 'function';

      if (shouldUseLiveWebview) {
        try {
          targetWebview.loadURL?.(normalizedRequestedUrl);
          return;
        } catch {
          // Fall back to state-based navigation below.
        }
      }

      applyResolvedNavigation(targetTabId, requestedUrl);
    },
    [activeId, applyResolvedNavigation, resolveMailtoTabTarget],
  );

  const navigateToNewTabPage = useCallback(() => {
    navigate(getBrowserSettings().newTabPage);
  }, [navigate]);

  useEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;

    // Clear stale guests when switching to an internal or deferred tab.
    const ipc = electron?.ipcRenderer;
    if (ipc && activeId) {
      const webContentsId = getWebContentsIdForTab(activeId);
      void ipc.invoke('tab-set-active-webcontents', webContentsId ?? null).catch(() => undefined);
    }
  }, [tabs, activeId, getWebContentsIdForTab]);

  useEffect(() => {
    if (!tabs.length) {
      const replacement = createInitialTab(getBrowserSettings().newTabPage);
      setTabs([replacement]);
      setActiveId(replacement.id);
      return;
    }

    const activeTabStillExists = tabs.some((tab) => tab.id === activeId);
    if (!activeTabStillExists) {
      setActiveId(tabs[0].id);
    }
  }, [tabs, activeId]);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    newTabRef.current = newTab;
  }, [newTab]);

  const goBack = () => {
    const activeTab = tabsRef.current.find((tab) => tab.id === activeId);
    const activeWebview = webviewMap.current[activeId];
    if (
      activeTab
      && !activeTab.url.startsWith('mira://')
      && activeWebview
      && typeof activeWebview.goBack === 'function'
      && activeTab.history[activeTab.historyIndex - 1]?.startsWith('mira://') !== true
    ) {
      try {
        if (activeWebview.canGoBack?.()) {
          activeWebview.goBack();
          return;
        }
      } catch {
        // Fall through to state-based history below.
      }
    }

    setTabs((t) =>
      t.map((tab) => {
        if (tab.id !== activeId) return tab;
        if (tab.historyIndex === 0) return tab;
        const newIdx = tab.historyIndex - 1;
        const nextUrl = tab.history[newIdx];
        const nextTitle = nextUrl.startsWith('mira://') ? miraUrlToName(nextUrl) : nextUrl;
        return {
          ...tab,
          url: nextUrl,
          title: nextTitle,
          favicon: nextUrl.startsWith('mira://') ? INTERNAL_FAVICON_URL : getNavigationMetadata(tab, nextUrl).favicon,
          historyIndex: newIdx,
        };
      }),
    );
  };

  const goForward = () => {
    const activeTab = tabsRef.current.find((tab) => tab.id === activeId);
    const activeWebview = webviewMap.current[activeId];
    if (
      activeTab
      && !activeTab.url.startsWith('mira://')
      && activeWebview
      && typeof activeWebview.goForward === 'function'
      && activeTab.history[activeTab.historyIndex + 1]?.startsWith('mira://') !== true
    ) {
      try {
        if (activeWebview.canGoForward?.()) {
          activeWebview.goForward();
          return;
        }
      } catch {
        // Fall through to state-based history below.
      }
    }

    setTabs((t) =>
      t.map((tab) => {
        if (tab.id !== activeId) return tab;
        if (tab.historyIndex >= tab.history.length - 1) return tab;
        const newIdx = tab.historyIndex + 1;
        const nextUrl = tab.history[newIdx];
        const nextTitle = nextUrl.startsWith('mira://') ? miraUrlToName(nextUrl) : nextUrl;
        return {
          ...tab,
          url: nextUrl,
          title: nextTitle,
          favicon: nextUrl.startsWith('mira://') ? INTERNAL_FAVICON_URL : getNavigationMetadata(tab, nextUrl).favicon,
          historyIndex: newIdx,
        };
      }),
    );
  };

  const reloadTab = useCallback((id: string) => {
    if (!id) return;

    const wv = webviewMap.current[id];
    if (wv && typeof wv.reload === 'function') {
      wv.reload();
      return;
    }

    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === id ? { ...tab, isSleeping: false, reloadToken: tab.reloadToken + 1 } : tab,
      ),
    );
  }, []);

  const reload = useCallback(() => {
    reloadTab(activeId);
  }, [activeId, reloadTab]);

  const reloadIgnoringCache = useCallback(() => {
    const wv = webviewMap.current[activeId];
    if (wv && typeof wv.reloadIgnoringCache === 'function') {
      wv.reloadIgnoringCache();
      return;
    }
    reload();
  }, [activeId, reload]);

  const clearCacheAndReload = useCallback(() => {
    const wv = webviewMap.current[activeId];
    const ipc = electron?.ipcRenderer;
    if (!wv || !ipc || !wv.getWebContentsId) {
      reloadIgnoringCache();
      return;
    }
    try {
      void ipc.invoke('webview-clear-cache-and-reload', wv.getWebContentsId()).catch(() => undefined);
    } catch {
      // The guest may have closed before its contents ID became available.
    }
  }, [activeId, reloadIgnoringCache]);

  const stopLoading = useCallback(() => {
    const wv = webviewMap.current[activeId];
    if (!wv || typeof wv.stop !== 'function') return;
    wv.stop();
  }, [activeId]);

  const searchInPage = useCallback(
    (query: string, options?: FindInPageOptions) => {
      const wv = webviewMap.current[activeId];
      if (!wv || typeof wv.findInPage !== 'function') return;

      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        if (typeof wv.stopFindInPage === 'function') {
          wv.stopFindInPage('clearSelection');
        }
        delete lastFindQueryByTabRef.current[activeId];
        delete activeFindRequestIdByTabRef.current[activeId];
        clearFindInPageMatchesForTab(activeId);
        return;
      }

      const previousQuery = lastFindQueryByTabRef.current[activeId];
      const isNewQuery = previousQuery !== normalizedQuery;
      if (isNewQuery) {
        clearFindInPageMatchesForTab(activeId);
        if (typeof wv.stopFindInPage === 'function') {
          wv.stopFindInPage('clearSelection');
        }
      }

      const requestId = wv.findInPage(normalizedQuery, {
        forward: options?.forward ?? true,
        findNext: options?.findNext ?? false,
        matchCase: options?.matchCase ?? false,
      });
      if (typeof requestId === 'number' && Number.isFinite(requestId)) {
        activeFindRequestIdByTabRef.current[activeId] = requestId;
      } else {
        delete activeFindRequestIdByTabRef.current[activeId];
      }
      lastFindQueryByTabRef.current[activeId] = normalizedQuery;
    },
    [activeId, clearFindInPageMatchesForTab],
  );

  const findInPageNext = useCallback(
    (forward = true) => {
      const query = lastFindQueryByTabRef.current[activeId];
      if (!query) return;

      searchInPage(query, {
        forward,
        findNext: true,
      });
    },
    [activeId, searchInPage],
  );

  const stopFindInPage = useCallback(() => {
    const wv = webviewMap.current[activeId];
    const hadSearch = activeFindRequestIdByTabRef.current[activeId] !== undefined
      || !!lastFindQueryByTabRef.current[activeId];
    if (hadSearch && wv && typeof wv.stopFindInPage === 'function') {
      try {
        wv.stopFindInPage('clearSelection');
      } catch {
        // A newly selected or discarded page may not have a ready guest yet.
      }
    }
    delete lastFindQueryByTabRef.current[activeId];
    delete activeFindRequestIdByTabRef.current[activeId];
    clearFindInPageMatchesForTab(activeId);
  }, [activeId, clearFindInPageMatchesForTab]);

  const toggleDevTools = () => {
    const wv = webviewMap.current[activeId];
    if (!wv) return;

    if (typeof wv.isDevToolsOpened === 'function' && wv.isDevToolsOpened()) {
      if (typeof wv.closeDevTools === 'function') {
        wv.closeDevTools();
      }
      return;
    }

    const devToolsOpenMode = getBrowserSettings().devToolsOpenMode;
    if (devToolsOpenMode === 'side') {
      const ipc = electron?.ipcRenderer;
      if (ipc && typeof wv.getWebContentsId === 'function') {
        const webContentsId = wv.getWebContentsId();
        if (typeof webContentsId === 'number' && Number.isFinite(webContentsId)) {
          void ipc
            .invoke<boolean>('webview-open-devtools', {
              webContentsId,
              mode: 'right',
            })
            .then((opened) => {
              if (!opened && typeof wv.openDevTools === 'function') {
                wv.openDevTools();
              }
            })
            .catch(() => {
              if (typeof wv.openDevTools === 'function') {
                wv.openDevTools();
              }
            });
          return;
        }
      }
    }

    if (typeof wv.openDevTools === 'function') {
      wv.openDevTools();
    }
  };
  const printPage = useCallback(() => {
    const activeTab = tabs.find((tab) => tab.id === activeId);
    if (activeTab?.url.startsWith('mira://')) {
      window.print();
      return;
    }

    const wv = webviewMap.current[activeId];
    if (!wv || typeof wv.print !== 'function') return;

    wv.print({ printBackground: true });
  }, [tabs, activeId]);

  const savePage = useCallback(() => {
    const activeTab = tabs.find((tab) => tab.id === activeId);
    if (!activeTab || activeTab.url.startsWith('mira://')) return;

    const wv = webviewMap.current[activeId];
    if (!wv || typeof wv.getWebContentsId !== 'function') return;
    const webContentsId = wv.getWebContentsId();
    if (typeof webContentsId !== 'number' || !Number.isFinite(webContentsId)) return;

    electron?.ipcRenderer
      ?.invoke('webview-context-action', {
        webContentsId,
        action: 'save-page-as',
      })
      .catch(() => undefined);
  }, [tabs, activeId]);

  const openFile = useCallback(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    ipc
      .invoke<string>('dialog-open-file-url')
      .then((fileUrl) => {
        if (typeof fileUrl !== 'string') return;
        const normalized = fileUrl.trim();
        if (!normalized) return;
        navigate(normalized);
      })
      .catch(() => undefined);
  }, [navigate]);

  const openViewSource = useCallback(() => {
    const activeTab = tabs.find((tab) => tab.id === activeId);
    if (!activeTab) return;

    const sourceUrl = activeTab.url.trim();
    if (!sourceUrl || sourceUrl.startsWith('mira://')) return;

    newTab(`view-source:${sourceUrl}`);
  }, [tabs, activeId, newTab]);

  const changePageZoom = useCallback((action: PageZoomAction) => {
    const tabId = activeIdRef.current;
    const webContentsId = getWebContentsIdForTab(tabId);
    if (electron?.ipcRenderer && webContentsId !== undefined) {
      void electron.ipcRenderer.invoke('page-zoom-change', { webContentsId, action }).catch(() => undefined);
      return;
    }
    const webview = webviewMap.current[tabId];
    if (!webview?.setZoomFactor) return;
    try {
      const current = webview.getZoomFactor?.() ?? zoomFactorByTabRef.current[tabId] ?? 1;
      const next = nextPageZoom(current, action);
      webview.setZoomFactor(next);
      zoomFactorByTabRef.current[tabId] = next;
    } catch { /* The guest may still be attaching. */ }
  }, [getWebContentsIdForTab]);

  const zoomIn = useCallback(() => changePageZoom('in'), [changePageZoom]);
  const zoomOut = useCallback(() => changePageZoom('out'), [changePageZoom]);
  const resetZoom = useCallback(() => changePageZoom('reset'), [changePageZoom]);

  const toggleFullScreen = useCallback(() => {
    const ipc = electron?.ipcRenderer;
    if (ipc) {
      ipc.invoke('window-fullscreen-toggle').catch(() => undefined);
      return;
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }

    void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  const scrollPage = useCallback(
    (command: ScrollPageCommand) => {
      const wv = webviewMap.current[activeId];
      if (wv && typeof wv.executeJavaScript === 'function') {
        const script = `(() => {
  const command = ${JSON.stringify(command)};
  const pageStep = Math.max(window.innerHeight * 0.9, 120);
  switch (command) {
    case 'page-down':
      window.scrollBy({ top: pageStep, left: 0, behavior: 'auto' });
      break;
    case 'page-up':
      window.scrollBy({ top: -pageStep, left: 0, behavior: 'auto' });
      break;
    case 'top':
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      break;
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: 'auto' });
      break;
    default:
      break;
  }
})();`;
        wv.executeJavaScript(script).catch(() => undefined);
        return;
      }

      const pageStep = Math.max(window.innerHeight * 0.9, 120);
      if (command === 'page-down') {
        window.scrollBy({ top: pageStep, left: 0, behavior: 'auto' });
        return;
      }
      if (command === 'page-up') {
        window.scrollBy({ top: -pageStep, left: 0, behavior: 'auto' });
        return;
      }
      if (command === 'top') {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        return;
      }
      if (command === 'bottom') {
        window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: 'auto' });
      }
    },
    [activeId],
  );

  useEffect(() => {
    const sleepInactiveTabs = async () => {
      const now = Date.now();
      setTabs((currentTabs) => {
        let changed = false;
        const nextTabs = currentTabs.map((tab) => {
          if (tab.id === activeId) {
            if (tab.isSleeping) {
              changed = true;
              // Restore tab state when waking up
              const webview = webviewMap.current[tab.id];
              if (webview && tab.frozenState) {
                restoreTabState(webview, tab.frozenState);
                resumeJavaScript(webview);
                resumeAnimations(webview);
                restoreTimers(webview);
              }
              return { ...tab, isSleeping: false, lastActiveAt: now, frozenState: undefined };
            }
            return tab;
          }

          if (tab.restoreDeferred) return tab;
          const shouldSleep = now - tab.lastActiveAt >= tabSleepAfterMs;
          if (shouldSleep && !tab.isSleeping) {
            changed = true;
            // Capture tab state before freezing (async operation)
            const webview = webviewMap.current[tab.id];
            if (webview) {
              // Apply freeze effects immediately
              suspendJavaScript(webview);
              pauseAnimations(webview);
              throttleTimers(webview);

              // Capture state asynchronously
              captureTabState(webview).then((frozenState) => {
                if (frozenState) {
                  setTabs((currentTabs) =>
                    currentTabs.map((t) =>
                      t.id === tab.id ? { ...t, frozenState } : t
                    )
                  );
                }
              }).catch(() => {
                // Ignore capture errors, tab still freezes without state
              });
            }

            return { ...tab, isSleeping: true };
          }

          return tab;
        });
        return changed ? nextTabs : currentTabs;
      });
    };

    const scheduleNextSleepCheck = () => {
      if (tabSleepTimerRef.current !== null) {
        window.clearTimeout(tabSleepTimerRef.current);
      }

      const now = Date.now();
      let nextCheckInMs: number | null = null;

      for (const tab of tabs) {
        if (tab.id === activeId || tab.isSleeping || tab.restoreDeferred) continue;
        const remainingMs = Math.max(tab.lastActiveAt + tabSleepAfterMs - now, 0);
        if (nextCheckInMs === null || remainingMs < nextCheckInMs) {
          nextCheckInMs = remainingMs;
        }
      }

      if (nextCheckInMs === null) return;

      tabSleepTimerRef.current = window.setTimeout(() => {
        sleepInactiveTabs();
      }, nextCheckInMs);
    };

    sleepInactiveTabs();
    scheduleNextSleepCheck();

    return () => {
      if (tabSleepTimerRef.current !== null) {
        window.clearTimeout(tabSleepTimerRef.current);
        tabSleepTimerRef.current = null;
      }
    };
  }, [tabs, activeId, tabSleepAfterMs]);

  // Cleanup effect for component unmount
  useEffect(() => {
    const currentWebviewMap = webviewMap.current;
    return () => {
      // Clean up all frozen states and restore any sleeping tabs
      tabs.forEach((tab) => {
        if (tab.isSleeping) {
          const webview = currentWebviewMap[tab.id];
          if (webview) {
            resumeJavaScript(webview);
            resumeAnimations(webview);
            restoreTimers(webview);
          }
        }
      });

      // Clear sleep timer
      if (tabSleepTimerRef.current !== null) {
        window.clearTimeout(tabSleepTimerRef.current);
        tabSleepTimerRef.current = null;
      }
    };
  }, [tabs]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (restorePromptOpen) return;
    persistSession(tabs, activeId);
  }, [tabs, activeId, restorePromptOpen]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onOpenUrlInNewTab = (_event: unknown, payload: unknown) => {
      const request = normalizeOpenUrlInNewTabRequest(payload);
      if (!request) return;

      const normalized = request.url;

      const now = Date.now();
      const last = recentIpcTabOpenRef.current;
      const isDuplicate =
        !!last && last.url === normalized && now - last.openedAt < IPC_OPEN_TAB_DEDUPE_WINDOW_MS;
      if (isDuplicate) return;

      recentIpcTabOpenRef.current = { url: normalized, openedAt: now };
      const sourceTabId =
        request.sourceWebContentsId !== undefined
          ? findTabIdForWebContentsId(request.sourceWebContentsId) ?? activeIdRef.current
          : activeIdRef.current;
      const activeTab = tabsRef.current.find((tab) => tab.id === activeIdRef.current);
      const shouldTrackAuthFlow = isLikelyAuthUrl(normalized);
      if (
        activeTab
        && activeTab.id === sourceTabId
        && isNewTabUrl(activeTab.url, getBrowserSettings().newTabPage)
      ) {
        navigateRef.current(normalized, activeTab.id);
        return;
      }

      if (isMailtoNavigationUrl(normalized)) {
        newTabToRight(
          sourceTabId,
          normalized,
          shouldTrackAuthFlow
            ? {
                activateDelayMs: IPC_OPEN_TAB_ACTIVATE_DELAY_MS,
                authFlowSourceTabId: sourceTabId,
                authFlowInitialUrl: normalized,
              }
            : {
                activateDelayMs: IPC_OPEN_TAB_ACTIVATE_DELAY_MS,
              },
        );
        return;
      }

      const nowForTab = Date.now();
      const stagedTabId = crypto.randomUUID();
      const stagedTab: Tab = {
        id: stagedTabId,
        url: normalized,
        title: normalized.startsWith('mira://')
          ? miraUrlToName(normalized)
          : normalized,
        favicon: normalized.startsWith('mira://') ? INTERNAL_FAVICON_URL : undefined,
        history: [normalized],
        historyIndex: 0,
        reloadToken: 0,
        isSleeping: false,
        lastActiveAt: nowForTab,
        authFlowSourceTabId: shouldTrackAuthFlow ? sourceTabId : undefined,
        authFlowInitialUrl: shouldTrackAuthFlow ? normalized : undefined,
      };
      setTabs((currentTabs) => {
        const sourceTabIndex = currentTabs.findIndex((tab) => tab.id === sourceTabId);
        const activeTabIndex = currentTabs.findIndex((tab) => tab.id === activeIdRef.current);
        const updatedTabs = currentTabs.map((tab) =>
          tab.id === activeIdRef.current ? { ...tab, lastActiveAt: nowForTab } : tab,
        );

        // Insert the new tab next to the source tab when available.
        if (sourceTabIndex >= 0) {
          updatedTabs.splice(sourceTabIndex + 1, 0, stagedTab);
        } else if (activeTabIndex >= 0) {
          updatedTabs.splice(activeTabIndex + 1, 0, stagedTab);
        } else {
          updatedTabs.push(stagedTab);
        }

        return updatedTabs;
      });

      window.setTimeout(() => {
        if (!tabsRef.current.some((tab) => tab.id === stagedTabId)) return;
        setActiveId(stagedTabId);
      }, IPC_OPEN_TAB_ACTIVATE_DELAY_MS);
    };

    ipc.on('open-url-in-new-tab', onOpenUrlInNewTab);

    if (!didConsumeIncomingUrlsRef.current && isBootstrapReady) {
      didConsumeIncomingUrlsRef.current = true;
      const incomingUrls = startupIncomingUrlsRef.current;
      startupIncomingUrlsRef.current = [];
      if (incomingUrls.length > 0) {
        navigateRef.current(incomingUrls[0], activeIdRef.current);
        incomingUrls.slice(1).forEach((incomingUrl) => {
          newTabRef.current(incomingUrl);
        });
      }
    }

    return () => ipc.off('open-url-in-new-tab', onOpenUrlInNewTab);
  }, [findTabIdForWebContentsId, isBootstrapReady, miraUrlToName, newTabToRight]);

  useEffect(
    () => () => {
      if (reopenTabActivationTimerRef.current !== null) {
        window.clearTimeout(reopenTabActivationTimerRef.current);
        reopenTabActivationTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onOpenUrlInCurrentTab = (_event: unknown, url: string) => {
      if (typeof url !== 'string') return;
      const normalized = url.trim();
      if (!normalized) return;
      navigateRef.current(normalized);
    };

    ipc.on('open-url-in-current-tab', onOpenUrlInCurrentTab);
    return () => ipc.off('open-url-in-current-tab', onOpenUrlInCurrentTab);
  }, []);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onWebviewCloseResult = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || !payload) return;
      const candidate = payload as { tabId?: unknown; closed?: unknown };
      const tabId = typeof candidate.tabId === 'string' ? candidate.tabId.trim() : '';
      if (!tabId || candidate.closed !== true) return;
      finalizeTabClose(tabId);
    };

    ipc.on('webview-close-result', onWebviewCloseResult);
    return () => ipc.off('webview-close-result', onWebviewCloseResult);
  }, [finalizeTabClose]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onDetachedTabTransferComplete = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || !payload) return;
      const candidate = payload as { tabId?: unknown };
      const tabId = typeof candidate.tabId === 'string' ? candidate.tabId.trim() : '';
      if (!tabId) return;
      finalizeDetachedTabMove(tabId);
    };

    ipc.on('detached-tab-transfer-complete', onDetachedTabTransferComplete);
    return () => ipc.off('detached-tab-transfer-complete', onDetachedTabTransferComplete);
  }, [finalizeDetachedTabMove]);

  return (
    <TabsContext.Provider
      value={{
        tabs,
        tabAudioState,
        syncTabAudio,
        toggleTabMuted,
        activeId,
        newTab,
        newTabToRight,
        reloadTab,
        duplicateTab,
        toggleTabPinned,
        createTabGroup,
        moveTabToGroup,
        moveTabGroup,
        updateTabGroup,
        ungroupTabs,
        closeTabGroup,
        recentlyClosed,
        restoreRecentlyClosed,
        openRecentlyClosed,
        reopenLastClosedTab,
        openHistory,
        openDownloads,
        openBookmarks,
        toggleBookmarksBar,
        bookmarkCurrentPage,
        bookmarkAllTabs,
        closeWindow,
        closeTab,
        closeOtherTabs,
        closeTabsToRight,
        moveTab,
        moveTabToIndex,
        moveActiveTabBy,
        moveTabToNewWindow,
        navigate,
        navigateToNewTabPage,
        goBack,
        goForward,
        reload,
        reloadIgnoringCache,
        clearCacheAndReload,
        stopLoading,
        searchInPage,
        findInPageNext,
        stopFindInPage,
        findInPageActiveMatchOrdinal: activeFindInPageMatches.activeMatchOrdinal,
        findInPageMatches: activeFindInPageMatches.matches,
        updateFindInPageMatches,
        toggleDevTools,
        updateTabMetadata,
        syncNavigationHistory,
        printPage,
        savePage,
        openFile,
        openViewSource,
        zoomIn,
        zoomOut,
        resetZoom,
        toggleFullScreen,
        scrollPage,
        registerWebview,
        isPageLoading: loadingTabIds.has(activeId),
        setTabLoading,
        getWebContentsIdForTab,
        setActive,
        restorePromptOpen,
        restoreTabCount: pendingSession?.tabs.length ?? restoreTabCountState,
        restoreWindowCount,
        restoreTabsFromPreviousSession,
        restoreWindowsFromPreviousSession,
        discardPreviousSession,
      }}
    >
      {children}
    </TabsContext.Provider>
  );
}
