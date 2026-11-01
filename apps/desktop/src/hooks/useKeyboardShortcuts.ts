import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { electron } from '../electronBridge';

type ScrollPageCommand = 'page-down' | 'page-up' | 'top' | 'bottom';

interface UseKeyboardShortcutsProps {
  tabs: Array<{ id: string }>;
  newTab: (url?: string) => void;
  reopenLastClosedTab: () => void;
  openHistory: () => void;
  openDownloads: () => void;
  openBookmarks: () => void;
  toggleBookmarksBar: () => void;
  bookmarkCurrentPage: () => void;
  bookmarkAllTabs: () => void;
  openNewWindow: () => void;
  closeWindow: () => void;
  closeTab: (id: string) => void;
  moveActiveTabBy: (delta: -1 | 1) => void;
  navigateToNewTabPage: () => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  reloadIgnoringCache: () => void;
  clearCacheAndReload: () => void;
  stopLoading: () => void;
  findInPage: () => void;
  findInPageNext: (forward?: boolean) => void;
  toggleDevTools: () => void;
  printPage: () => void;
  savePage: () => void;
  openFile: () => void;
  openViewSource: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  toggleFullScreen: () => void;
  scrollPage: (command: ScrollPageCommand) => void;
  activeId: string | null;
  setActive: (id: string) => void;
  addressInputRef: RefObject<HTMLInputElement | null>;
}

interface IpcShortcutState {
  newTab: UseKeyboardShortcutsProps['newTab'];
  closeTab: UseKeyboardShortcutsProps['closeTab'];
  openHistory: UseKeyboardShortcutsProps['openHistory'];
  openDownloads: UseKeyboardShortcutsProps['openDownloads'];
  openBookmarks: UseKeyboardShortcutsProps['openBookmarks'];
  toggleBookmarksBar: UseKeyboardShortcutsProps['toggleBookmarksBar'];
  openNewWindow: UseKeyboardShortcutsProps['openNewWindow'];
  closeWindow: UseKeyboardShortcutsProps['closeWindow'];
  moveActiveTabBy: UseKeyboardShortcutsProps['moveActiveTabBy'];
  navigateToNewTabPage: UseKeyboardShortcutsProps['navigateToNewTabPage'];
  goBack: UseKeyboardShortcutsProps['goBack'];
  goForward: UseKeyboardShortcutsProps['goForward'];
  reload: UseKeyboardShortcutsProps['reload'];
  reloadIgnoringCache: UseKeyboardShortcutsProps['reloadIgnoringCache'];
  clearCacheAndReload: UseKeyboardShortcutsProps['clearCacheAndReload'];
  stopLoading: UseKeyboardShortcutsProps['stopLoading'];
  findInPage: UseKeyboardShortcutsProps['findInPage'];
  findInPageNext: UseKeyboardShortcutsProps['findInPageNext'];
  reopenLastClosedTab: UseKeyboardShortcutsProps['reopenLastClosedTab'];
  toggleDevTools: UseKeyboardShortcutsProps['toggleDevTools'];
  printPage: UseKeyboardShortcutsProps['printPage'];
  savePage: UseKeyboardShortcutsProps['savePage'];
  openFile: UseKeyboardShortcutsProps['openFile'];
  openViewSource: UseKeyboardShortcutsProps['openViewSource'];
  zoomIn: UseKeyboardShortcutsProps['zoomIn'];
  zoomOut: UseKeyboardShortcutsProps['zoomOut'];
  resetZoom: UseKeyboardShortcutsProps['resetZoom'];
  toggleFullScreen: UseKeyboardShortcutsProps['toggleFullScreen'];
  scrollPage: UseKeyboardShortcutsProps['scrollPage'];
  activeId: UseKeyboardShortcutsProps['activeId'];
  activateRelativeTab: (delta: 1 | -1) => void;
  activateTabByNumber: (number: number) => void;
  bookmarkCurrentPage: UseKeyboardShortcutsProps['bookmarkCurrentPage'];
  bookmarkAllTabs: UseKeyboardShortcutsProps['bookmarkAllTabs'];
}

