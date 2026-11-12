/// <reference types="vite/client" />
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTabs } from './TabsProvider';
import { selectPageFavicon } from './tabMetadata';
import { BROWSER_SETTINGS_CHANGED_EVENT, getBrowserSettings } from '../settings/browserSettings';
import { getThemeById } from '../themes/themeLoader';
import { electron } from '../../electronBridge';
import ContextMenu, { type ContextMenuEntry } from '../../components/ContextMenu';
import DevToolsDock from '../../components/DevToolsDock';
import {
  isLikelyAuthUrl,
  shouldAllowNativePopupWindow,
  shouldReturnFromAuthPopup,
} from './popupFlows';
import {
  consumePendingHttpsUpgradeHttpUrl,
  consumeUnsecureSiteBypassOnce,
  isUnsecureSiteAllowed,
  toHttpsUrlFromHttp,
} from '../security/unsecureSitePolicy';

interface WebviewNavigationEvent extends Event {
  url: string;
}

interface WebviewInPageNavigationEvent extends WebviewNavigationEvent {
  isMainFrame?: boolean;
}

interface WebviewWillNavigateEvent extends Event {
  url?: string;
  isMainFrame?: boolean;
}

interface WebviewDidFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

interface WebviewPageTitleUpdatedEvent extends Event {
  title: string;
}

interface WebviewPageFaviconUpdatedEvent extends Event {
  favicons: string[];
}

interface WebviewFoundInPageResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

interface WebviewFoundInPageEvent extends Event {
  result?: WebviewFoundInPageResult;
  requestId?: number;
  activeMatchOrdinal?: number;
  matches?: number;
  finalUpdate?: boolean;
}

interface WebviewContextMenuEditFlags {
  canUndo?: boolean;
  canRedo?: boolean;
  canCut?: boolean;
  canCopy?: boolean;
  canPaste?: boolean;
  canPasteAndMatchStyle?: boolean;
  canSelectAll?: boolean;
}

interface WebviewContextMenuParams {
  x?: number;
  y?: number;
  pageURL?: string;
  linkURL?: string;
  srcURL?: string;
  mediaType?: string;
  isEditable?: boolean;
  editFlags?: WebviewContextMenuEditFlags;
}

interface WebviewContextMenuEvent extends Event {
  params?: WebviewContextMenuParams;
}

interface WebviewNewWindowEvent extends Event {
  url?: string;
  frameName?: string;
  disposition?: string;
  features?: string;
}

interface WebviewElement extends HTMLElement {
  src: string;
  guestinstance?: string;
  reload: () => void;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  findInPage: (
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
  ) => number;
  stopFindInPage?: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  openDevTools: () => void;
  closeDevTools: () => void;
  isDevToolsOpened: () => boolean;
  getWebContentsId?: () => number;
  getURL: () => string;
  getTitle?: () => string;
  isLoading?: () => boolean;
  willNavigateHandler?: (e: WebviewWillNavigateEvent) => void;
  didNavigateHandler?: (e: WebviewNavigationEvent) => void;
  didNavigateInPageHandler?: (e: WebviewInPageNavigationEvent) => void;
  didStartLoadingHandler?: () => void;
  didStopLoadingHandler?: () => void;
  didAttachHandler?: () => void;
  didStartNavigationHandler?: (e: WebviewInPageNavigationEvent) => void;
  didRedirectNavigationHandler?: (e: WebviewInPageNavigationEvent) => void;
  didFailLoadHandler?: (e: WebviewDidFailLoadEvent) => void;
  domReadyHandler?: () => void;
  didPageTitleUpdatedHandler?: (e: WebviewPageTitleUpdatedEvent) => void;
  pageFaviconUpdatedHandler?: (e: WebviewPageFaviconUpdatedEvent) => void;
  foundInPageHandler?: (e: WebviewFoundInPageEvent) => void;
  contextMenuHandler?: (e: WebviewContextMenuEvent) => void;
  newWindowHandler?: (e: WebviewNewWindowEvent) => void;
}

interface NormalizedContextMenuEditFlags {
  canUndo: boolean;
  canRedo: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canPasteAndMatchStyle: boolean;
  canSelectAll: boolean;
}

interface NormalizedContextMenuParams {
  x: number;
  y: number;
  pageURL: string;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  isEditable: boolean;
  editFlags: NormalizedContextMenuEditFlags;
}

interface PageContextMenuState {
  tabId: string;
  webContentsId: number;
  x: number;
  y: number;
  params: NormalizedContextMenuParams;
}

interface NativeContextCommandPayload {
  command?: unknown;
  webContentsId?: unknown;
  tabId?: unknown;
  url?: unknown;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  baseUrl?: unknown;
}

interface MainFrameHttpErrorPayload {
  webContentsId?: unknown;
  url?: unknown;
  statusCode?: unknown;
}

interface ExternalErrorState {
  route: 'errors/external-404' | 'errors/external-network' | 'errors/external-offline' | 'errors/unsecure-site';
  failedUrlComparable: string;
  httpFallbackUrl?: string;
}

const RAW_FILE_DARK_STYLE_SCRIPT_ID = 'mira-raw-file-dark-mode-style';
const WEBVIEW_TRACKED_SRC_ATTR = 'data-mira-tracked-src';
const WEBVIEW_TAB_ID_ATTR = 'data-mira-tab-id';
const ERR_INTERNET_DISCONNECTED = -106;
const ERR_CONNECTION_REFUSED = -102;
const ERR_CONNECTION_FAILED = -104;
const ERR_SSL_PROTOCOL_ERROR = -107;
const DETACHED_TRANSFER_ATTACH_TIMEOUT_MS = 1500;

/**
 * Produces a stable comparable URL string used to suppress redundant webview reloads.
 */
function normalizeComparableUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function isHttpsUpgradeFailure(event: WebviewDidFailLoadEvent): boolean {
  if (
    event.errorCode === ERR_CONNECTION_REFUSED
    || event.errorCode === ERR_CONNECTION_FAILED
    || event.errorCode === ERR_SSL_PROTOCOL_ERROR
  ) {
    return true;
  }

  const normalizedDescription = event.errorDescription.trim().toUpperCase();
  return normalizedDescription.includes('ERR_SSL_');
}

function getTabIdForWebContentsId(webContentsId: number): string | undefined {
  if (!Number.isFinite(webContentsId) || webContentsId <= 0) return undefined;
  const webviewNodes = Array.from(document.querySelectorAll('webview')) as WebviewElement[];
  const matchingWebview = webviewNodes.find((node) => {
    if (typeof node.getWebContentsId !== 'function') return false;
    return node.getWebContentsId() === webContentsId;
  });
  if (!matchingWebview) return undefined;
  const tabId = matchingWebview.getAttribute(WEBVIEW_TAB_ID_ATTR)?.trim();
  return tabId || undefined;
}

/**
 * Resolves context-menu URLs, supporting relative links against the page URL.
 */
function resolveContextMenuUrl(rawUrl: string, baseUrl?: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';

  try {
    const normalizedBase = typeof baseUrl === 'string' ? baseUrl.trim() : '';
    return normalizedBase
      ? new URL(trimmed, normalizedBase).toString()
      : new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

/**
 * Guards "open in new tab" actions to known-safe schemes handled by the app.
 */
function canOpenInNewTab(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;

  try {
    const protocol = new URL(trimmed).protocol.toLowerCase();
    return (
      protocol === 'http:' ||
      protocol === 'https:' ||
      protocol === 'file:' ||
      protocol === 'mailto:' ||
      protocol === 'about:' ||
      protocol === 'mira:' ||
      protocol === 'view-source:'
    );
  } catch {
    return false;
  }
}

function normalizeContextMenuParams(
  params?: WebviewContextMenuParams,
): NormalizedContextMenuParams {
  const editFlags = params?.editFlags;
  return {
    x: Number.isFinite(params?.x) ? Math.floor(params?.x ?? 0) : 0,
    y: Number.isFinite(params?.y) ? Math.floor(params?.y ?? 0) : 0,
    pageURL: typeof params?.pageURL === 'string' ? params.pageURL.trim() : '',
    linkURL: typeof params?.linkURL === 'string' ? params.linkURL.trim() : '',
    srcURL: typeof params?.srcURL === 'string' ? params.srcURL.trim() : '',
    mediaType: typeof params?.mediaType === 'string' ? params.mediaType.trim().toLowerCase() : '',
    isEditable: params?.isEditable === true,
    editFlags: {
      canUndo: editFlags?.canUndo ?? true,
      canRedo: editFlags?.canRedo ?? true,
      canCut: editFlags?.canCut ?? true,
      canCopy: editFlags?.canCopy ?? true,
      canPaste: editFlags?.canPaste ?? true,
      canPasteAndMatchStyle: editFlags?.canPasteAndMatchStyle ?? true,
      canSelectAll: editFlags?.canSelectAll ?? true,
    },
  };
}

/**
 * Applies/removes a dark style override for raw text files in GitHub raw views.
 */
function applyRawFileDarkModeStyle(webview: WebviewElement, shouldApply: boolean) {
  const script = `(() => {
  const shouldApply = ${shouldApply ? 'true' : 'false'};
  const styleId = ${JSON.stringify(RAW_FILE_DARK_STYLE_SCRIPT_ID)};
  const isRawHost = location.hostname === 'raw.githubusercontent.com';
  const contentType = (document.contentType || '').toLowerCase();
  const hasSinglePreBody =
    !!document.body
    && document.body.children.length === 1
    && document.body.firstElementChild?.tagName === 'PRE';
  const isRawTextDocument =
    contentType.startsWith('text/plain')
    || contentType.startsWith('application/json')
    || (contentType === '' && hasSinglePreBody)
    || (isRawHost && hasSinglePreBody);
  const existing = document.getElementById(styleId);

  if (shouldApply && isRawTextDocument) {
    if (!existing) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = [
        'html, body, pre {',
        '  background: #000 !important;',
        '  color: #fff !important;',
        '}',
        'a { color: #b9d88d !important; }',
      ].join('\\n');
      document.head?.appendChild(style) || document.documentElement.appendChild(style);
    }
    document.documentElement.style.setProperty('color-scheme', 'dark');
    return;
  }

  existing?.remove();
  document.documentElement.style.removeProperty('color-scheme');
})();`;

  try {
    webview.executeJavaScript(script).catch(() => undefined);
  } catch {
    // Newly restored webviews may not be ready yet; dom-ready reapplies the style.
  }
}

function detachWebviewListeners(webview: WebviewElement) {
  if (webview.didStopLoadingHandler) {
    webview.removeEventListener('did-stop-loading', webview.didStopLoadingHandler);
    webview.removeEventListener('render-process-gone', webview.didStopLoadingHandler);
    delete webview.didStopLoadingHandler;
  }
  if (webview.didAttachHandler) {
    webview.removeEventListener('did-attach', webview.didAttachHandler);
    delete webview.didAttachHandler;
  }
  if (webview.willNavigateHandler) {
    webview.removeEventListener('will-navigate', webview.willNavigateHandler as EventListener);
    delete webview.willNavigateHandler;
  }
  if (webview.didNavigateHandler) {
    webview.removeEventListener('did-navigate', webview.didNavigateHandler as EventListener);
    delete webview.didNavigateHandler;
  }
  if (webview.didNavigateInPageHandler) {
    webview.removeEventListener(
      'did-navigate-in-page',
      webview.didNavigateInPageHandler as EventListener,
    );
    delete webview.didNavigateInPageHandler;
  }
  if (webview.didStartLoadingHandler) {
    webview.removeEventListener(
      'did-start-loading',
      webview.didStartLoadingHandler as EventListener,
    );
    delete webview.didStartLoadingHandler;
  }
  if (webview.didStartNavigationHandler) {
    webview.removeEventListener('did-start-navigation', webview.didStartNavigationHandler as EventListener);
    delete webview.didStartNavigationHandler;
  }
  if (webview.didRedirectNavigationHandler) {
    webview.removeEventListener('did-redirect-navigation', webview.didRedirectNavigationHandler as EventListener);
    delete webview.didRedirectNavigationHandler;
  }
  if (webview.didFailLoadHandler) {
    webview.removeEventListener('did-fail-load', webview.didFailLoadHandler as EventListener);
    delete webview.didFailLoadHandler;
  }
  if (webview.domReadyHandler) {
    webview.removeEventListener('dom-ready', webview.domReadyHandler as EventListener);
    delete webview.domReadyHandler;
  }
  if (webview.didPageTitleUpdatedHandler) {
    webview.removeEventListener(
      'page-title-updated',
      webview.didPageTitleUpdatedHandler as EventListener,
    );
    delete webview.didPageTitleUpdatedHandler;
  }
  if (webview.pageFaviconUpdatedHandler) {
    webview.removeEventListener(
      'page-favicon-updated',
      webview.pageFaviconUpdatedHandler as EventListener,
    );
    delete webview.pageFaviconUpdatedHandler;
  }
  if (webview.foundInPageHandler) {
    webview.removeEventListener('found-in-page', webview.foundInPageHandler as EventListener);
    delete webview.foundInPageHandler;
  }
  if (webview.contextMenuHandler) {
    webview.removeEventListener('context-menu', webview.contextMenuHandler as EventListener);
    delete webview.contextMenuHandler;
  }
  if (webview.newWindowHandler) {
    webview.removeEventListener('new-window', webview.newWindowHandler as EventListener);
    delete webview.newWindowHandler;
  }
}

function readWebviewWebContentsId(webview: WebviewElement): number | null {
  if (typeof webview.getWebContentsId !== 'function') return null;
  try {
    const value = webview.getWebContentsId();
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  } catch {
    return null;
  }
  return null;
}

// Load all internal pages (unchanged)
const modules = import.meta.glob('../../browser_pages/**/*.tsx', { eager: true }) as Record<
  string,
  { default: React.ComponentType }
>;

const pages = Object.entries(modules).reduce<Record<string, React.ComponentType>>(
  (acc, [path, mod]) => {
    const m = path.match(/\/browser_pages\/(.+)\.tsx$/);
    if (!m) return acc;
    const route = m[1].replace(/\\/g, '/').toLowerCase();
    acc[route] = mod.default;
    const idxRoute = route.replace(/\/index$/, '');
    if (idxRoute !== route && !(idxRoute in acc)) acc[idxRoute] = mod.default;
    return acc;
  },
  {},
);

function isInternal(url: string) {
  return url.startsWith('mira://');
}

function renderInternal(url: string, reloadToken: number) {
  const routeRawWithParams = url.replace(/^mira:\/\//, '');
  const routeRaw = routeRawWithParams.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, '');
  const route = routeRaw.toLowerCase();
  const Page = pages[route];
  if (Page) return <Page key={`${route}-${reloadToken}`} />;

  const NotFoundPage = pages['errors/internal-404'] ?? pages['errors/404'] ?? pages['404'];
  if (NotFoundPage) {
    return <NotFoundPage key={`errors/404-${reloadToken}`} />;
  }

  return <div style={{ padding: 20 }}>Unknown internal page: {routeRaw || '(root)'}</div>;
}

/**
 * Renders either an internal page or a live Electron webview for the active tab.
 */
export default function TabView() {
  const {
    tabs,
    activeId,
    navigate,
    updateTabMetadata,
    syncNavigationHistory,
    registerWebview,
    setTabLoading,
    syncTabAudio,
    updateFindInPageMatches,
    newTabToRight,
    goBack,
    goForward,
    reload,
    printPage,
    setActive,
  } = useTabs();
  const [tabSleepMode, setTabSleepMode] = useState(() => getBrowserSettings().tabSleepMode);
  const [rawFileDarkModeEnabled, setRawFileDarkModeEnabled] = useState(
    () => getBrowserSettings().rawFileDarkModeEnabled,
  );
  const [nativeTextFieldContextMenu, setNativeTextFieldContextMenu] = useState(
    () => getBrowserSettings().nativeTextFieldContextMenu,
  );
  const [renderOrderTabIds, setRenderOrderTabIds] = useState<string[]>(() =>
    tabs.map((tab) => tab.id),
  );
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(() => {
    const settings = getBrowserSettings();
    return getThemeById(settings.themeId)?.mode ?? 'dark';
  });
  const [pageMenuState, setPageMenuState] = useState<PageContextMenuState | null>(null);
  const [externalErrorByTabId, setExternalErrorByTabId] = useState<
    Record<string, ExternalErrorState>
  >({});
  const lastNativeContextCommandRef = React.useRef<{ signature: string; at: number } | null>(null);
  const isMacOS = electron?.isMacOS ?? false;
  const primaryShortcutLabel = isMacOS ? 'Cmd' : 'Ctrl';
  const redoShortcutLabel = isMacOS ? 'Cmd+Shift+Z' : 'Ctrl+Y';
  const inspectShortcutLabel = isMacOS ? 'Cmd+Opt+I' : 'F12';
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const renderTabs = useMemo(
    () =>
      renderOrderTabIds
        .map((id) => tabsById.get(id))
        .filter((tab): tab is (typeof tabs)[number] => !!tab),
    [renderOrderTabIds, tabsById],
  );
  const webviewMap = useRef<Record<string, WebviewElement>>({});
  const navigationUrlByTabIdRef = useRef<Record<string, string>>({});
  const stateUrlByTabIdRef = useRef<Record<string, string>>({});
  const nativeHistoryOffsetRef = useRef<Record<string, number>>({});
  const faviconSyncSequenceRef = useRef<Record<string, number>>({});
  const historySyncSequenceRef = useRef<Record<string, number>>({});
  const pendingHistoryRestoreRef = useRef<Record<string, { history: string[]; index: number; attachAttempts?: number }>>({});
  const webviewRefCallbacks = useRef<Record<string, (el: Element | null) => void>>({});
  const completedDetachedTransferIdsRef = useRef<Record<string, true>>({});
  const pendingDetachedTransferIdsRef = useRef<Record<string, true>>({});
  const completedAuthReturnByTabIdRef = useRef<Record<string, true>>({});
  const pendingHttpsUpgradeByTabIdRef = useRef<
    Record<
      string,
      {
        httpsUrlComparable: string;
        httpUrl: string;
      }
    >
  >({});

  const acknowledgeDetachedTransfer = React.useEffectEvent((transferId: string) => {
    if (!transferId || completedDetachedTransferIdsRef.current[transferId]) return;
    completedDetachedTransferIdsRef.current[transferId] = true;
    delete pendingDetachedTransferIdsRef.current[transferId];

    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    void ipc.invoke('detached-tab-transfer-complete', transferId).catch(() => undefined);
  });

  const waitForDetachedTransferAttachment = React.useEffectEvent(
    (webview: WebviewElement, transferId: string, expectedWebContentsId?: number) => {
      if (!transferId || completedDetachedTransferIdsRef.current[transferId]) return;
      if (pendingDetachedTransferIdsRef.current[transferId]) return;

      pendingDetachedTransferIdsRef.current[transferId] = true;
      const startedAt = window.performance.now();

      const poll = () => {
        if (completedDetachedTransferIdsRef.current[transferId]) {
          delete pendingDetachedTransferIdsRef.current[transferId];
          return;
        }

        const currentWebContentsId = readWebviewWebContentsId(webview);
        const matchesExpected =
          typeof expectedWebContentsId !== 'number'
          || !Number.isFinite(expectedWebContentsId)
          || currentWebContentsId === expectedWebContentsId;

        if (currentWebContentsId !== null && matchesExpected) {
          acknowledgeDetachedTransfer(transferId);
          return;
        }

        if (window.performance.now() - startedAt >= DETACHED_TRANSFER_ATTACH_TIMEOUT_MS) {
          delete pendingDetachedTransferIdsRef.current[transferId];
          return;
        }

        window.requestAnimationFrame(poll);
      };

      window.requestAnimationFrame(poll);
    },
  );

  useEffect(() => {
    const syncSettings = () => {
      const settings = getBrowserSettings();
      setTabSleepMode(settings.tabSleepMode);
      setRawFileDarkModeEnabled(settings.rawFileDarkModeEnabled);
      setNativeTextFieldContextMenu(settings.nativeTextFieldContextMenu);
      setThemeMode(getThemeById(settings.themeId)?.mode ?? 'dark');
    };

    syncSettings();
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
    return () => window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
  }, []);

  useEffect(() => {
    const shouldApplyRawFileDarkMode = rawFileDarkModeEnabled && themeMode === 'dark';
    const webviews = document.querySelectorAll('webview');
    webviews.forEach((node) => {
      applyRawFileDarkModeStyle(node as unknown as WebviewElement, shouldApplyRawFileDarkMode);
    });
  }, [rawFileDarkModeEnabled, themeMode]);

  useEffect(() => {
    const nextIds = new Set(tabs.map((tab) => tab.id));
    for (const tabId of Object.keys(completedAuthReturnByTabIdRef.current)) {
      if (!nextIds.has(tabId)) {
        delete completedAuthReturnByTabIdRef.current[tabId];
      }
    }
    for (const tabId of Object.keys(pendingHttpsUpgradeByTabIdRef.current)) {
      if (!nextIds.has(tabId)) {
        delete pendingHttpsUpgradeByTabIdRef.current[tabId];
      }
    }
  }, [tabs]);

  useEffect(() => {
    const handleExternalLinkClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const link = target.closest('a[href]');
      if (!link || !link.getAttribute('href')) return;

      const href = link.getAttribute('href')!;
      const isExternal = href.startsWith('http') && !href.includes(window.location.origin);
      if (!isExternal || !isLikelyAuthUrl(href)) return;

      event.preventDefault();
      event.stopPropagation();
      newTabToRight(activeId, href, {
        authFlowSourceTabId: activeId,
        authFlowInitialUrl: href,
      });
    };

    document.addEventListener('click', handleExternalLinkClick, true);
    return () => document.removeEventListener('click', handleExternalLinkClick, true);
  }, [activeId, newTabToRight]);

  const shouldApplyRawFileDarkMode = rawFileDarkModeEnabled && themeMode === 'dark';

  const maybeReturnFromAuthFlow = React.useEffectEvent((tabId: string, url: string) => {
    const currentTab = tabsById.get(tabId);
    const sourceTabId = currentTab?.authFlowSourceTabId?.trim() ?? '';
    const initialUrl = currentTab?.authFlowInitialUrl?.trim() ?? '';
    if (!sourceTabId || !initialUrl) return;
    if (completedAuthReturnByTabIdRef.current[tabId]) return;
    if (!tabsById.has(sourceTabId)) return;
    if (!shouldReturnFromAuthPopup(url, initialUrl)) return;

    completedAuthReturnByTabIdRef.current[tabId] = true;
    setActive(sourceTabId);
  });

  const clearExternalErrorForTab = useCallback((tabId: string) => {
    setExternalErrorByTabId((current) => {
      if (!(tabId in current)) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }, []);

  const clearPendingHttpsUpgradeForTab = useCallback((tabId: string) => {
    delete pendingHttpsUpgradeByTabIdRef.current[tabId];
  }, []);

  const trackPendingHttpsUpgradeForTab = useCallback(
    (tabId: string, httpUrl: string, httpsUrl: string) => {
      pendingHttpsUpgradeByTabIdRef.current[tabId] = {
        httpsUrlComparable: normalizeComparableUrl(httpsUrl),
        httpUrl,
      };
    },
    [],
  );

  useEffect(() => {
    const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
    setExternalErrorByTabId((current) => {
      let changed = false;
      const next: Record<string, ExternalErrorState> = {};
      for (const [tabId, errorState] of Object.entries(current)) {
        const tab = tabById.get(tabId);
        if (!tab || isInternal(tab.url)) {
          changed = true;
          continue;
        }
        next[tabId] = errorState;
      }
      return changed ? next : current;
    });
  }, [tabs]);

  useEffect(() => {
    const nextIds = tabs.map((tab) => tab.id);
    setRenderOrderTabIds((current) => {
      const nextIdSet = new Set(nextIds);
      const kept = current.filter((id) => nextIdSet.has(id));
      const keptSet = new Set(kept);
      const additions = nextIds.filter((id) => !keptSet.has(id));
      const merged = kept.concat(additions);
      if (merged.length !== current.length) return merged;
      for (let index = 0; index < merged.length; index += 1) {
        if (merged[index] !== current[index]) return merged;
      }
      return current;
    });
  }, [tabs]);

  useEffect(() => {
    const nextIdSet = new Set(tabs.map((tab) => tab.id));
    for (const tabId of Object.keys(webviewRefCallbacks.current)) {
      if (!nextIdSet.has(tabId)) {
        delete webviewRefCallbacks.current[tabId];
      }
    }
  }, [tabs]);

  const syncWebviewSource = React.useEffectEvent((tabId: string, webview: WebviewElement) => {
    const tab = tabsById.get(tabId);
    if (!tab || isInternal(tab.url)) return;

    const trackedSrc = webview.getAttribute(WEBVIEW_TRACKED_SRC_ATTR) ?? '';
    const nextSrc = normalizeComparableUrl(tab.url);
    if (stateUrlByTabIdRef.current[tabId] === nextSrc) return;
    stateUrlByTabIdRef.current[tabId] = nextSrc;
    if (trackedSrc !== nextSrc) {
      historySyncSequenceRef.current[tabId] = (historySyncSequenceRef.current[tabId] ?? 0) + 1;
      navigationUrlByTabIdRef.current[tabId] = nextSrc;
      clearExternalErrorForTab(tabId);
      webview.setAttribute(WEBVIEW_TRACKED_SRC_ATTR, nextSrc);
      webview.src = tab.url;
    }
  });

  const syncNativeHistory = React.useEffectEvent(async (tabId: string, webview: WebviewElement, url: string, sameDocument = false) => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) {
      navigate(url, tabId, { fromWebview: true });
      return;
    }
    const sequence = (historySyncSequenceRef.current[tabId] ?? 0) + 1;
    historySyncSequenceRef.current[tabId] = sequence;
    try {
      const snapshot = await ipc.invoke<{ history: string[]; index: number } | null>(
        'tab-navigation-history', webview.getWebContentsId?.(),
      );
      if (webviewMap.current[tabId] !== webview || historySyncSequenceRef.current[tabId] !== sequence) return;
      if (!snapshot || !Array.isArray(snapshot.history) || !snapshot.history[snapshot.index]) return;
      const currentUrl = snapshot.history[snapshot.index];
      webview.setAttribute(WEBVIEW_TRACKED_SRC_ATTR, normalizeComparableUrl(currentUrl));
      navigationUrlByTabIdRef.current[tabId] = normalizeComparableUrl(currentUrl);
      syncNavigationHistory(tabId, snapshot.history, snapshot.index, nativeHistoryOffsetRef.current[tabId] ?? 0, {
        sameDocument, title: webview.getTitle?.(),
      });
    } catch {
      // Keep navigation usable when running against an older main process.
      if (webviewMap.current[tabId] === webview && historySyncSequenceRef.current[tabId] === sequence) {
        navigate(url, tabId, { fromWebview: true });
      }
    }
  });

  const handleDidNavigate = React.useEffectEvent(
    (tabId: string, webview: WebviewElement, event: Event, sameDocument = false) => {
      const webviewEvent = event as WebviewNavigationEvent;
      if (webviewEvent.url === 'about:blank' && tabsById.get(tabId)?.url !== 'about:blank') return;
      navigationUrlByTabIdRef.current[tabId] = normalizeComparableUrl(webviewEvent.url);
      webview.setAttribute(WEBVIEW_TRACKED_SRC_ATTR, normalizeComparableUrl(webviewEvent.url));
      clearPendingHttpsUpgradeForTab(tabId);
      clearExternalErrorForTab(tabId);
      void syncNativeHistory(tabId, webview, webviewEvent.url, sameDocument);
      applyRawFileDarkModeStyle(webview, shouldApplyRawFileDarkMode);
      maybeReturnFromAuthFlow(tabId, webviewEvent.url);
    },
  );

  const handleWillNavigate = React.useEffectEvent((tabId: string, event: Event) => {
    const webviewEvent = event as WebviewWillNavigateEvent;
    if (webviewEvent.isMainFrame === false) return;

    const requestedUrl = typeof webviewEvent.url === 'string' ? webviewEvent.url.trim() : '';
    if (!requestedUrl.toLowerCase().startsWith('http://')) return;

    if (consumeUnsecureSiteBypassOnce(requestedUrl)) {
      clearPendingHttpsUpgradeForTab(tabId);
      return;
    }
    if (isUnsecureSiteAllowed(requestedUrl)) {
      clearPendingHttpsUpgradeForTab(tabId);
      return;
    }

    const httpsUrl = toHttpsUrlFromHttp(requestedUrl);
    if (!httpsUrl) return;

    event.preventDefault();
    trackPendingHttpsUpgradeForTab(tabId, requestedUrl, httpsUrl);
    clearExternalErrorForTab(tabId);
    navigate(httpsUrl, tabId);
  });

  const handleDidStartLoading = React.useEffectEvent((tabId: string) => {
    setTabLoading(tabId, true);
    clearExternalErrorForTab(tabId);
  });

  const handleNavigationStarted = React.useEffectEvent((tabId: string, event: Event) => {
    const navigation = event as WebviewInPageNavigationEvent;
    if (navigation.isMainFrame === false || !navigation.url) return;
    historySyncSequenceRef.current[tabId] = (historySyncSequenceRef.current[tabId] ?? 0) + 1;
    navigationUrlByTabIdRef.current[tabId] = normalizeComparableUrl(navigation.url);
    clearExternalErrorForTab(tabId);
  });

  const handleDidFailLoad = React.useEffectEvent((tabId: string, event: Event) => {
    const webviewEvent = event as WebviewDidFailLoadEvent;
    if (!webviewEvent.isMainFrame) return;
    // Ignore cancellations from abort/redirect churn.
    if (webviewEvent.errorCode === 0 || webviewEvent.errorCode === -3) return;

    const currentTab = tabsById.get(tabId);
    const failedUrl = webviewEvent.validatedURL || currentTab?.url || '';
    const failedComparable = normalizeComparableUrl(failedUrl);
    const currentNavigationUrl = navigationUrlByTabIdRef.current[tabId];
    if (currentNavigationUrl && failedComparable !== currentNavigationUrl) return;
    const pendingHttpsUpgrade = pendingHttpsUpgradeByTabIdRef.current[tabId];

    if (
      pendingHttpsUpgrade
      && pendingHttpsUpgrade.httpsUrlComparable === failedComparable
      && isHttpsUpgradeFailure(webviewEvent)
    ) {
      clearPendingHttpsUpgradeForTab(tabId);
      navigate(
        `mira://errors/unsecure-site?url=${encodeURIComponent(pendingHttpsUpgrade.httpUrl)}`,
        tabId,
      );
      return;
    }

    if (isHttpsUpgradeFailure(webviewEvent)) {
      const pendingTypedHttpUrl = consumePendingHttpsUpgradeHttpUrl(failedUrl);
      if (pendingTypedHttpUrl) {
        clearPendingHttpsUpgradeForTab(tabId);
        navigate(
          `mira://errors/unsecure-site?url=${encodeURIComponent(pendingTypedHttpUrl)}`,
          tabId,
        );
        return;
      }
    }

    clearPendingHttpsUpgradeForTab(tabId);

    const route =
      webviewEvent.errorCode === ERR_INTERNET_DISCONNECTED
        ? 'errors/external-offline'
        : 'errors/external-network';
    setExternalErrorByTabId((current) => ({
      ...current,
      [tabId]: {
        route,
        failedUrlComparable: failedComparable,
      },
    }));
  });

  const restoreNativeHistory = React.useEffectEvent((webview: WebviewElement) => {
    const tabId = webview.getAttribute(WEBVIEW_TAB_ID_ATTR) ?? '';
    const restore = pendingHistoryRestoreRef.current[tabId];
    if (restore) {
      const fallback = () => {
        if (webviewMap.current[tabId] === webview) webview.src = tabsById.get(tabId)?.url ?? 'about:blank';
      };
      let webContentsId: number | undefined;
      try {
        webContentsId = webview.getWebContentsId?.();
        if (!webContentsId) throw new Error('Guest is still attaching');
      } catch {
        restore.attachAttempts = (restore.attachAttempts ?? 0) + 1;
        if (restore.attachAttempts < 60) {
          window.setTimeout(() => {
            if (webviewMap.current[tabId] === webview) restoreNativeHistory(webview);
          }, 16);
        } else {
          delete pendingHistoryRestoreRef.current[tabId];
          fallback();
        }
        return;
      }
      delete pendingHistoryRestoreRef.current[tabId];
      void electron?.ipcRenderer.invoke<boolean>('tab-navigation-restore', {
        webContentsId, history: restore.history, index: restore.index,
      }).then((ok) => { if (!ok) fallback(); }).catch(fallback);
    }
  });

  const handleDomReady = React.useEffectEvent((webview: WebviewElement) => {
    const tabId = webview.getAttribute(WEBVIEW_TAB_ID_ATTR) ?? '';
    const currentTab = tabsById.get(tabId);
    if (currentTab) void syncNativeHistory(tabId, webview, currentTab.url);
    applyRawFileDarkModeStyle(webview, shouldApplyRawFileDarkMode);
    // Inject script to handle data-link attributes
    const dataLinkScript = `(() => {
  const falsyAttr = (value) => value === 'false' || value === '0' || value === 'no';
  const resolveUrl = (raw) => {
    try {
      return new URL(raw, window.location.href).toString();
    } catch {
      return raw;
    }
  };

  document.addEventListener('click', (e) => {
    const ev = e;
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const candidate = (path[0] instanceof Element ? path[0] : ev.target) instanceof Element
      ? (path[0] instanceof Element ? path[0] : ev.target)
      : null;
    if (!candidate) return;

    const element = candidate.closest('[data-link]');
    if (!element) return;

    const rawLink = element.getAttribute('data-link') ?? '';
    const link = rawLink.trim();
    if (!link) return;

    const hasNewTabAttr = element.hasAttribute('data-link-new-tab');
    const newTabAttrValue = (element.getAttribute('data-link-new-tab') ?? '').trim().toLowerCase();
    // Presence of data-link-new-tab should open in new tab, unless explicitly disabled.
    const wantsNewTab = hasNewTabAttr && !falsyAttr(newTabAttrValue);

    const isModifiedClick =
      (ev instanceof MouseEvent)
      && (ev.button === 1 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey);

    ev.preventDefault();
    ev.stopPropagation();

    const resolved = resolveUrl(link);
    if (wantsNewTab || isModifiedClick) {
      // Use window.open to trigger webview new-window event (opens in new tab)
      window.open(resolved, '_blank', 'noopener,noreferrer');
    } else {
      window.location.assign(resolved);
    }
  }, true);
})();`;
    webview.executeJavaScript(dataLinkScript).catch(() => undefined);

    const miraVersion = electron?.appVersion ?? null;
    if (miraVersion) {
      const miraVersionScript = `(() => {
  try {
    const version = ${JSON.stringify(miraVersion)};
    if (!version) return;
    const value = Object.freeze({ version });
    Object.defineProperty(window, 'mira', {
      value,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    // Ignore script injection errors.
  }
})();`;
      webview.executeJavaScript(miraVersionScript).catch(() => undefined);
    }
  });

  const handlePageTitleUpdated = React.useEffectEvent((tabId: string, event: Event) => {
    const webviewEvent = event as WebviewPageTitleUpdatedEvent;
    updateTabMetadata(tabId, { title: webviewEvent.title });
  });

  const handlePageFaviconUpdated = React.useEffectEvent(async (tabId: string, event: Event) => {
    const webview = webviewMap.current[tabId];
    const reported = (event as WebviewPageFaviconUpdatedEvent).favicons?.filter(
      (url) => typeof url === 'string' && url.trim(),
    );
    if (!webview || !reported?.length) return;
    const sequence = (faviconSyncSequenceRef.current[tabId] ?? 0) + 1;
    faviconSyncSequenceRef.current[tabId] = sequence;
    try {
      const page = await webview.executeJavaScript(`({
        url: location.href,
        icons: [...document.querySelectorAll('link[rel]')]
          .filter(link => link.rel.toLowerCase().split(/\\s+/).includes('icon'))
          .map(link => link.href)
      })`) as { url: string; icons: string[] };
      if (webviewMap.current[tabId] !== webview
        || faviconSyncSequenceRef.current[tabId] !== sequence
        || webview.getURL() !== page.url) return;
      const favicon = selectPageFavicon(page.url, page.icons, reported);
      if (favicon) updateTabMetadata(tabId, { favicon });
    } catch { /* Keep the current icon if the page navigates during inspection. */ }
  });

  const handleFoundInPage = React.useEffectEvent((tabId: string, event: Event) => {
    const webviewEvent = event as WebviewFoundInPageEvent;
    const result = webviewEvent.result ?? webviewEvent;
    const requestId = typeof result.requestId === 'number' ? result.requestId : Number.NaN;
    if (!Number.isFinite(requestId)) return;

    const activeMatchOrdinal =
      typeof result.activeMatchOrdinal === 'number' ? result.activeMatchOrdinal : 0;
    const matches = typeof result.matches === 'number' ? result.matches : 0;
    updateFindInPageMatches(tabId, requestId, activeMatchOrdinal, matches);
  });

  const handleContextMenu = React.useEffectEvent(
    (tabId: string, webview: WebviewElement, event: Event) => {
      const webviewEvent = event as WebviewContextMenuEvent;
      const params = normalizeContextMenuParams(webviewEvent.params);

      if (nativeTextFieldContextMenu) {
        const ipc = electron?.ipcRenderer;
        const webContentsId =
          typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : -1;
        if (ipc && Number.isFinite(webContentsId) && webContentsId > 0) {
          event.preventDefault();
          setPageMenuState(null);

          let x = params.x;
          let y = params.y;
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
            const webviewRect = webview.getBoundingClientRect();
            x = webviewRect.left + params.x;
            y = webviewRect.top + params.y;
          }

          const currentTab = tabsById.get(tabId);
          const canGoBack = (currentTab?.historyIndex ?? 0) > 0;
          const canGoForward =
            !!currentTab && currentTab.historyIndex < currentTab.history.length - 1;
          const sourceUrl = params.pageURL || currentTab?.url || '';

          void ipc
            .invoke('webview-show-native-context-menu', {
              webContentsId: Math.floor(webContentsId),
              tabId,
              x,
              y,
              params,
              context: {
                canGoBack,
                canGoForward,
                sourceUrl,
              },
            })
            .catch(() => undefined);
          return;
        }
      }

      event.preventDefault();

      const webContentsId =
        typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : -1;
      if (!Number.isFinite(webContentsId) || webContentsId <= 0) return;

      let x = params.x;
      let y = params.y;

      // Some environments report coordinates relative to the webview bounds.
      // If direct values look invalid, fall back to translating by webview offset.
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        const webviewRect = webview.getBoundingClientRect();
        x = webviewRect.left + params.x;
        y = webviewRect.top + params.y;
      }
      setPageMenuState({
        tabId,
        webContentsId: Math.floor(webContentsId),
        x,
        y,
        params,
      });
    },
  );

  const handleNewWindow = React.useEffectEvent((tabId: string, event: Event) => {
    const webviewEvent = event as WebviewNewWindowEvent;
    const url = typeof webviewEvent.url === 'string' ? webviewEvent.url.trim() : '';
    const frameName =
      typeof webviewEvent.frameName === 'string' ? webviewEvent.frameName.trim() : '';
    const disposition =
      typeof webviewEvent.disposition === 'string' ? webviewEvent.disposition.toLowerCase() : '';

    if (!url) {
      event.preventDefault();
      return;
    }

    if (shouldAllowNativePopupWindow(url, { disposition, frameName, features: webviewEvent.features })) {
      return;
    }

    // Prevent the default behavior of opening in a new window
    event.preventDefault();

    const shouldTrackAuthFlow = isLikelyAuthUrl(url);
    newTabToRight(
      tabId,
      url,
      shouldTrackAuthFlow
        ? {
            authFlowSourceTabId: tabId,
            authFlowInitialUrl: url,
          }
        : undefined,
    );
  });

  const attachWebview = React.useEffectEvent((tabId: string, webview: WebviewElement) => {
    detachWebviewListeners(webview);

    const didNavigateHandler = (event: Event) => {
      handleDidNavigate(tabId, webview, event);
    };
    const willNavigateHandler = (event: Event) => {
      handleWillNavigate(tabId, event);
    };
    const didNavigateInPageHandler = (event: Event) => {
      const webviewEvent = event as WebviewInPageNavigationEvent;
      if (webviewEvent.isMainFrame === false) return;
      handleDidNavigate(tabId, webview, event, true);
    };
    const didStartLoadingHandler = () => {
      handleDidStartLoading(tabId);
    };
    const didStopLoadingHandler = () => setTabLoading(tabId, false);
    const didAttachHandler = () => restoreNativeHistory(webview);
    const navigationStartedHandler = (event: Event) => {
      handleNavigationStarted(tabId, event);
    };
    const didFailLoadHandler = (event: Event) => {
      handleDidFailLoad(tabId, event);
    };
    const domReadyHandler = () => {
      setTabLoading(tabId, webview.isLoading?.() ?? false);
      syncTabAudio(tabId);
      handleDomReady(webview);
    };
    const didPageTitleUpdatedHandler = (event: Event) => {
      handlePageTitleUpdated(tabId, event);
    };
    const pageFaviconUpdatedHandler = (event: Event) => {
      handlePageFaviconUpdated(tabId, event);
    };
    const foundInPageHandler = (event: Event) => {
      handleFoundInPage(tabId, event);
    };
    const contextMenuHandler = (event: Event) => {
      handleContextMenu(tabId, webview, event);
    };
    const newWindowHandler = (event: Event) => {
      handleNewWindow(tabId, event);
    };

    webview.willNavigateHandler = willNavigateHandler as (e: WebviewWillNavigateEvent) => void;
    webview.didNavigateHandler = didNavigateHandler as (e: WebviewNavigationEvent) => void;
    webview.didNavigateInPageHandler = didNavigateInPageHandler as (
      e: WebviewInPageNavigationEvent,
    ) => void;
    webview.didStartLoadingHandler = didStartLoadingHandler;
    webview.didStopLoadingHandler = didStopLoadingHandler;
    webview.didAttachHandler = didAttachHandler;
    webview.didStartNavigationHandler = navigationStartedHandler;
    webview.didRedirectNavigationHandler = navigationStartedHandler;
    webview.didFailLoadHandler = didFailLoadHandler as (e: WebviewDidFailLoadEvent) => void;
    webview.domReadyHandler = domReadyHandler;
    webview.didPageTitleUpdatedHandler = didPageTitleUpdatedHandler as (
      e: WebviewPageTitleUpdatedEvent,
    ) => void;
    webview.pageFaviconUpdatedHandler = pageFaviconUpdatedHandler as (
      e: WebviewPageFaviconUpdatedEvent,
    ) => void;
    webview.foundInPageHandler = foundInPageHandler as (e: WebviewFoundInPageEvent) => void;
    webview.contextMenuHandler = contextMenuHandler as (e: WebviewContextMenuEvent) => void;
    webview.newWindowHandler = newWindowHandler as (e: WebviewNewWindowEvent) => void;

    webview.addEventListener('will-navigate', willNavigateHandler);
    webview.addEventListener('did-navigate', didNavigateHandler);
    webview.addEventListener('did-navigate-in-page', didNavigateInPageHandler);
    webview.addEventListener('did-start-loading', didStartLoadingHandler);
    webview.addEventListener('did-stop-loading', didStopLoadingHandler);
    webview.addEventListener('render-process-gone', didStopLoadingHandler);
    webview.addEventListener('did-attach', didAttachHandler);
    webview.addEventListener('did-start-navigation', navigationStartedHandler);
    webview.addEventListener('did-redirect-navigation', navigationStartedHandler);
    webview.addEventListener('did-fail-load', didFailLoadHandler);
    webview.addEventListener('dom-ready', domReadyHandler);
    webview.addEventListener('page-title-updated', didPageTitleUpdatedHandler);
    webview.addEventListener('page-favicon-updated', pageFaviconUpdatedHandler);
    webview.addEventListener('found-in-page', foundInPageHandler);
    webview.addEventListener('context-menu', contextMenuHandler);
    webview.addEventListener('new-window', newWindowHandler);
  });

  const handleWebviewRefChange = React.useEffectEvent((tabId: string, node: Element | null) => {
    const existing = webviewMap.current[tabId] ?? null;
    if (!node) {
      delete navigationUrlByTabIdRef.current[tabId];
      delete stateUrlByTabIdRef.current[tabId];
      delete nativeHistoryOffsetRef.current[tabId];
      delete pendingHistoryRestoreRef.current[tabId];
      historySyncSequenceRef.current[tabId] = (historySyncSequenceRef.current[tabId] ?? 0) + 1;
      clearPendingHttpsUpgradeForTab(tabId);
      if (!existing) return;
      detachWebviewListeners(existing);
      existing.removeAttribute(WEBVIEW_TAB_ID_ATTR);
      delete webviewMap.current[tabId];
      registerWebview(tabId, null);
      return;
    }

    const webview = node as unknown as WebviewElement;
    const tab = tabsById.get(tabId);
    const transferredGuestInstance =
      typeof tab?.transferredGuestInstance === 'string' ? tab.transferredGuestInstance.trim() : '';
    const detachedTransferId =
      typeof tab?.detachedTransferId === 'string' ? tab.detachedTransferId.trim() : '';
    const transferredWebContentsId =
      typeof tab?.transferredWebContentsId === 'number' && Number.isFinite(tab.transferredWebContentsId)
        ? Math.floor(tab.transferredWebContentsId)
        : undefined;

    webview.setAttribute(WEBVIEW_TAB_ID_ATTR, tabId);
    // Electron/Chromium treats `allowpopups` as a presence-based attribute.
    // React may serialize boolean props as `allowpopups="true"`, which can
    // fail to enable popups (e.g. target="_blank") depending on platform.
    webview.setAttribute('allowpopups', '');
    if (transferredGuestInstance) {
      webview.guestinstance = transferredGuestInstance;
      webview.setAttribute('guestinstance', transferredGuestInstance);
      if (tab && !isInternal(tab.url)) {
        webview.setAttribute(WEBVIEW_TRACKED_SRC_ATTR, normalizeComparableUrl(tab.url));
      }

      if (detachedTransferId) {
        waitForDetachedTransferAttachment(
          webview,
          detachedTransferId,
          transferredWebContentsId,
        );
      }
    }

    if (existing === webview) {
      registerWebview(tabId, webview);
      syncWebviewSource(tabId, webview);
      return;
    }

    if (existing) {
      detachWebviewListeners(existing);
      registerWebview(tabId, null);
    }

    webviewMap.current[tabId] = webview;
    registerWebview(tabId, webview);
    attachWebview(tabId, webview);
    let start = tab?.historyIndex ?? 0;
    let end = start + 1;
    while (start > 0 && !tab?.history[start - 1].startsWith('mira://')) start--;
    while (tab && end < tab.history.length && !tab.history[end].startsWith('mira://')) end++;
    nativeHistoryOffsetRef.current[tabId] = start;
    if (tab && electron?.ipcRenderer && !transferredGuestInstance && end - start > 1) {
      pendingHistoryRestoreRef.current[tabId] = { history: tab.history.slice(start, end), index: tab.historyIndex - start };
      const currentUrl = normalizeComparableUrl(tab.url);
      stateUrlByTabIdRef.current[tabId] = currentUrl;
      webview.setAttribute(WEBVIEW_TRACKED_SRC_ATTR, currentUrl);
      webview.src = 'about:blank#mira-restore-history';
    } else {
      syncWebviewSource(tabId, webview);
    }
  });

  const getWebviewRefCallback = useCallback((tabId: string) => {
    let callback = webviewRefCallbacks.current[tabId];
    if (!callback) {
      callback = (node: Element | null) => {
        handleWebviewRefChange(tabId, node);
      };
      webviewRefCallbacks.current[tabId] = callback;
    }
    return callback;
  }, []);

  useEffect(() => {
    for (const tab of tabs) {
      if (isInternal(tab.url)) continue;
      const webview = webviewMap.current[tab.id];
      if (!webview) continue;
      syncWebviewSource(tab.id, webview);
    }
  }, [tabs]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onMainFrameHttpError = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || !payload) return;
      const candidate = payload as MainFrameHttpErrorPayload;
      const webContentsId =
        typeof candidate.webContentsId === 'number' && Number.isFinite(candidate.webContentsId)
          ? Math.floor(candidate.webContentsId)
          : -1;
      if (webContentsId <= 0) return;

      const statusCode =
        typeof candidate.statusCode === 'number' && Number.isFinite(candidate.statusCode)
          ? Math.floor(candidate.statusCode)
          : 0;
      // Other HTTP errors can contain login, verification, or recovery pages.
      // They are server responses, not failed network connections.
      if (statusCode !== 404) return;

      const tabId = getTabIdForWebContentsId(webContentsId);
      if (!tabId) return;
      const errorUrl = typeof candidate.url === 'string' ? candidate.url.trim() : '';
      const failedComparable = normalizeComparableUrl(errorUrl);
      if (!failedComparable || navigationUrlByTabIdRef.current[tabId] !== failedComparable) return;

      setExternalErrorByTabId((current) => ({
        ...current,
        [tabId]: {
          route: 'errors/external-404',
          failedUrlComparable: failedComparable,
        },
      }));
    };

    ipc.on('webview-main-frame-http-error', onMainFrameHttpError);
    return () => ipc.off('webview-main-frame-http-error', onMainFrameHttpError);
  }, []);

  const closePageMenu = useCallback(() => {
    setPageMenuState(null);
  }, []);

  useEffect(() => {
    if (!pageMenuState) return;

    const tabStillExists = tabs.some((tab) => tab.id === pageMenuState.tabId);
    if (tabStillExists && pageMenuState.tabId === activeId) return;
    setPageMenuState(null);
  }, [tabs, activeId, pageMenuState]);

  const runWebviewContextAction = useCallback(
    (
      action: string,
      payload?: {
        url?: string;
        text?: string;
        x?: number;
        y?: number;
      },
      options?: {
        webContentsId?: number;
      },
    ) => {
      const resolvedWebContentsId = options?.webContentsId ?? pageMenuState?.webContentsId ?? -1;
      if (!Number.isFinite(resolvedWebContentsId) || resolvedWebContentsId <= 0) return;
      const ipc = electron?.ipcRenderer;
      if (!ipc) return;

      void ipc
        .invoke('webview-context-action', {
          webContentsId: Math.floor(resolvedWebContentsId),
          action,
          url: payload?.url,
          text: payload?.text,
          x: payload?.x,
          y: payload?.y,
        })
        .catch(() => undefined);
    },
    [pageMenuState],
  );

  const openInNewTabFromMenu = useCallback(
    (url: string, baseUrl: string | undefined, sourceTabId: string) => {
      const normalized = resolveContextMenuUrl(url, baseUrl);
      if (!canOpenInNewTab(normalized)) return;
      // Same as middle-click newWindowHandler: newTabToRight(tab.id, url)
      newTabToRight(sourceTabId, normalized);
      closePageMenu();
    },
    [closePageMenu, newTabToRight],
  );

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onNativeContextCommand = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || !payload) return;

      const candidate = payload as NativeContextCommandPayload;
      const command = typeof candidate.command === 'string' ? candidate.command.trim() : '';
      if (!command) return;

      const webContentsId =
        typeof candidate.webContentsId === 'number' && Number.isFinite(candidate.webContentsId)
          ? Math.floor(candidate.webContentsId)
          : -1;
      const x =
        typeof candidate.x === 'number' && Number.isFinite(candidate.x)
          ? Math.floor(candidate.x)
          : 0;
      const y =
        typeof candidate.y === 'number' && Number.isFinite(candidate.y)
          ? Math.floor(candidate.y)
          : 0;
      const rawUrl = typeof candidate.url === 'string' ? candidate.url : '';
      const rawBaseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl : '';
      const resolvedUrl = resolveContextMenuUrl(rawUrl, rawBaseUrl || undefined);
      const text = typeof candidate.text === 'string' ? candidate.text : '';

      const dedupeSignature = [
        command,
        String(webContentsId),
        resolvedUrl,
        text,
        String(x),
        String(y),
      ].join('|');
      const now = Date.now();
      const previous = lastNativeContextCommandRef.current;
      if (previous && previous.signature === dedupeSignature && now - previous.at < 250) {
        return;
      }
      lastNativeContextCommandRef.current = {
        signature: dedupeSignature,
        at: now,
      };

      if (command === 'open-url-in-new-tab') {
        if (!canOpenInNewTab(resolvedUrl)) return;
        const tabIdFromPayload =
          typeof candidate.tabId === 'string' ? candidate.tabId.trim() : '';
        const sourceTabId =
          tabIdFromPayload && tabs.some((t) => t.id === tabIdFromPayload)
            ? tabIdFromPayload
            : (webContentsId > 0 ? getTabIdForWebContentsId(webContentsId) : undefined) ?? activeId;
        newTabToRight(sourceTabId, resolvedUrl);
        return;
      }

      if (command === 'open-url-in-new-window') {
        if (!canOpenInNewTab(resolvedUrl)) return;
        const renderer = electron?.ipcRenderer;
        if (renderer) {
          void renderer.invoke('window-new-with-url', resolvedUrl).catch(() => undefined);
          return;
        }
        window.open(resolvedUrl, '_blank', 'noopener,noreferrer');
        return;
      }

      if (command === 'go-back') {
        goBack();
        return;
      }

      if (command === 'go-forward') {
        goForward();
        return;
      }

      if (command === 'reload') {
        reload();
        return;
      }

      if (command === 'print') {
        printPage();
        return;
      }

      if (webContentsId <= 0) return;

      if (command === 'save-page-as') {
        runWebviewContextAction('save-page-as', undefined, { webContentsId });
        return;
      }

      if (command === 'download-url') {
        runWebviewContextAction('download-url', { url: resolvedUrl }, { webContentsId });
        return;
      }

      if (command === 'copy-text') {
        runWebviewContextAction('copy-text', { text }, { webContentsId });
        return;
      }

      if (command === 'copy-image-at') {
        runWebviewContextAction('copy-image-at', { x, y }, { webContentsId });
        return;
      }

      if (command === 'inspect-element') {
        runWebviewContextAction('inspect-element', { x, y }, { webContentsId });
        return;
      }

      if (command === 'edit-undo') {
        runWebviewContextAction('edit-undo', undefined, { webContentsId });
        return;
      }

      if (command === 'edit-redo') {
        runWebviewContextAction('edit-redo', undefined, { webContentsId });
        return;
      }

      if (command === 'edit-cut') {
        runWebviewContextAction('edit-cut', undefined, { webContentsId });
        return;
      }

      if (command === 'edit-copy') {
        runWebviewContextAction('edit-copy', undefined, { webContentsId });
        return;
      }

      if (command === 'edit-paste') {
        runWebviewContextAction('edit-paste', undefined, { webContentsId });
        return;
      }

      if (command === 'edit-paste-as-plain-text') {
        runWebviewContextAction('edit-paste-as-plain-text', undefined, { webContentsId });
        return;
      }

      if (command === 'edit-select-all') {
        runWebviewContextAction('edit-select-all', undefined, { webContentsId });
      }
    };

    ipc.on('webview-native-context-command', onNativeContextCommand);
    return () => ipc.off('webview-native-context-command', onNativeContextCommand);
  }, [activeId, goBack, goForward, newTabToRight, printPage, reload, runWebviewContextAction, tabs]);

  const pageMenuEntries = useMemo<ContextMenuEntry[]>(() => {
    if (!pageMenuState) return [];

    const currentTab = tabs.find((tab) => tab.id === pageMenuState.tabId) ?? null;
    const params = pageMenuState.params;
    const sourceUrl = params.pageURL || currentTab?.url || '';

    const canGoBack = !!currentTab && currentTab.historyIndex > 0;
    const canGoForward = !!currentTab && currentTab.historyIndex < currentTab.history.length - 1;

    const item = (
      label: string,
      onSelect: () => void,
      options?: { disabled?: boolean; shortcut?: string },
    ): ContextMenuEntry => ({
      type: 'item',
      label,
      shortcut: options?.shortcut,
      onSelect,
      disabled: options?.disabled,
    });
    const separator = (): ContextMenuEntry => ({ type: 'separator' });
    const inspectEntry = item(
      'Inspect',
      () => runWebviewContextAction('inspect-element', { x: params.x, y: params.y }),
      { shortcut: inspectShortcutLabel },
    );

    if (params.isEditable) {
      return [
        item('Undo', () => runWebviewContextAction('edit-undo'), {
          disabled: !params.editFlags.canUndo,
          shortcut: `${primaryShortcutLabel}+Z`,
        }),
        item('Redo', () => runWebviewContextAction('edit-redo'), {
          disabled: !params.editFlags.canRedo,
          shortcut: redoShortcutLabel,
        }),
        separator(),
        item('Cut', () => runWebviewContextAction('edit-cut'), {
          disabled: !params.editFlags.canCut,
          shortcut: `${primaryShortcutLabel}+X`,
        }),
        item('Copy', () => runWebviewContextAction('edit-copy'), {
          disabled: !params.editFlags.canCopy,
          shortcut: `${primaryShortcutLabel}+C`,
        }),
        item('Paste', () => runWebviewContextAction('edit-paste'), {
          disabled: !params.editFlags.canPaste,
          shortcut: `${primaryShortcutLabel}+V`,
        }),
        item('Paste as Plain Text', () => runWebviewContextAction('edit-paste-as-plain-text'), {
          disabled: !params.editFlags.canPasteAndMatchStyle,
          shortcut: `${primaryShortcutLabel}+Shift+V`,
        }),
        separator(),
        item('Select All', () => runWebviewContextAction('edit-select-all'), {
          disabled: !params.editFlags.canSelectAll,
          shortcut: `${primaryShortcutLabel}+A`,
        }),
        separator(),
        inspectEntry,
      ];
    }

    if (params.mediaType === 'image' || !!params.srcURL) {
      const resolvedSrcUrl = resolveContextMenuUrl(params.srcURL, params.pageURL);
      const canOpenImageInNewTab = canOpenInNewTab(resolvedSrcUrl);
      return [
        item('Open Image in New Tab', () =>
          openInNewTabFromMenu(resolvedSrcUrl, params.pageURL, pageMenuState.tabId), {
          disabled: !canOpenImageInNewTab,
        }),
        item(
          'Save Image As',
          () => runWebviewContextAction('download-url', { url: resolvedSrcUrl }),
          {
            disabled: !resolvedSrcUrl,
          },
        ),
        item('Copy Image', () =>
          runWebviewContextAction('copy-image-at', { x: params.x, y: params.y }),
        ),
        item(
          'Copy Image Address',
          () => runWebviewContextAction('copy-text', { text: resolvedSrcUrl }),
          {
            disabled: !resolvedSrcUrl,
          },
        ),
        separator(),
        inspectEntry,
      ];
    }

    if (params.linkURL) {
      const resolvedLinkUrl = resolveContextMenuUrl(params.linkURL, params.pageURL);
      const canOpenLinkInNewTab = canOpenInNewTab(resolvedLinkUrl);
      return [
        item('Open in New Tab', () =>
          openInNewTabFromMenu(resolvedLinkUrl, params.pageURL, pageMenuState.tabId), {
          disabled: !canOpenLinkInNewTab,
        }),
        item(
          'Open in New Window',
          () => {
            if (!canOpenLinkInNewTab) return;
            const ipc = electron?.ipcRenderer;
            if (ipc) {
              void ipc.invoke('window-new-with-url', resolvedLinkUrl).catch(() => undefined);
              return;
            }
            window.open(resolvedLinkUrl, '_blank', 'noopener,noreferrer');
          },
          {
            disabled: !canOpenLinkInNewTab,
          },
        ),
        separator(),
        item(
          'Copy Link Address',
          () => runWebviewContextAction('copy-text', { text: resolvedLinkUrl }),
          {
            disabled: !resolvedLinkUrl,
          },
        ),
        item(
          'Save Link As',
          () => runWebviewContextAction('download-url', { url: resolvedLinkUrl }),
          {
            disabled: !resolvedLinkUrl,
          },
        ),
        separator(),
        inspectEntry,
      ];
    }

    return [
      item('Back', () => goBack(), { disabled: !canGoBack, shortcut: 'Alt+Left' }),
      item('Forward', () => goForward(), { disabled: !canGoForward, shortcut: 'Alt+Right' }),
      item('Reload', () => reload(), { shortcut: `${primaryShortcutLabel}+R` }),
      separator(),
      item('Save As', () => runWebviewContextAction('save-page-as'), {
        shortcut: `${primaryShortcutLabel}+S`,
      }),
      item('Print', () => printPage(), { shortcut: `${primaryShortcutLabel}+P` }),
      separator(),
      item('View Source', () =>
        openInNewTabFromMenu(`view-source:${sourceUrl}`, undefined, pageMenuState.tabId), {
        disabled: !sourceUrl,
        shortcut: `${primaryShortcutLabel}+U`,
      }),
      inspectEntry,
    ];
  }, [
    pageMenuState,
    tabs,
    openInNewTabFromMenu,
    goBack,
    goForward,
    reload,
    printPage,
    runWebviewContextAction,
    inspectShortcutLabel,
    primaryShortcutLabel,
    redoShortcutLabel,
  ]);

  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', width: '100%', height: '100%', display: 'flex' }}>
      {renderTabs.map((tab) => {
        const isVisible = tab.id === activeId;
        if (tab.restoreDeferred && !isVisible) return null;
        if (tabSleepMode === 'discard' && tab.isSleeping && !isVisible) {
          return null;
        }

        return (
          <div
            key={tab.id}
            style={{
              position: 'absolute',
              inset: 0,
              visibility: isVisible ? 'visible' : 'hidden',
              pointerEvents: isVisible ? 'auto' : 'none',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {isInternal(tab.url) ? (
              <div style={{ flex: 1, overflow: 'auto' }}>
                {renderInternal(tab.url, tab.reloadToken)}
              </div>
            ) : (
              <div style={{ flex: 1, position: 'relative', width: '100%', height: '100%', background: '#fff', display: 'flex' }}>
                <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                  <webview
                    partition={electron?.privatePartition}
                    guestinstance={tab.transferredGuestInstance}
                    data-mira-tracked-src={
                      tab.transferredGuestInstance ? normalizeComparableUrl(tab.url) : undefined
                    }
                    ref={getWebviewRefCallback(tab.id)}
                    style={{ flex: 1, width: '100%', height: '100%' }}
                  />
                  {(() => {
                    const externalError = externalErrorByTabId[tab.id];
                    if (!externalError) return null;
                    const ErrorPage =
                      pages[externalError.route] ??
                      (externalError.route === 'errors/external-404'
                        ? pages['errors/404']
                        : pages['errors/network']);
                    if (ErrorPage) {
                      return (
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            zIndex: 1,
                            background: 'var(--bg)',
                          }}
                        >
                          <ErrorPage />
                        </div>
                      );
                    }

                    return (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          zIndex: 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexDirection: 'column',
                          gap: 12,
                          background: 'var(--bg)',
                          color: 'var(--text1)',
                        }}
                      >
                        <div>Failed to load this page.</div>
                        <button
                          type="button"
                          onClick={reload}
                          className="theme-btn theme-btn-go"
                          style={{ padding: '8px 14px', fontSize: 14 }}
                        >
                          Reload
                        </button>
                      </div>
                    );
                  })()}
                </div>
                <DevToolsDock active={isVisible} getWebContentsId={() => webviewMap.current[tab.id]?.getWebContentsId?.()} />
              </div>
            )}
          </div>
        );
      })}
      <ContextMenu
        open={!!pageMenuState}
        anchor={pageMenuState ? { x: pageMenuState.x, y: pageMenuState.y } : null}
        entries={pageMenuEntries}
        onClose={closePageMenu}
        minWidth={208}
      />
    </div>
  );
}