/**
 * Registers browser-style keyboard shortcuts and maps them to tab/window actions.
 * In Electron mode, overlapping shortcuts are delegated to main-process accelerators.
 */
export function useKeyboardShortcuts({
  tabs,
  newTab,
  reopenLastClosedTab,
  openHistory,
  openDownloads,
  openBookmarks,
  toggleBookmarksBar,
  bookmarkCurrentPage,
  bookmarkAllTabs,
  openNewWindow,
  closeWindow,
  closeTab,
  moveActiveTabBy,
  navigateToNewTabPage,
  goBack,
  goForward,
  reload,
  reloadIgnoringCache,
  clearCacheAndReload,
  stopLoading,
  findInPage,
  findInPageNext,
  toggleDevTools,
  printPage,
  savePage,
  openFile,
  openViewSource,
  zoomIn,
  zoomOut,
  resetZoom,
  toggleFullScreen,
  scrollPage,
  activeId,
  setActive,
  addressInputRef,
}: UseKeyboardShortcutsProps) {
  const lastReopenShortcutAtRef = useRef(0);
  const lastRapidShortcutByActionRef = useRef<Record<string, number>>({});
  const ipcShortcutStateRef = useRef<IpcShortcutState | null>(null);

  const activateRelativeTab = useCallback(
    (delta: 1 | -1) => {
      if (!tabs.length) return;
      const currentIndex = activeId ? tabs.findIndex((tab) => tab.id === activeId) : -1;
      const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (safeCurrentIndex + delta + tabs.length) % tabs.length;
      const nextTab = tabs[nextIndex];
      if (!nextTab) return;
      setActive(nextTab.id);
    },
    [tabs, activeId, setActive],
  );

  const activateTabByNumber = useCallback(
    (number: number) => {
      if (!Number.isInteger(number) || number < 1 || number > 9) return;
      if (!tabs.length) return;
      const index = number === 9 ? tabs.length - 1 : number - 1;
      const nextTab = tabs[index];
      if (!nextTab) return;
      setActive(nextTab.id);
    },
    [tabs, setActive],
  );

  ipcShortcutStateRef.current = {
    newTab,
    closeTab,
    openHistory,
    openDownloads,
    openBookmarks,
    toggleBookmarksBar,
    openNewWindow,
    closeWindow,
    moveActiveTabBy,
    navigateToNewTabPage,
    goBack,
    goForward,
    reload,
    reloadIgnoringCache,
    clearCacheAndReload,
    stopLoading,
    findInPage,
    findInPageNext,
    reopenLastClosedTab,
    toggleDevTools,
    printPage,
    savePage,
    openFile,
    openViewSource,
    zoomIn,
    zoomOut,
    resetZoom,
    toggleFullScreen,
    scrollPage,
    activeId,
    activateRelativeTab,
    activateTabByNumber,
    bookmarkCurrentPage,
    bookmarkAllTabs,
  };

  useEffect(() => {
    const hasElectronBridge = !!electron?.ipcRenderer;
    const isMacOS = electron?.isMacOS ?? false;

    const handler = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tagName = (target?.tagName ?? '').toLowerCase();
      const isEditableTarget =
        tagName === 'input' || tagName === 'textarea' || target?.isContentEditable === true;
      const isAddressBarTarget = target === addressInputRef.current;
      if (isEditableTarget && !isAddressBarTarget) return;
      if (e.repeat) return;

      const isPrimaryModifier = isMacOS ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      const isPageUp = key === 'pageup';
      const isPageDown = key === 'pagedown';
      const isArrowUp = key === 'arrowup';
      const isArrowDown = key === 'arrowdown';
      const isSpace = e.key === ' ' || key === 'spacebar';
      const isOfflineGameActive = document.body.dataset.miraOfflineGameActive === 'true';

      if (isPrimaryModifier && !e.shiftKey && key === 't') {
        e.preventDefault();
        e.stopPropagation();
        newTab();
        return;
      }

      if (isPrimaryModifier && e.shiftKey && key === 't') {
        if (hasElectronBridge) return;
        e.preventDefault();
        e.stopPropagation();
        reopenLastClosedTab();
        return;
      }

      if (isPrimaryModifier && e.shiftKey && key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        closeWindow();
        return;
      }

      const historyKey = isMacOS ? key === 'y' : key === 'h';
      if (isPrimaryModifier && !e.shiftKey && historyKey) {
        e.preventDefault();
        e.stopPropagation();
        openHistory();
        return;
      }

      if (isPrimaryModifier && e.shiftKey && isPageUp) {
        e.preventDefault();
        e.stopPropagation();
        moveActiveTabBy(-1);
        return;
      }

      if (isPrimaryModifier && e.shiftKey && isPageDown) {
        e.preventDefault();
        e.stopPropagation();
        moveActiveTabBy(1);
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && !e.shiftKey && key === 'tab') {
        e.preventDefault();
        e.stopPropagation();
        activateRelativeTab(1);
        return;
      }

      if (isPrimaryModifier && e.shiftKey && key === 'tab') {
        if (hasElectronBridge) return;
        e.preventDefault();
        e.stopPropagation();
        activateRelativeTab(-1);
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && !e.shiftKey && /^[1-9]$/.test(key)) {
        e.preventDefault();
        e.stopPropagation();
        activateTabByNumber(Number.parseInt(key, 10));
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && !e.shiftKey && key === 'j') {
        e.preventDefault();
        e.stopPropagation();
        openDownloads();
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && !e.shiftKey && key === 'n') {
        e.preventDefault();
        e.stopPropagation();
        openNewWindow();
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        if (activeId) closeTab(activeId);
        return;
      }

      if (!isPrimaryModifier && e.altKey && !e.shiftKey && key === 'arrowleft') {
        e.preventDefault();
        e.stopPropagation();
        goBack();
        return;
      }

      if (!isPrimaryModifier && e.altKey && !e.shiftKey && key === 'arrowright') {
        e.preventDefault();
        e.stopPropagation();
        goForward();
        return;
      }

      if (!isPrimaryModifier && e.altKey && !e.shiftKey && key === 'home') {
        e.preventDefault();
        e.stopPropagation();
        navigateToNewTabPage();
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && key === 'l') {
        e.preventDefault();
        e.stopPropagation();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }

      if (!isPrimaryModifier && e.altKey && !e.shiftKey && key === 'd') {
        e.preventDefault();
        e.stopPropagation();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }

      if (!isPrimaryModifier && !e.altKey && !e.shiftKey && key === 'f6') {
        e.preventDefault();
        e.stopPropagation();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && e.altKey && e.shiftKey && key === 'r') {
        e.preventDefault();
        e.stopPropagation();
        clearCacheAndReload();
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && !e.shiftKey && key === 'r') {
        e.preventDefault();
        e.stopPropagation();
        reload();
        return;
      }

      if (
        !hasElectronBridge &&
        ((isPrimaryModifier && e.shiftKey && key === 'r') ||
          (isPrimaryModifier && !e.shiftKey && key === 'f5'))
      ) {
        e.preventDefault();
        e.stopPropagation();
        reloadIgnoringCache();
        return;
      }

      if (!hasElectronBridge && !isPrimaryModifier && !e.altKey && !e.shiftKey && key === 'f5') {
        e.preventDefault();
        e.stopPropagation();
        reload();
        return;
      }

      if (!isPrimaryModifier && !e.altKey && !e.shiftKey && key === 'escape') {
        e.preventDefault();
        e.stopPropagation();
        stopLoading();
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && !e.shiftKey && key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        findInPage();
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && key === 'g') {
        e.preventDefault();
        e.stopPropagation();
        findInPageNext(true);
        return;
      }

      if (isPrimaryModifier && e.shiftKey && key === 'g') {
        e.preventDefault();
        e.stopPropagation();
        findInPageNext(false);
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        savePage();
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        openFile();
        return;
      }

      if (isPrimaryModifier && e.shiftKey && key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        openBookmarks();
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && key === 'd') {
        e.preventDefault();
        e.stopPropagation();
        bookmarkCurrentPage();
        return;
      }

      if (isPrimaryModifier && e.shiftKey && key === 'd') {
        e.preventDefault();
        e.stopPropagation();
        bookmarkAllTabs();
        return;
      }

      if (isPrimaryModifier && e.shiftKey && key === 'b') {
        e.preventDefault();
        e.stopPropagation();
        toggleBookmarksBar();
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && key === 'u') {
        e.preventDefault();
        e.stopPropagation();
        openViewSource();
        return;
      }

      if (isPrimaryModifier && !e.altKey && (key === '+' || key === '=')) {
        e.preventDefault();
        e.stopPropagation();
        zoomIn();
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && !e.altKey && key === '-') {
        e.preventDefault();
        e.stopPropagation();
        zoomOut();
        return;
      }

      if (isPrimaryModifier && !e.shiftKey && !e.altKey && key === '0') {
        e.preventDefault();
        e.stopPropagation();
        resetZoom();
        return;
      }

      if (!isPrimaryModifier && !e.altKey && !e.shiftKey && key === 'f11') {
        e.preventDefault();
        e.stopPropagation();
        toggleFullScreen();
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && e.shiftKey && (key === 'i' || key === 'j')) {
        e.preventDefault();
        e.stopPropagation();
        toggleDevTools();
        return;
      }

      if (!hasElectronBridge && !isPrimaryModifier && !e.altKey && !e.shiftKey && key === 'f12') {
        e.preventDefault();
        e.stopPropagation();
        toggleDevTools();
        return;
      }

      if (!hasElectronBridge && isPrimaryModifier && !e.shiftKey && key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        printPage();
        return;
      }

      if (!isPrimaryModifier && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (
          (!isOfflineGameActive && !e.shiftKey && isSpace && !isEditableTarget) ||
          (isArrowDown && !isEditableTarget) ||
          isPageDown
        ) {
          e.preventDefault();
          e.stopPropagation();
          scrollPage('page-down');
          return;
        }

        if (
          (!isOfflineGameActive && e.shiftKey && isSpace && !isEditableTarget) ||
          (!isOfflineGameActive && isArrowUp && !isEditableTarget) ||
          isPageUp
        ) {
          e.preventDefault();
          e.stopPropagation();
          scrollPage('page-up');
          return;
        }

        if (!e.shiftKey && key === 'home') {
          e.preventDefault();
          e.stopPropagation();
          scrollPage('top');
          return;
        }

        if (!e.shiftKey && key === 'end') {
          e.preventDefault();
          e.stopPropagation();
          scrollPage('bottom');
        }
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [
    tabs,
    newTab,
    reopenLastClosedTab,
    openHistory,
    openDownloads,
    openBookmarks,
    toggleBookmarksBar,
    bookmarkCurrentPage,
    bookmarkAllTabs,
    openNewWindow,
    closeWindow,
    closeTab,
    moveActiveTabBy,
    navigateToNewTabPage,
    goBack,
    goForward,
    reload,
    reloadIgnoringCache,
    clearCacheAndReload,
    stopLoading,
    findInPage,
    findInPageNext,
    toggleDevTools,
    printPage,
    savePage,
    openFile,
    openViewSource,
    zoomIn,
    zoomOut,
    resetZoom,
    toggleFullScreen,
    scrollPage,
    activeId,
    setActive,
    addressInputRef,
    activateRelativeTab,
    activateTabByNumber,
  ]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const shouldSkipRapidAction = (action: string, thresholdMs = 120): boolean => {
      const now = Date.now();
      const lastAt = lastRapidShortcutByActionRef.current[action] ?? 0;
      if (now - lastAt < thresholdMs) {
        return true;
      }
      lastRapidShortcutByActionRef.current[action] = now;
      return false;
    };

    const onShortcut = (_event: unknown, action: string, payload?: unknown) => {
      const state = ipcShortcutStateRef.current;
      if (!state) return;

      if (action === 'new-tab') {
        if (shouldSkipRapidAction('new-tab')) return;
        state.newTab();
        return;
      }
      if (action === 'close-tab') {
        if (state.activeId) state.closeTab(state.activeId);
        return;
      }
      if (action === 'open-history') {
        if (shouldSkipRapidAction('open-history')) return;
        state.openHistory();
        return;
      }
      if (action === 'reload-tab') {
        state.reload();
        return;
      }
      if (action === 'reload-tab-clear-cache') {
        state.clearCacheAndReload();
        return;
      }
      if (action === 'reload-tab-ignore-cache') {
        state.reloadIgnoringCache();
        return;
      }
      if (action === 'stop-loading') {
        state.stopLoading();
        return;
      }
      if (action === 'find-in-page') {
        state.findInPage();
        return;
      }
      if (action === 'find-next') {
        state.findInPageNext(true);
        return;
      }
      if (action === 'find-previous') {
        state.findInPageNext(false);
        return;
      }
      if (action === 'open-window') {
        state.openNewWindow();
        return;
      }
      if (action === 'close-window') {
        state.closeWindow();
        return;
      }
      if (action === 'open-downloads') {
        if (shouldSkipRapidAction('open-downloads')) return;
        state.openDownloads();
        return;
      }
      if (action === 'open-bookmarks') {
        if (shouldSkipRapidAction('open-bookmarks')) return;
        state.openBookmarks();
        return;
      }
      if (action === 'toggle-bookmarks-bar') {
        if (shouldSkipRapidAction('toggle-bookmarks-bar')) return;
        state.toggleBookmarksBar();
        return;
      }
      if (action === 'bookmark-current-page') {
        if (shouldSkipRapidAction('bookmark-current-page')) return;
        state.bookmarkCurrentPage();
        return;
      }
      if (action === 'bookmark-all-tabs') {
        if (shouldSkipRapidAction('bookmark-all-tabs')) return;
        state.bookmarkAllTabs();
        return;
      }
      if (action === 'go-back') {
        state.goBack();
        return;
      }
      if (action === 'go-forward') {
        state.goForward();
        return;
      }
      if (action === 'navigate-new-tab-page') {
        state.navigateToNewTabPage();
        return;
      }
      if (action === 'focus-address-bar') {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }
      if (action === 'activate-next-tab') {
        state.activateRelativeTab(1);
        return;
      }
      if (action === 'activate-previous-tab') {
        state.activateRelativeTab(-1);
        return;
      }
      if (action === 'activate-tab-index') {
        if (typeof payload !== 'number') return;
        state.activateTabByNumber(payload);
        return;
      }
      if (action === 'move-active-tab-left') {
        state.moveActiveTabBy(-1);
        return;
      }
      if (action === 'move-active-tab-right') {
        state.moveActiveTabBy(1);
        return;
      }
      if (action === 'reopen-closed-tab') {
        const now = Date.now();
        if (now - lastReopenShortcutAtRef.current < 150) return;
        lastReopenShortcutAtRef.current = now;
        state.reopenLastClosedTab();
        return;
      }
      if (action === 'toggle-devtools') {
        state.toggleDevTools();
        return;
      }
      if (action === 'print-page') {
        state.printPage();
        return;
      }
      if (action === 'save-page') {
        state.savePage();
        return;
      }
      if (action === 'open-file') {
        state.openFile();
        return;
      }
      if (action === 'view-source') {
        state.openViewSource();
        return;
      }
      if (action === 'zoom-in') {
        state.zoomIn();
        return;
      }
      if (action === 'zoom-out') {
        state.zoomOut();
        return;
      }
      if (action === 'zoom-reset') {
        state.resetZoom();
        return;
      }
      if (action === 'toggle-fullscreen') {
        state.toggleFullScreen();
        return;
      }
      if (action === 'scroll-page') {
        if (
          payload === 'page-down' ||
          payload === 'page-up' ||
          payload === 'top' ||
          payload === 'bottom'
        ) {
          state.scrollPage(payload);
        }
      }
    };

    ipc.on('app-shortcut', onShortcut);
    return () => ipc.off('app-shortcut', onShortcut);
  }, [addressInputRef]);
}
