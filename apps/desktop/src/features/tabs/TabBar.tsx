import TabGroupOutlines from './TabGroupOutlines';
import TabConnection from './TabConnection';
import { TAB_GROUP_COLORS, type TabGroup } from '../../../electron/tabGroups';
import { promptDialog } from '../../components/appDialogs';
import TabFavicon from './TabFavicon';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, Pin, Plus, Volume2, VolumeX, X } from 'lucide-react';
import { useTabs } from './TabsProvider';
import type { Tab } from './types';
import miraLogo from '../../assets/mira_logo.png';
import ContextMenu, { type ContextMenuEntry } from '../../components/ContextMenu';
import { electron } from '../../electronBridge';
import {
  BROWSER_SETTINGS_CHANGED_EVENT,
  getBrowserSettings,
  type TabStripPosition,
} from '../settings/browserSettings';

const TAB_TARGET_WIDTH = 'var(--layoutTabTargetWidth, 220px)';
const TAB_MIN_WIDTH = 'var(--layoutTabMinWidth, 100px)';
const TAB_STRIP_GAP = 'var(--layoutTabGap, 6px)';
const TAB_ROW_HEIGHT = 'var(--layoutTabHeight, 27px)';
const NEW_TAB_BUTTON_SIZE = `max(20px, calc(${TAB_ROW_HEIGHT} - 4px))`;
const TAB_SWAP_TRIGGER_RATIO = 0.5;
const TAB_GROUP_EXIT_DISTANCE_PX = 24;
const TAB_GROUP_ENTRY_DISTANCE_PX = 40;
const TAB_SWAP_MIN_EDGE_DELTA_PX = 10;
const TAB_SWAP_COOLDOWN_MS = 70;
const TAB_APPEAR_SETTLE_MS = 24;
const TAB_ENTER_EXIT_DURATION_MS = 180;
const TAB_REORDER_ANIMATION_MS = 170;
const TAB_REORDER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const ORIENTATION_CHANGE_SETTLE_MS = 200;
const TAB_DETACH_THRESHOLD_PX = 56;

type RenderedTabState = {
  tab: Tab;
  phase: 'entering' | 'stable' | 'exiting';
  lastKnownIndex: number;
};

function getDisplayTitle(url: string, title?: string): string {
  const normalizedTitle = title?.trim();
  if (normalizedTitle) return normalizedTitle;

  if (url.startsWith('mira://')) {
    const route = url.replace(/^mira:\/\//, '').trim();
    if (!route || route.toLowerCase() === 'newtab') return 'New Tab';
    return route;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url || 'New Tab';
  }
}

function getDisplayFavicon(url: string, favicon?: string, deferred = false): string | undefined {
  const normalizedFavicon = favicon?.trim();
  if (normalizedFavicon) return normalizedFavicon;
  if (url.startsWith('mira://')) return miraLogo;
  if (deferred) return undefined;

  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return undefined;
    return new URL('/favicon.ico', parsed).href;
  } catch {
    return undefined;
  }
}

function getOutsideDistance(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

export default function TabBar({ orientation = 'horizontal' }: { orientation?: 'horizontal' | 'vertical' }) {
  const {
    tabs,
    tabAudioState,
    toggleTabMuted,
    activeId,
    setActive,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    moveTabToIndex,
    newTabToRight,
    newTab,
    reloadTab,
    duplicateTab,
    toggleTabPinned,
    createTabGroup,
    moveTabToGroup,
    moveTabGroup,
    updateTabGroup,
    ungroupTabs,
    closeTabGroup,
    moveTabToNewWindow,
  } = useTabs();
  const groups = useMemo(() => [...new Map(tabs.flatMap(tab => tab.group ? [[tab.group.id, tab.group] as const] : [])).values()], [tabs]);
  const [groupMenu, setGroupMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeGroupMenu = useCallback(() => setGroupMenu(null), []);
  const runGroupCommand = useCallback(async (groupId: string, command: string) => {
    const group = groups.find(group => group.id === groupId);
    if (!group) return;
    if (command === 'rename') {
      const name = await promptDialog({ title: 'Rename tab group', defaultValue: group.name, confirmLabel: 'Save' });
      if (name !== null) updateTabGroup(groupId, { name: name.trim() });
    } else if (command === 'toggle') updateTabGroup(groupId, { collapsed: !group.collapsed });
    else if (command === 'close') await closeTabGroup(groupId);
    else if (command === 'ungroup') ungroupTabs(groupId);
    else if (command.startsWith('color:')) {
      const color = command.slice(6) as TabGroup['color'];
      if (Object.hasOwn(TAB_GROUP_COLORS, color)) updateTabGroup(groupId, { color });
    }
  }, [groups, updateTabGroup, ungroupTabs, closeTabGroup]);
  const [tabMenuState, setTabMenuState] = useState<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [groupDragPointer, setGroupDragPointer] = useState<{ x: number; y: number } | null>(null);
  const groupDragRef = useRef<{ id: string; start: number; lastPointer: number; anchor: number; moved: boolean; lastSwap: number } | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [draggedTabPosition, setDraggedTabPosition] = useState<{ x: number; y: number } | null>(null);
  const [originalTabPosition, setOriginalTabPosition] = useState<{ x: number; y: number; right: number } | null>(null);
  const [draggedTabWidth, setDraggedTabWidth] = useState<number | null>(null);
  const [draggedTabHeight, setDraggedTabHeight] = useState<number | null>(null);
  const [dragUsesNativeWindow, setDragUsesNativeWindow] = useState(false);
  const [dragRegionsTemporarilyDisabled, setDragRegionsTemporarilyDisabled] = useState(false);
  const [transitionSuppressedTabId, setTransitionSuppressedTabId] = useState<string | null>(null);
  const [settledActiveId, setSettledActiveId] = useState(activeId);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [nativeContextMenusEnabled, setNativeContextMenusEnabled] = useState(
    () => getBrowserSettings().nativeTextFieldContextMenu,
  );
  const [animationsEnabled, setAnimationsEnabled] = useState(
    () => getBrowserSettings().animationsEnabled,
  );
  const [tabStripPosition, setTabStripPosition] = useState<TabStripPosition>(
    () => getBrowserSettings().tabStripPosition ?? 'top',
  );
  const isMacOS = electron?.isMacOS ?? false;
  const primaryShortcutLabel = isMacOS ? 'Cmd' : 'Ctrl';
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevTabCountRef = useRef(tabs.length);
  const tabElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useLayoutEffect(() => {
    if (settledActiveId === activeId) return;
    // Resolve both selection states with transitions suppressed before restoring
    // hover and reorder motion.
    tabElementRefs.current[settledActiveId]?.getBoundingClientRect();
    tabElementRefs.current[activeId]?.getBoundingClientRect();
    setSettledActiveId(activeId);
  }, [activeId, settledActiveId]);
  const previousRectsRef = useRef<Record<string, DOMRect>>({});
  const previousLayoutOrderRef = useRef<string[]>([]);
  const previousGroupMembershipRef = useRef(new Map<string, string | undefined>());
  const enterTimerByTabIdRef = useRef<Record<string, number>>({});
  const exitTimerByTabIdRef = useRef<Record<string, number>>({});
  const reorderAnimationByTabIdRef = useRef<Partial<Record<string, Animation>>>({});
  const dragPointerToLeftRef = useRef(0);
  const dragPointerWidthRatioRef = useRef(0.5);
  const dragPointerToTopRef = useRef(0);
  const lastSwapEdgeXRef = useRef<number | null>(null);
  const lastSwapEdgeYRef = useRef<number | null>(null);
  const lastSwapAtRef = useRef(0);
  const dragMovedRef = useRef(false);
  const dragDetachedRef = useRef(false);
  const dragRegionRefreshTimeoutRef = useRef<number | null>(null);
  const dragRegionDisableRafRef = useRef<number | null>(null);
  const dragRegionRestoreRafRef = useRef<number | null>(null);
  const dragRegionBaselineRafRef = useRef<number | null>(null);
  const transitionSuppressDisableRafRef = useRef<number | null>(null);
  const transitionSuppressRestoreRafRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const releasedDragTabIdRef = useRef<string | null>(null);
  const lastNativeTabCommandRef = useRef<{ signature: string; at: number } | null>(null);
  const orientationSettleUntilRef = useRef(0);
  const [renderedTabs, setRenderedTabs] = useState<RenderedTabState[]>(() =>
    tabs.map((tab, index) => ({ tab, phase: 'stable', lastKnownIndex: index })),
  );
  const renderedTabsRef = useRef<RenderedTabState[]>(renderedTabs);
  const tabsRef = useRef(tabs);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const cancelScheduledDragRegionRefresh = useCallback(() => {
    if (dragRegionRefreshTimeoutRef.current !== null) {
      window.clearTimeout(dragRegionRefreshTimeoutRef.current);
      dragRegionRefreshTimeoutRef.current = null;
    }
    if (dragRegionDisableRafRef.current !== null) {
      window.cancelAnimationFrame(dragRegionDisableRafRef.current);
      dragRegionDisableRafRef.current = null;
    }
    if (dragRegionRestoreRafRef.current !== null) {
      window.cancelAnimationFrame(dragRegionRestoreRafRef.current);
      dragRegionRestoreRafRef.current = null;
    }
    if (dragRegionBaselineRafRef.current !== null) {
      window.cancelAnimationFrame(dragRegionBaselineRafRef.current);
      dragRegionBaselineRafRef.current = null;
    }
    setDragRegionsTemporarilyDisabled(false);
  }, []);

  const cancelScheduledTransitionSuppression = useCallback(() => {
    if (transitionSuppressDisableRafRef.current !== null) {
      window.cancelAnimationFrame(transitionSuppressDisableRafRef.current);
      transitionSuppressDisableRafRef.current = null;
    }
    if (transitionSuppressRestoreRafRef.current !== null) {
      window.cancelAnimationFrame(transitionSuppressRestoreRafRef.current);
      transitionSuppressRestoreRafRef.current = null;
    }
    setTransitionSuppressedTabId(null);
  }, []);

  const suppressReleasedTabTransition = useCallback((tabId: string | null) => {
    cancelScheduledTransitionSuppression();
    if (!tabId) return;
    setTransitionSuppressedTabId(tabId);
    transitionSuppressDisableRafRef.current = window.requestAnimationFrame(() => {
      transitionSuppressDisableRafRef.current = null;
      transitionSuppressRestoreRafRef.current = window.requestAnimationFrame(() => {
        transitionSuppressRestoreRafRef.current = null;
        setTransitionSuppressedTabId((current) => (current === tabId ? null : current));
      });
    });
  }, [cancelScheduledTransitionSuppression]);

  const refreshDragRegions = useCallback(() => {
    cancelScheduledDragRegionRefresh();
    setDragRegionsTemporarilyDisabled(true);
    dragRegionDisableRafRef.current = window.requestAnimationFrame(() => {
      dragRegionDisableRafRef.current = null;
      dragRegionRestoreRafRef.current = window.requestAnimationFrame(() => {
        dragRegionRestoreRafRef.current = null;
        setDragRegionsTemporarilyDisabled(false);
      });
    });
  }, [cancelScheduledDragRegionRefresh]);

  const scheduleDragRegionRefresh = useCallback((delayMs: number) => {
    cancelScheduledDragRegionRefresh();
    dragRegionRefreshTimeoutRef.current = window.setTimeout(() => {
      dragRegionRefreshTimeoutRef.current = null;
      refreshDragRegions();
    }, delayMs);
  }, [cancelScheduledDragRegionRefresh, refreshDragRegions]);

  useEffect(() => {
    return () => {
      for (const timeout of Object.values(enterTimerByTabIdRef.current)) {
        window.clearTimeout(timeout);
      }
      for (const timeout of Object.values(exitTimerByTabIdRef.current)) {
        window.clearTimeout(timeout);
      }
      for (const animation of Object.values(reorderAnimationByTabIdRef.current)) {
        animation?.cancel();
      }
      enterTimerByTabIdRef.current = {};
      exitTimerByTabIdRef.current = {};
      reorderAnimationByTabIdRef.current = {};
      cancelScheduledDragRegionRefresh();
      cancelScheduledTransitionSuppression();
    };
  }, [cancelScheduledDragRegionRefresh, cancelScheduledTransitionSuppression]);

  useEffect(() => {
    if (!animationsEnabled) {
      for (const timeout of Object.values(enterTimerByTabIdRef.current)) {
        window.clearTimeout(timeout);
      }
      for (const timeout of Object.values(exitTimerByTabIdRef.current)) {
        window.clearTimeout(timeout);
      }
      enterTimerByTabIdRef.current = {};
      exitTimerByTabIdRef.current = {};
      for (const animation of Object.values(reorderAnimationByTabIdRef.current)) {
        animation?.cancel();
      }
      reorderAnimationByTabIdRef.current = {};

      const immediate: RenderedTabState[] = tabs.map((tab, index) => ({
        tab,
        phase: 'stable',
        lastKnownIndex: index,
      }));
      renderedTabsRef.current = immediate;
      setRenderedTabs(immediate);
      return;
    }

    const previous = renderedTabsRef.current;
    const previousById = new Map(previous.map((item) => [item.tab.id, item]));
    const nextById = new Map(tabs.map((tab) => [tab.id, tab]));
    const enteringIds: string[] = [];
    const removed: RenderedTabState[] = [];

    const next: RenderedTabState[] = tabs.map((tab, index) => {
      const existing = previousById.get(tab.id);
      if (!existing) {
        enteringIds.push(tab.id);
        return { tab, phase: 'entering', lastKnownIndex: index };
      }
      if (existing.phase === 'entering') enteringIds.push(tab.id);
      return {
        tab,
        phase: existing.phase === 'exiting' ? 'stable' : existing.phase,
        lastKnownIndex: index,
      };
    });

    for (const item of previous) {
      if (!nextById.has(item.tab.id)) {
        removed.push(item);
      }
    }

    removed
      .sort((a, b) => a.lastKnownIndex - b.lastKnownIndex)
      .forEach((item, offset) => {
        const insertAt = Math.min(item.lastKnownIndex + offset, next.length);
        next.splice(insertAt, 0, {
          tab: item.tab,
          phase: 'exiting',
          lastKnownIndex: item.lastKnownIndex,
        });
      });

    for (const tab of tabs) {
      const id = tab.id;
      const exitTimer = exitTimerByTabIdRef.current[id];
      if (exitTimer) {
        window.clearTimeout(exitTimer);
        delete exitTimerByTabIdRef.current[id];
      }
    }

    for (const id of enteringIds) {
      const existingTimer = enterTimerByTabIdRef.current[id];
      if (existingTimer) continue;
      enterTimerByTabIdRef.current[id] = window.setTimeout(() => {
        const settled = renderedTabsRef.current.map((item) =>
          item.tab.id === id && item.phase === 'entering'
            ? { ...item, phase: 'stable' as const }
            : item,
        );
        renderedTabsRef.current = settled;
        setRenderedTabs(settled);
        delete enterTimerByTabIdRef.current[id];
      }, TAB_APPEAR_SETTLE_MS);
    }

    for (const item of removed) {
      const id = item.tab.id;
      const existingTimer = exitTimerByTabIdRef.current[id];
      if (existingTimer) continue;
      exitTimerByTabIdRef.current[id] = window.setTimeout(() => {
        const remaining = renderedTabsRef.current.filter((entry) => entry.tab.id !== id);
        renderedTabsRef.current = remaining;
        setRenderedTabs(remaining);
        delete exitTimerByTabIdRef.current[id];
      }, TAB_ENTER_EXIT_DURATION_MS + 34);
    }

    renderedTabsRef.current = next;
    setRenderedTabs(next);
  }, [tabs, animationsEnabled]);

  useEffect(() => {
    const syncSettings = () => {
      const settings = getBrowserSettings();
      setNativeContextMenusEnabled(settings.nativeTextFieldContextMenu);
      setAnimationsEnabled(settings.animationsEnabled);
      setTabStripPosition(settings.tabStripPosition ?? 'top');
    };
    syncSettings();
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
    return () => window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateOverflowHints = () => {
      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      setCanScrollLeft(el.scrollLeft > 1);
      setCanScrollRight(maxScrollLeft - el.scrollLeft > 1);
    };

    updateOverflowHints();
    const observer = new ResizeObserver(updateOverflowHints);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    el.addEventListener('scroll', updateOverflowHints, { passive: true });
    window.addEventListener('resize', updateOverflowHints);
    const rafId = window.requestAnimationFrame(updateOverflowHints);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(rafId);
      el.removeEventListener('scroll', updateOverflowHints);
      window.removeEventListener('resize', updateOverflowHints);
    };
  }, [renderedTabs, orientation]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || orientation === 'vertical') return;
    let frame = 0;
    let target = el.scrollLeft;
    let lastTime = 0;
    let direction = 0;
    const cancel = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      direction = 0;
      target = el.scrollLeft;
    };
    const tick = (time: number) => {
      const elapsed = Math.min(time - lastTime, 32);
      lastTime = time;
      target = Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth));
      const remaining = target - el.scrollLeft;
      if (Math.abs(remaining) <= 1) {
        el.scrollLeft = target;
        frame = 0;
        direction = 0;
        return;
      }
      el.scrollLeft += remaining * (1 - Math.exp(-elapsed / 40));
      frame = window.requestAnimationFrame(tick);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || el.scrollWidth <= el.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const precise = event.deltaMode === 0 && (Math.abs(event.deltaX) > Math.abs(event.deltaY) || Math.abs(delta) < 50);
      if (precise) {
        cancel();
        el.scrollLeft += delta;
        return;
      }
      const tabWidth = Array.from(el.querySelectorAll('.theme-tab:not([data-pinned="true"])'))
        .map((tab) => tab.getBoundingClientRect().width).find((width) => width > 1) ?? 100;
      const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? el.clientWidth : 1;
      const step = Math.sign(delta) * Math.min(Math.abs(delta * unit) * 0.7, tabWidth * 0.7, 96);
      if (!animationsEnabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        cancel();
        el.scrollLeft += step;
        return;
      }
      // Drop queued movement on reversal so the strip immediately follows the wheel.
      if (!frame || direction !== Math.sign(delta)) target = el.scrollLeft;
      direction = Math.sign(delta);
      const maxAhead = tabWidth * 1.4;
      target = Math.max(0, Math.min(el.scrollWidth - el.clientWidth,
        Math.max(el.scrollLeft - maxAhead, Math.min(el.scrollLeft + maxAhead, target + step))));
      if (!frame) {
        lastTime = performance.now();
        frame = window.requestAnimationFrame(tick);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', cancel);
    return () => {
      cancel();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', cancel);
    };
  }, [orientation, animationsEnabled, tabs.length]);

  useEffect(() => {
    const previousCount = prevTabCountRef.current;
    prevTabCountRef.current = tabs.length;
    if (tabs.length <= previousCount) return;

    const el = scrollRef.current;
    if (!el) return;
    const isVertical = orientation === 'vertical';
    if (isVertical) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollLeft = el.scrollWidth;
    }
  }, [tabs.length, orientation]);

  useEffect(() => {
    if (!tabMenuState) return;
    const tabStillExists = tabs.some((tab) => tab.id === tabMenuState.tabId);
    if (tabStillExists) return;
    setTabMenuState(null);
  }, [tabs, tabMenuState]);

  const closeTabMenu = useCallback(() => {
    setTabMenuState(null);
  }, []);

  const tabMenuEntries = useMemo<ContextMenuEntry[]>(() => {
    if (!tabMenuState) return [];

    const tabIndex = tabs.findIndex((tab) => tab.id === tabMenuState.tabId);
    const hasTabsToRight = tabIndex >= 0 && tabs.slice(tabIndex + 1).some(tab => !tab.isPinned);
    const hasOtherTabs = tabs.some(tab => tab.id !== tabMenuState?.tabId && !tab.isPinned);
    const isVertical = orientation === 'vertical';

    return [
      {
        type: 'item',
        label: isVertical ? 'New Tab Below' : 'New Tab to Right',
        onSelect: () => newTabToRight(tabMenuState.tabId),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Reload',
        shortcut: `${primaryShortcutLabel}+R`,
        onSelect: () => reloadTab(tabMenuState.tabId),
      },
      {
        type: 'item',
        label: 'Duplicate',
        onSelect: () => duplicateTab(tabMenuState.tabId),
      },
      {
        type: 'item',
        label: tabs[tabIndex]?.isPinned ? 'Unpin Tab' : 'Pin Tab',
        onSelect: () => toggleTabPinned(tabMenuState.tabId),
      },
      { type: 'separator' },
      { type: 'item', label: 'New Tab Group', onSelect: () => { void createTabGroup(tabMenuState.tabId); } },
      ...groups.filter(group => group.id !== tabs[tabIndex]?.group?.id).map(group => ({
        type: 'item' as const, label: `Move to ${group.name || 'unnamed group'}`, onSelect: () => moveTabToGroup(tabMenuState.tabId, group.id),
      })),
      ...(tabs[tabIndex]?.group ? [{ type: 'item' as const, label: 'Remove from Group', onSelect: () => moveTabToGroup(tabMenuState.tabId) }] : []),
      { type: 'separator' },
      {
        type: 'item',
        label: 'Close',
        shortcut: `${primaryShortcutLabel}+W`,
        onSelect: () => closeTab(tabMenuState.tabId),
      },
      {
        type: 'item',
        label: 'Close Others',
        disabled: !hasOtherTabs,
        onSelect: () => closeOtherTabs(tabMenuState.tabId),
      },
      {
        type: 'item',
        label: isVertical ? 'Close Below' : 'Close to Right',
        disabled: !hasTabsToRight,
        onSelect: () => closeTabsToRight(tabMenuState.tabId),
      },
    ];
  }, [
    tabMenuState,
    tabs,
    orientation,
    newTabToRight,
    reloadTab,
    duplicateTab,
    toggleTabPinned,
    createTabGroup,
    moveTabToGroup,
    groups,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    primaryShortcutLabel,
  ]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const onNativeContextCommand = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || !payload) return;
      const candidate = payload as { command?: unknown; tabId?: unknown };
      const command = typeof candidate.command === 'string' ? candidate.command.trim() : '';
      const tabId = typeof candidate.tabId === 'string' ? candidate.tabId.trim() : '';
      if (!command || !tabId) return;

      const dedupeSignature = `${command}|${tabId}`;
      const now = Date.now();
      const previous = lastNativeTabCommandRef.current;
      if (previous && previous.signature === dedupeSignature && now - previous.at < 250) {
        return;
      }
      lastNativeTabCommandRef.current = {
        signature: dedupeSignature,
        at: now,
      };

      if (command === 'new-tab-to-right') {
        newTabToRight(tabId);
        return;
      }
      if (command === 'group-new') { void createTabGroup(tabId); return; }
      if (command === 'group-remove') { moveTabToGroup(tabId); return; }
      if (command.startsWith('group-add:')) { moveTabToGroup(tabId, command.slice(10)); return; }
      if (command === 'toggle-pin') {
        toggleTabPinned(tabId);
        return;
      }
      if (command === 'reload') {
        reloadTab(tabId);
        return;
      }
      if (command === 'duplicate') {
        duplicateTab(tabId);
        return;
      }
      if (command === 'close') {
        closeTab(tabId);
        return;
      }
      if (command === 'close-others') {
        closeOtherTabs(tabId);
        return;
      }
      if (command === 'close-to-right') {
        closeTabsToRight(tabId);
      }
    };

    ipc.on('tab-native-context-command', onNativeContextCommand);
    return () => ipc.off('tab-native-context-command', onNativeContextCommand);
  }, [newTabToRight, reloadTab, duplicateTab, toggleTabPinned, createTabGroup, moveTabToGroup, closeTab, closeOtherTabs, closeTabsToRight, orientation]);

  useEffect(() => {
    if (!draggingTabId) return;
    let didEndDrag = false;
    let lastPointer = orientation === 'vertical'
      ? (originalTabPosition?.y ?? 0) + dragPointerToTopRef.current
      : (originalTabPosition?.x ?? 0) + dragPointerToLeftRef.current;

    const endDrag = () => {
      if (didEndDrag) return;
      didEndDrag = true;

      const moved = dragMovedRef.current;
      const shouldRefreshDragRegions = moved || dragDetachedRef.current;
      const wasDetached = dragDetachedRef.current;
      const draggedTabId = draggingTabId;
      if (dragDetachedRef.current) {
        void electron?.ipcRenderer?.invoke('window-release-detached-tab-drag').catch(() => undefined);
      }

      releasedDragTabIdRef.current = draggedTabId;
      if (moved && !wasDetached) {
        suppressReleasedTabTransition(draggedTabId);
      }
      setDraggingTabId(null);
      setDraggedTabPosition(null);
      setOriginalTabPosition(null);
      setDraggedTabWidth(null);
      setDraggedTabHeight(null);
      lastSwapEdgeXRef.current = null;
      lastSwapEdgeYRef.current = null;
      lastSwapAtRef.current = 0;
      dragMovedRef.current = false;
      dragDetachedRef.current = false;
      setDragUsesNativeWindow(false);
      if (moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      if (shouldRefreshDragRegions) {
        if (wasDetached) {
          scheduleDragRegionRefresh(34);
        } else {
          scheduleDragRegionRefresh(TAB_REORDER_ANIMATION_MS + 34);
        }
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      if ((event.buttons & 1) === 0) {
        endDrag();
        return;
      }

      const currentTabs = tabsRef.current.filter(tab => !tab.group?.collapsed || tab.id === draggingTabId);
      if (!draggingTabId) return;

      const isVertical = orientation === 'vertical';
      const pointerPrimary = isVertical ? event.clientY : event.clientX;
      const direction = Math.sign(pointerPrimary - lastPointer);
      lastPointer = pointerPrimary;
      const draggedEl = tabElementRefs.current[draggingTabId];
      const containerRect = scrollRef.current?.getBoundingClientRect();
      const draggedRect = draggedEl?.getBoundingClientRect();
      const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

      // Accumulate movement from the press so slow drags also cross the threshold.
      const startX = (originalTabPosition?.x ?? event.clientX) + dragPointerToLeftRef.current;
      const startY = (originalTabPosition?.y ?? event.clientY) + dragPointerToTopRef.current;
      if (dragMovedRef.current || Math.hypot(event.clientX - startX, event.clientY - startY) >= 4) {
        dragMovedRef.current = true;
        if (!dragDetachedRef.current) {
          const outsideX = containerRect
            ? getOutsideDistance(event.clientX, containerRect.left, containerRect.right)
            : 0;
          const outsideY = containerRect
            ? getOutsideDistance(event.clientY, containerRect.top, containerRect.bottom)
            : 0;
          if (Math.max(outsideX, outsideY) >= TAB_DETACH_THRESHOLD_PX) {
            dragDetachedRef.current = true;
            setDragUsesNativeWindow(true);
            moveTabToNewWindow(
              draggingTabId,
              {
                screenX: event.screenX,
                screenY: event.screenY,
              },
              {
                dragMode: true,
                pointerOffsetX: dragPointerToLeftRef.current,
                pointerOffsetY: dragPointerToTopRef.current,
              },
            );
          }
        }

        if (dragDetachedRef.current) {
          return;
        }

        if (isVertical) {
          let nextY = event.clientY;
          if (containerRect && draggedRect) {
            const minY = containerRect.top + dragPointerToTopRef.current;
            const maxY = containerRect.bottom - (draggedRect.height - dragPointerToTopRef.current);
            nextY = clamp(nextY, minY, maxY);
          }
          setDraggedTabPosition({ x: 0, y: nextY });
        } else {
          let nextX = event.clientX;
          if (containerRect && draggedRect) {
            const minX = containerRect.left + dragPointerToLeftRef.current;
            const maxX = containerRect.right - (draggedRect.width - dragPointerToLeftRef.current);
            nextX = clamp(nextX, minX, maxX);
          }
          setDraggedTabPosition({ x: nextX, y: 0 });
        }
      }

      if (dragDetachedRef.current) {
        return;
      }

      if (!dragMovedRef.current) return;
      const currentIndex = currentTabs.findIndex((tab) => tab.id === draggingTabId);
      if (currentIndex === -1) return;
      const now = Date.now();
      if (now - lastSwapAtRef.current < TAB_SWAP_COOLDOWN_MS) return;

      const draggedTab = currentTabs[currentIndex];
      const previewStart = pointerPrimary - (isVertical ? dragPointerToTopRef.current : dragPointerToLeftRef.current);
      const previewEnd = previewStart + (isVertical ? draggedRect?.height ?? 0 : draggedRect?.width ?? 0);
      const getGroupBounds = (groupId: string) => {
        const header = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-tab-group]') ?? [])]
          .find(element => element.dataset.tabGroup === groupId);
        const members = tabsRef.current.filter(tab => tab.group?.id === groupId)
          .flatMap(tab => tabElementRefs.current[tab.id] ? [tabElementRefs.current[tab.id]!] : []);
        const rects = (header ? [header, ...members] : members).flatMap(element => {
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0.5 || rect.height <= 0.5) return [];
          const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
          return [{ start: isVertical ? rect.top - transform.m42 : rect.left - transform.m41,
            end: isVertical ? rect.bottom - transform.m42 : rect.right - transform.m41 }];
        });
        return rects.length ? { start: Math.min(...rects.map(rect => rect.start)), end: Math.max(...rects.map(rect => rect.end)) } : undefined;
      };
      if (draggedTab.group) {
        const bounds = getGroupBounds(draggedTab.group.id);
        const side = bounds && (direction < 0 && previewStart < bounds.start - TAB_GROUP_EXIT_DISTANCE_PX ? 'before'
          : direction > 0 && previewEnd > bounds.end + TAB_GROUP_EXIT_DISTANCE_PX ? 'after' : undefined);
        if (side) {
          moveTabToGroup(draggingTabId, undefined, side);
          lastSwapAtRef.current = now;
          return;
        }
      }
      const fullIndex = tabsRef.current.findIndex(tab => tab.id === draggingTabId);
      const neighbor = direction ? tabsRef.current[fullIndex + direction] : undefined;
      if (neighbor?.group && neighbor.group.id !== draggedTab.group?.id) {
        const bounds = getGroupBounds(neighbor.group.id);
        const entering = bounds && (direction > 0
          ? previewEnd > bounds.start + TAB_GROUP_ENTRY_DISTANCE_PX && previewStart < bounds.end
          : previewStart < bounds.end - TAB_GROUP_ENTRY_DISTANCE_PX && previewEnd > bounds.start);
        if (entering) {
          moveTabToGroup(draggingTabId, neighbor.group.id);
          lastSwapAtRef.current = now;
          return;
        }
      }
      const pinnedTabs = currentTabs.filter(tab => tab.isPinned);
      const lastPinned = pinnedTabs.at(-1);
      const pinnedRect = lastPinned ? tabElementRefs.current[lastPinned.id]?.getBoundingClientRect() : undefined;
      const groupEnd = isVertical ? pinnedRect?.bottom : pinnedRect?.right;
      const pointer = isVertical ? event.clientY : event.clientX;
      if (draggedTab.isPinned && groupEnd !== undefined && pointer > groupEnd + (isVertical ? 12 : 24)) {
        moveTabToIndex(draggingTabId, pinnedTabs.length - 1, { isPinned: false });
        lastSwapAtRef.current = now;
        return;
      }
      const groupStart = containerRect ? (isVertical ? containerRect.top : containerRect.left) : undefined;
      const pinThreshold = groupEnd !== undefined ? groupEnd - 12 : groupStart !== undefined ? groupStart + 18 : undefined;
      if (!draggedTab.isPinned && pinThreshold !== undefined && pointer < pinThreshold) {
        moveTabToIndex(draggingTabId, pinnedTabs.length, { isPinned: true });
        lastSwapAtRef.current = now;
        return;
      }

      if (!direction) return;
      const after = direction > 0;
      const targetTab = currentTabs[currentIndex + (after ? 1 : -1)];
      const targetElement = targetTab && tabElementRefs.current[targetTab.id];
      if (!targetTab || !targetElement || !!targetTab.isPinned !== !!draggedTab.isPinned) return;
      // Group membership uses its own entry/exit thresholds above.
      if (targetTab.group?.id !== draggedTab.group?.id) return;
      const targetRect = targetElement.getBoundingClientRect();
      const transform = new DOMMatrixReadOnly(getComputedStyle(targetElement).transform);
      const targetStart = isVertical ? targetRect.top - transform.m42 : targetRect.left - transform.m41;
      const targetSize = isVertical ? targetRect.height : targetRect.width;
      const trigger = targetStart + targetSize * (after ? TAB_SWAP_TRIGGER_RATIO : 1 - TAB_SWAP_TRIGGER_RATIO);
      const leadingEdge = after ? previewEnd : previewStart;
      const previousEdge = isVertical ? lastSwapEdgeYRef.current : lastSwapEdgeXRef.current;
      const canSwap = previousEdge === null || Math.abs(leadingEdge - previousEdge) >= TAB_SWAP_MIN_EDGE_DELTA_PX;
      if ((after ? leadingEdge > trigger : leadingEdge < trigger) && canSwap) {
        moveTabToIndex(draggingTabId, tabsRef.current.findIndex(tab => tab.id === targetTab.id));
        if (isVertical) lastSwapEdgeYRef.current = leadingEdge;
        else lastSwapEdgeXRef.current = leadingEdge;
        lastSwapAtRef.current = now;
      }

    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
    document.addEventListener('mouseup', endDrag, true);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('blur', endDrag);
      document.removeEventListener('mouseup', endDrag, true);
    };
  }, [
    draggingTabId,
    moveTabToIndex,
    moveTabToNewWindow,
    moveTabToGroup,
    orientation,
    originalTabPosition,
    scheduleDragRegionRefresh,
    suppressReleasedTabTransition,
  ]);

  // Follow the real tab through its pin/unpin width animation while dragging.
  useLayoutEffect(() => {
    if (!draggingTabId) return;
    const element = tabElementRefs.current[draggingTabId];
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = rect.width;
      if (width <= 0) return;
      setDraggedTabHeight(current => current !== null && Math.abs(current - rect.height) < 0.5 ? current : rect.height);
      dragPointerToLeftRef.current = dragPointerWidthRatioRef.current * width;
      setDraggedTabWidth(current => current !== null && Math.abs(current - width) < 0.5 ? current : width);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [draggingTabId]);

  // Add a small delay when orientation changes to ensure proper cleanup
  useEffect(() => {
    // Reset any drag state when orientation changes
    setDraggingTabId(null);
    setDraggedTabPosition(null);
    setOriginalTabPosition(null);
    setDraggedTabWidth(null); // Clear dragged tab size on orientation change
    setDraggedTabHeight(null);
    setDragUsesNativeWindow(false);
    dragDetachedRef.current = false;
    cancelScheduledDragRegionRefresh();
    cancelScheduledTransitionSuppression();
    // Set the settle time to prevent rapid setActive calls during remount
    orientationSettleUntilRef.current = Date.now() + ORIENTATION_CHANGE_SETTLE_MS;
  }, [orientation, cancelScheduledDragRegionRefresh, cancelScheduledTransitionSuppression]);

  useLayoutEffect(() => {
    const nextRects: Record<string, DOMRect> = {};
    const nextOrder = renderedTabs.map((item) => item.tab.id);
    const previousOrder = previousLayoutOrderRef.current;
    const nextIds = new Set(nextOrder);
    const previousIds = new Set(previousOrder);
    const previousSurvivors = previousOrder.filter((id) => nextIds.has(id));
    const nextSurvivors = nextOrder.filter((id) => previousIds.has(id));
    const orderChanged = nextSurvivors.some((id, index) => id !== previousSurvivors[index]);
    previousLayoutOrderRef.current = nextOrder;
    const membership = new Map(renderedTabs.map(({ tab }) => [tab.id, tab.group?.id]));
    // Entering/exiting tabs already move their neighbors through size transitions.
    // Only surviving tabs changing groups should trigger another position animation.
    const membershipChanged = renderedTabs.some(({ tab }) =>
      previousGroupMembershipRef.current.has(tab.id)
      && previousGroupMembershipRef.current.get(tab.id) !== tab.group?.id,
    );
    previousGroupMembershipRef.current = membership;
    const releasedDragTabId = releasedDragTabIdRef.current;
    const isVertical = orientation === 'vertical';
    const layoutItems = [
      ...renderedTabs.map(({ tab }) => ({
        id: tab.id,
        element: tabElementRefs.current[tab.id],
        dragged: tab.id === draggingTabId || (!!draggingGroupId && tab.group?.id === draggingGroupId),
      })),
      ...Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-tab-group]') ?? []).map(element => ({
        id: `group:${element.dataset.tabGroup}`,
        element,
        dragged: element.dataset.tabGroup === draggingGroupId,
      })),
    ];

    if (animationsEnabled) {
      for (const item of layoutItems) {
        // Ensure measurements use layout positions, not in-flight transforms.
        const animation = reorderAnimationByTabIdRef.current[item.id];
        if (animation) {
          animation.cancel();
          delete reorderAnimationByTabIdRef.current[item.id];
        }
      }
    }

    for (const item of layoutItems) {
      const tabId = item.id;
      const el = item.element;
      if (!el) continue;
      const nextRect = el.getBoundingClientRect();
      const prevRect = previousRectsRef.current[tabId];
      if (item.dragged) {
        // Keep the pre-drag baseline rect so the drop doesn't animate from transformed geometry.
        if (prevRect) {
          nextRects[tabId] = prevRect;
        } else {
          nextRects[tabId] = nextRect;
        }
        continue;
      }
      nextRects[tabId] = nextRect;
      // Branding/resizing can move the whole strip. Do not replay that movement
      // as a tab reorder when metadata updates after the layout has settled.
      if (!orderChanged && !membershipChanged) continue;
      if (!prevRect) continue;
      if (tabId === releasedDragTabId) continue;
      const delta = isVertical ? prevRect.top - nextRect.top : prevRect.left - nextRect.left;
      if (Math.abs(delta) < 2) continue;
      if (!animationsEnabled) continue;

      const deltaAbs = Math.abs(delta);
      // Loosen thresholds while dragging so surrounding tabs animate during swaps.
      const isDeliberateReorder = draggingGroupId || membershipChanged ? deltaAbs > 2 : draggingTabId
        ? deltaAbs > 4 && deltaAbs < 600
        : deltaAbs > 10 && deltaAbs < 200;
      if (!isDeliberateReorder) continue;

      // Prevent direction glitches by dropping any previous in-flight transform animations.
      const existingAnimation = reorderAnimationByTabIdRef.current[tabId];
      if (existingAnimation) {
        existingAnimation.cancel();
        delete reorderAnimationByTabIdRef.current[tabId];
      }

      const animation = el.animate(
        [
          { transform: isVertical ? `translateY(${delta}px)` : `translateX(${delta}px)` },
          { transform: isVertical ? 'translateY(0px)' : 'translateX(0px)' },
        ],
        {
          duration: TAB_REORDER_ANIMATION_MS,
          easing: TAB_REORDER_EASING,
        },
      );
      reorderAnimationByTabIdRef.current[tabId] = animation;
      const clearTrackedAnimation = () => {
        if (reorderAnimationByTabIdRef.current[tabId] === animation) {
          delete reorderAnimationByTabIdRef.current[tabId];
        }
      };
      animation.onfinish = clearTrackedAnimation;
      animation.oncancel = clearTrackedAnimation;
    }
    previousRectsRef.current = nextRects;
    if (releasedDragTabId) {
      releasedDragTabIdRef.current = null;
    }
  }, [renderedTabs, draggingTabId, draggingGroupId, animationsEnabled, orientation]);

  useEffect(() => {
    if (dragRegionsTemporarilyDisabled) return;
    dragRegionBaselineRafRef.current = window.requestAnimationFrame(() => {
      dragRegionBaselineRafRef.current = null;
      const nextRects: Record<string, DOMRect> = {};
      for (const item of renderedTabsRef.current) {
        const el = tabElementRefs.current[item.tab.id];
        if (!el) continue;
        nextRects[item.tab.id] = el.getBoundingClientRect();
      }
      for (const header of scrollRef.current?.querySelectorAll<HTMLElement>('[data-tab-group]') ?? []) {
        nextRects[`group:${header.dataset.tabGroup}`] = header.getBoundingClientRect();
      }
      previousRectsRef.current = nextRects;
    });
    return () => {
      if (dragRegionBaselineRafRef.current !== null) {
        window.cancelAnimationFrame(dragRegionBaselineRafRef.current);
        dragRegionBaselineRafRef.current = null;
      }
    };
  }, [dragRegionsTemporarilyDisabled, orientation]);

  const isVertical = orientation === 'vertical';
  const getGroupElements = useCallback((id: string) => {
    const header = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-tab-group]') ?? [])]
      .find(element => element.dataset.tabGroup === id);
    const members = tabsRef.current.filter(tab => tab.group?.id === id)
      .flatMap(tab => tabElementRefs.current[tab.id] ? [tabElementRefs.current[tab.id]!] : []);
    return header ? [header, ...members] : members;
  }, []);

  useLayoutEffect(() => {
    if (!draggingGroupId || !groupDragPointer || !groupDragRef.current?.moved) return;
    const elements = getGroupElements(draggingGroupId);
    for (const element of elements) { element.style.transform = ''; element.classList.add('tab-group-is-dragging'); }
    const rects = elements.map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0.5 && rect.height > 0.5);
    if (!rects.length) return;
    const vertical = orientation === 'vertical';
    const start = Math.min(...rects.map(rect => vertical ? rect.top : rect.left));
    const pointer = vertical ? groupDragPointer.y : groupDragPointer.x;
    const delta = pointer - groupDragRef.current.anchor - start;
    for (const element of elements) element.style.transform = vertical ? `translateY(${delta}px)` : `translateX(${delta}px)`;
  }, [draggingGroupId, groupDragPointer, renderedTabs, orientation, getGroupElements]);

  useEffect(() => {
    if (!draggingGroupId) return;
    const finish = () => {
      const moved = groupDragRef.current?.moved;
      for (const element of getGroupElements(draggingGroupId)) {
        element.style.transform = ''; element.classList.remove('tab-group-is-dragging');
      }
      groupDragRef.current = null;
      setDraggingGroupId(null); setGroupDragPointer(null);
      if (moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        scheduleDragRegionRefresh(34);
      }
    };
    const move = (event: MouseEvent) => {
      if (!(event.buttons & 1)) { finish(); return; }
      const drag = groupDragRef.current;
      if (!drag) return;
      const vertical = orientation === 'vertical';
      const pointer = vertical ? event.clientY : event.clientX;
      const direction = Math.sign(pointer - drag.lastPointer);
      drag.lastPointer = pointer;
      if (!drag.moved && Math.abs(pointer - drag.start) < 4) return;
      drag.moved = true;
      setGroupDragPointer({ x: event.clientX, y: event.clientY });
      const now = Date.now();
      if (now - drag.lastSwap < TAB_SWAP_COOLDOWN_MS) return;
      if (!direction) return;
      const draggedRects = getGroupElements(draggingGroupId).map(element => element.getBoundingClientRect())
        .filter(rect => rect.width > 0.5 && rect.height > 0.5);
      if (!draggedRects.length) return;
      const span = Math.max(...draggedRects.map(rect => vertical ? rect.bottom : rect.right))
        - Math.min(...draggedRects.map(rect => vertical ? rect.top : rect.left));
      const leadingEdge = pointer - drag.anchor + (direction > 0 ? span : 0);
      const units: Array<{ id: string; groupId?: string; pinned?: boolean }> = [];
      const seen = new Set<string>();
      for (const tab of tabsRef.current) {
        if (tab.group && seen.has(tab.group.id)) continue;
        if (tab.group) seen.add(tab.group.id);
        units.push({ id: tab.id, groupId: tab.group?.id, pinned: tab.isPinned });
      }
      const index = units.findIndex(unit => unit.groupId === draggingGroupId);
      for (const [unit, after] of [[units[index - 1], false], [units[index + 1], true]] as const) {
        if (after !== (direction > 0)) continue;
        if (!unit || unit.pinned) continue;
        const elements = unit.groupId ? getGroupElements(unit.groupId) : [tabElementRefs.current[unit.id]].filter((element): element is HTMLDivElement => !!element);
        const rects = elements.map(element => {
          const rect = element.getBoundingClientRect();
          // Hit-test the destination layout rather than its sliding animation.
          const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
          return new DOMRect(rect.x - transform.m41, rect.y - transform.m42, rect.width, rect.height);
        }).filter(rect => rect.width > 0.5 && rect.height > 0.5);
        if (!rects.length) continue;
        const start = Math.min(...rects.map(rect => vertical ? rect.top : rect.left));
        const end = Math.max(...rects.map(rect => vertical ? rect.bottom : rect.right));
        if (after ? leadingEdge > (start + end) / 2 : leadingEdge < (start + end) / 2) {
          moveTabGroup(draggingGroupId, unit.id, after); drag.lastSwap = now; return;
        }
      }
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', finish);
    window.addEventListener('blur', finish);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', finish);
      window.removeEventListener('blur', finish); window.removeEventListener('keydown', escape, true);
    };
  }, [draggingGroupId, orientation, getGroupElements, moveTabGroup, scheduleDragRegionRefresh]);

  const isActivelyDragging = (draggingTabId !== null && draggedTabPosition !== null) || draggingGroupId !== null;
  const isRightSidebar = isVertical && tabStripPosition === 'right';
  const tabRadius = 'var(--layoutTabRadius, 10px)';
  const borderWidth = 'var(--layoutBorderWidth, 1px)';
  // Extend the scroll viewport left so the curve fits without shifting the tabs right.
  const horizontalCurveBleed = `calc(${tabRadius} + ${borderWidth} + 4px)`;
  const horizontalTabInset = `calc(${horizontalCurveBleed} + 2px)`;

  return (
    <div
      className={[
        isActivelyDragging ? 'tab-bar-dragging' : '',
        animationsEnabled ? 'tab-animations-enabled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        display: 'flex',
        flexDirection: isVertical ? 'column' : 'row',
        gap: TAB_STRIP_GAP,
        padding: 0,
        alignItems: isVertical ? 'stretch' : 'center',
        minWidth: 0,
        flex: 1,
        width: '100%',
        height: isVertical ? '100%' : undefined,
        WebkitAppRegion: dragRegionsTemporarilyDisabled ? 'no-drag' : 'drag',
        userSelect: isActivelyDragging ? 'none' : 'auto', // Prevent text selection during drag
        ['--tabEnterExitMs' as string]: `${TAB_ENTER_EXIT_DURATION_MS}ms`,
        ['--tabOpacityMs' as string]: `${Math.floor(TAB_ENTER_EXIT_DURATION_MS * 0.7)}ms`,
        ['--tabHeightMs' as string]: isVertical ? `${TAB_ENTER_EXIT_DURATION_MS}ms` : '0ms',
        ['--tabGapMarginMs' as string]: isVertical ? '0ms' : `${TAB_ENTER_EXIT_DURATION_MS}ms`,
      } as CSSProperties}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
          height: isVertical ? undefined : '100%',
        }}
      >
        <div
          ref={scrollRef}
          className="tab-strip-scroll"
          style={{
            display: 'flex',
            flexDirection: isVertical ? 'column' : 'row',
            gap: TAB_STRIP_GAP,
            overflowX: isVertical ? 'hidden' : 'auto',
            overflowY: isVertical ? 'auto' : 'hidden',
            alignItems: isVertical ? 'stretch' : 'center',
            height: isVertical ? '100%' : 'calc(100% + 1px)',
            boxSizing: 'border-box',
            WebkitAppRegion: !isVertical && (canScrollLeft || canScrollRight)
              ? 'no-drag'
              : dragRegionsTemporarilyDisabled ? 'no-drag' : 'drag',
            marginLeft: isVertical ? undefined : `calc(-1 * ${horizontalCurveBleed} - 2px)`,
            padding: isVertical ? 6 : `0 4px 0 ${horizontalTabInset}`,
            paddingBottom: isVertical ? 6 : 1,
          }}
        >
          {renderedTabs.flatMap(({ tab, phase }, index) => {
            const displayFavicon = getDisplayFavicon(tab.url, tab.favicon, tab.restoreDeferred);
            const displayTitle = getDisplayTitle(tab.url, tab.title);
            const audio = tabAudioState[tab.id];
            const showAudio = audio?.audible || audio?.muted;
            const isInternalTab = tab.url.startsWith('mira://');
            const faviconSize = isInternalTab ? 22 : 16;
            const isExiting = phase === 'exiting';
            const isCollapsed = phase !== 'stable';
            const pinnedIndex = renderedTabs.findIndex(item => item.tab.id === tab.id);
            const group = tab.isPinned ? undefined : tab.group;
            const groupStart = group && renderedTabs.findIndex(item => item.tab.group?.id === group.id) === index;
            const groupColor = group && TAB_GROUP_COLORS[group.color];
            const groupCollapsed = group?.collapsed === true;
            const sizeCollapsed = isCollapsed || groupCollapsed;
            const isActive = tab.id === activeId;
            const activeOutlineColor = !isVertical && groupColor ? groupColor : 'var(--surfaceBorder, var(--tabBorder))';
            const groupCount = group ? tabs.filter(tab => tab.group?.id === group.id).length : 0;

            return [
              groupStart ? <button
                key={`group:${group.id}`}
                type="button"
                data-tab-group={group.id}
                title={`${group.name || 'Unnamed group'} - ${groupCount} ${groupCount === 1 ? 'tab' : 'tabs'}`}
                aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} ${group.name || 'unnamed group'}`}
                aria-expanded={!group.collapsed}
                className={`theme-btn tab-group-header${isVertical ? ' tab-group-header-vertical' : ''}`}
                style={{ backgroundColor: groupColor, minWidth: group.name ? undefined : 20, maxWidth: isVertical ? '100%' : 150, alignSelf: isVertical ? 'stretch' : undefined, flexShrink: 0 }}
                onClick={() => { if (!suppressClickRef.current) updateTabGroup(group.id, { collapsed: !group.collapsed }); }}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  cancelScheduledDragRegionRefresh();
                  const elements = getGroupElements(group.id);
                  for (const element of elements) for (const animation of element.getAnimations()) animation.cancel();
                  const rects = elements.map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0.5 && rect.height > 0.5);
                  const pointer = isVertical ? event.clientY : event.clientX;
                  const start = Math.min(...rects.map(rect => isVertical ? rect.top : rect.left));
                  groupDragRef.current = { id: group.id, start: pointer, lastPointer: pointer, anchor: pointer - start, moved: false, lastSwap: 0 };
                  setDraggingGroupId(group.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setTabMenuState(null);
                  if (nativeContextMenusEnabled && electron?.ipcRenderer) {
                    setGroupMenu(null);
                    void electron.ipcRenderer.invoke<string | null>('tab-group-show-native-context-menu', group)
                      .then(command => { if (command) void runGroupCommand(group.id, command); }).catch(() => undefined);
                  } else setGroupMenu({ id: group.id, x: event.clientX, y: event.clientY });
                }}
              >
                {isVertical && <ChevronDown size={12} aria-hidden="true" style={{ flexShrink: 0, order: 1, transform: group.collapsed ? undefined : 'rotate(180deg)' }} />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: isVertical ? 1 : undefined, textAlign: isVertical ? 'left' : undefined }}>{group.name}</span>
              </button> : null,
              <div
                key={tab.id}
                ref={(el) => {
                  tabElementRefs.current[tab.id] = el;
                }}
                data-tab-id={tab.id}
                data-pinned={tab.isPinned ? 'true' : undefined}
                aria-hidden={groupCollapsed || undefined}
                inert={groupCollapsed || undefined}
                title={tab.isPinned ? `Pinned: ${displayTitle}` : undefined}
                onClick={() => {
                  if (isExiting) return;
                  if (suppressClickRef.current) return;
                  const now = Date.now();
                  const settleUntil = orientationSettleUntilRef.current;
                  if (settleUntil > now) {
                    window.setTimeout(() => {
                      setActive(tab.id);
                    }, settleUntil - now);
                  } else {
                    setActive(tab.id);
                  }
                }}
                onMouseDown={(event) => {
                  if (isExiting) return;
                  if (event.button !== 0) return;
                  const eventTarget = event.target as HTMLElement | null;
                  if (eventTarget?.closest('[data-tab-drag-ignore="true"]')) return;
                  cancelScheduledDragRegionRefresh();
                  const targetEl = tabElementRefs.current[tab.id];
                  if (targetEl) {
                    const rect = targetEl.getBoundingClientRect();
                    dragPointerToLeftRef.current = event.clientX - rect.left;
                    dragPointerWidthRatioRef.current = rect.width > 0 ? dragPointerToLeftRef.current / rect.width : 0.5;
                    dragPointerToTopRef.current = event.clientY - rect.top;
                    setOriginalTabPosition({ x: rect.left, y: rect.top, right: rect.right });
                    setDraggedTabWidth(rect.width);
                    setDraggedTabHeight(rect.height);
                  } else {
                    dragPointerToLeftRef.current = 0;
                    dragPointerWidthRatioRef.current = 0.5;
                    dragPointerToTopRef.current = 0;
                    setOriginalTabPosition({ x: event.clientX, y: event.clientY, right: event.clientX });
                  }
                  lastSwapEdgeXRef.current = null;
                  lastSwapEdgeYRef.current = null;
                  lastSwapAtRef.current = 0;
                  dragMovedRef.current = false;
                  dragDetachedRef.current = false;
                  setDragUsesNativeWindow(false);
                  setDraggingTabId(tab.id);
                  // Don't set position yet - wait for mouse movement
                }}
                onContextMenu={(event) => {
                  if (isExiting) return;
                  event.preventDefault();
                  if (nativeContextMenusEnabled && electron?.ipcRenderer) {
                    const tabIndex = tabs.findIndex((entry) => entry.id === tab.id);
                    const hasTabsToRight = tabIndex >= 0 && tabs.slice(tabIndex + 1).some(tab => !tab.isPinned);
                    const hasOtherTabs = tabs.some(entry => entry.id !== tab.id && !entry.isPinned);
                    const isVertical = orientation === 'vertical';
                    setTabMenuState(null);
                    void electron.ipcRenderer
                      .invoke('tab-show-native-context-menu', {
                        tabId: tab.id,
                        x: event.clientX,
                        y: event.clientY,
                        hasTabsToRight,
                        hasOtherTabs,
                        isPinned: tab.isPinned === true,
                        groupId: tab.group?.id,
                        groups: groups.map(({ id, name }) => ({ id, name })),
                        isVertical,
                      })
                      .catch(() => undefined);
                    return;
                  }
                  setTabMenuState({ tabId: tab.id, x: event.clientX, y: event.clientY });
                }}
                className={`theme-tab${group ? ' tab-group-member' : ''} ${tab.id === activeId ? 'theme-tab-selected' : ''}${
                  settledActiveId !== activeId && (tab.id === activeId || tab.id === settledActiveId)
                    ? ' tab-selection-changing' : ''
                }${
                  (isActivelyDragging && draggingTabId === tab.id) || transitionSuppressedTabId === tab.id
                    ? ' tab-is-dragging'
                    : ''
                }`}
                style={{
                  height: isVertical && groupCollapsed ? 0 : !isVertical && isActive
                    ? `calc((100% + ${TAB_ROW_HEIGHT}) / 2)` : TAB_ROW_HEIGHT,
                  alignSelf: !isVertical && isActive ? 'flex-end' : undefined,
                  minHeight: 0,
                  cursor: 'default',
                  WebkitAppRegion: 'no-drag',
                  borderRadius:
                    tab.id === activeId
                      ? isVertical
                        ? isRightSidebar
                          ? `0 ${tabRadius} ${tabRadius} 0`
                          : `${tabRadius} 0 0 ${tabRadius}`
                        : `${tabRadius} ${tabRadius} 0 0`
                      : tabRadius,
                  display: 'flex',
                  gap: 6,
                  alignItems: !isVertical && isActive ? 'flex-start' : 'center',
                  whiteSpace: 'nowrap',
                  flex: isVertical ? '0 0 auto' : groupCollapsed ? '0 1 0px' : tab.isPinned ? '0 0 38px' : `1 1 ${TAB_TARGET_WIDTH}`,
                  minWidth: isVertical ? 0 : sizeCollapsed ? 0 : tab.isPinned ? 38 : TAB_MIN_WIDTH,
                  maxWidth: isVertical ? (isActive ? 'none' : '100%') : sizeCollapsed ? 0 : tab.isPinned ? 38 : TAB_TARGET_WIDTH,
                  overflow: isActive && !sizeCollapsed ? 'visible' : 'hidden',
                  padding: sizeCollapsed ? '0' : tab.isPinned && !isVertical ? '0'
                    : isVertical && isActive ? (isRightSidebar ? '0 6px 0 16px' : '0 12px 0 10px') : '0 6px 0 10px',
                  paddingBottom: 0,
                  justifyContent: tab.isPinned && !isVertical ? 'center' : undefined,
                  position: tab.isPinned ? 'sticky' : 'relative',
                  left: tab.isPinned && !isVertical ? `calc(${horizontalTabInset} + ${pinnedIndex} * (38px + ${TAB_STRIP_GAP}))` : undefined,
                  top: tab.isPinned && isVertical ? `calc(${pinnedIndex} * (${TAB_ROW_HEIGHT} + ${TAB_STRIP_GAP}))` : undefined,
                  marginBottom: isVertical && groupCollapsed ? `calc(-1 * ${TAB_STRIP_GAP})` : 0,
                  marginRight:
                    !isVertical && sizeCollapsed
                      ? `calc(-1 * ${TAB_STRIP_GAP})`
                      : isActive && isVertical && !isRightSidebar
                      ? '-6px'
                      : isVertical && group && isRightSidebar
                      ? '10px'
                      : 0,
                  borderWidth: sizeCollapsed ? 0 : borderWidth,
                  borderTopColor: isActive ? activeOutlineColor : undefined,
                  marginLeft:
                    isActive && isVertical && isRightSidebar
                      ? '-6px'
                      : isVertical && group && !isRightSidebar
                      ? '10px'
                      : 0,
                  background:
                    tab.id === activeId ? 'var(--surfaceBgHover, var(--tabBgHover))' : tab.isPinned ? 'var(--surfaceBg, var(--tabBg))' : undefined,
                  opacity: sizeCollapsed
                    ? 0
                    : draggingTabId === tab.id && draggedTabPosition
                      ? 0  // Completely hide when overlay is visible (actual dragging)
                      : 1,
                  borderBottomColor: isActive
                    ? !isVertical ? 'var(--surfaceBgHover, var(--tabBgHover))' : activeOutlineColor
                    : undefined,
                  borderLeftColor: isActive
                    ? isVertical && isRightSidebar ? 'var(--surfaceBgHover, var(--tabBgHover))' : activeOutlineColor
                    : undefined,
                  borderRightColor: isActive
                    ? isVertical && !isRightSidebar ? 'var(--surfaceBgHover, var(--tabBgHover))' : activeOutlineColor
                    : undefined,
                  pointerEvents:
                    isExiting || groupCollapsed || (isActivelyDragging && tab.id !== draggingTabId) ? 'none' : 'auto',
                  zIndex: isActivelyDragging && draggingTabId === tab.id ? 20 : tab.isPinned ? (tab.id === activeId ? 4 : 3) : tab.id === activeId ? 2 : 1,
                  borderTopStyle: tab.isSleeping ? 'dashed' : undefined,
                  borderTopWidth: sizeCollapsed ? 0 : tab.isSleeping ? borderWidth : undefined,
                }}
              >
                {isActive && !sizeCollapsed && <TabConnection vertical={isVertical} rightSidebar={isRightSidebar} color={!isVertical ? groupColor || undefined : undefined} />}
                <div data-tab-content style={{
                  display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, width: '100%',
                  height: `calc(${TAB_ROW_HEIGHT} - 2 * ${borderWidth})`, flexShrink: 0,
                  justifyContent: tab.isPinned && !isVertical ? 'center' : undefined,
                }}>
                {(!tab.isPinned || isVertical || !showAudio) && <TabFavicon url={tab.url} src={displayFavicon} size={faviconSize} deferred={tab.restoreDeferred} />}
                {(!tab.isPinned || isVertical) && <span
                  title={displayTitle}
                  className="tab-title"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    maskImage: 'linear-gradient(to right, black calc(100% - 10px), transparent 100%)',
                    WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 10px), transparent 100%)',
                  }}
                >
                  {displayTitle}
                </span>}
                {tab.isPinned && isVertical && <Pin size={12} aria-hidden="true" style={{ flexShrink: 0 }} />}
                {showAudio && <button
                  type="button"
                  data-tab-drag-ignore="true"
                  aria-label={audio.muted ? 'Unmute tab' : 'Mute tab'}
                  title={audio.muted ? 'Unmute tab' : 'Mute tab'}
                  aria-pressed={audio.muted}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleTabMuted(tab.id);
                  }}
                  className="theme-btn tab-close-btn"
                  style={{ padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                >
                  {audio.muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
                </button>}
                {!tab.isPinned && <button
                  type="button"
                  data-tab-drag-ignore="true"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="theme-btn tab-close-btn"
                  style={{
                    opacity: 0.8,
                    padding: 2,
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'default',
                    WebkitAppRegion: 'no-drag',
                  }}
                >
                  <X size={14} strokeWidth={2.2} aria-hidden="true" />
                </button>}
                </div>
              </div>,
            ];
          })}
          <button
            onClick={() => newTab()}
            className="theme-btn theme-btn-nav nav-icon-btn tab-new-tab-btn"
            style={{
              height: NEW_TAB_BUTTON_SIZE,
              flex: isVertical
                ? '0 0 auto'
                : 'none',
              width: isVertical
                ? '100%'
                : NEW_TAB_BUTTON_SIZE,
              minWidth: isVertical
                ? 0
                : NEW_TAB_BUTTON_SIZE,
              maxWidth: isVertical
                ? '100%'
                : NEW_TAB_BUTTON_SIZE,
              marginTop: isVertical ? 0 : 1,
              flexShrink: 0,
              borderRadius: isVertical
                ? 'var(--layoutTabRadius, 10px)'
                : '50%',
              WebkitAppRegion: 'no-drag',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
        <TabGroupOutlines scrollRef={scrollRef} tabs={tabs} activeId={activeId} vertical={isVertical} rightSidebar={isRightSidebar} draggingTabId={draggingTabId} draggingGroupId={draggingGroupId} />
        {!isVertical && (
          <>
            {!dragRegionsTemporarilyDisabled && !isActivelyDragging && (
              <div
                aria-hidden="true"
                className="tab-strip-window-drag-edge"
              />
            )}
            <div
              aria-hidden={true}
              className="tab-strip-fade-left"
              style={{ opacity: canScrollLeft ? 1 : 0, left: `calc(${tabs.filter(tab => tab.isPinned).length} * (38px + ${TAB_STRIP_GAP}))` }}
            />
            <div
              aria-hidden={true}
              className="tab-strip-fade-right"
              style={{ opacity: canScrollRight ? 1 : 0 }}
            />
          </>
        )}
      </div>

      <ContextMenu
        open={!nativeContextMenusEnabled && !!tabMenuState}
        anchor={tabMenuState ? { x: tabMenuState.x, y: tabMenuState.y } : null}
        entries={tabMenuEntries}
        onClose={closeTabMenu}
        minWidth={196}
      />
      
      <ContextMenu
        open={!!groupMenu}
        anchor={groupMenu ? { x: groupMenu.x, y: groupMenu.y } : null}
        onClose={closeGroupMenu}
        entries={groupMenu ? [
          { type: 'item', label: 'Rename Group', onSelect: () => { void runGroupCommand(groupMenu.id, 'rename'); } },
          { type: 'item', label: groups.find(group => group.id === groupMenu.id)?.collapsed ? 'Expand Group' : 'Collapse Group', onSelect: () => { void runGroupCommand(groupMenu.id, 'toggle'); } },
          { type: 'separator' },
          ...Object.keys(TAB_GROUP_COLORS).map(color => ({ type: 'item' as const, label: `${color[0].toUpperCase()}${color.slice(1)}${groups.find(group => group.id === groupMenu.id)?.color === color ? ' \u2713' : ''}`, onSelect: () => { void runGroupCommand(groupMenu.id, `color:${color}`); } })),
          { type: 'separator' },
          { type: 'item', label: 'Ungroup Tabs', onSelect: () => { void runGroupCommand(groupMenu.id, 'ungroup'); } },
          { type: 'item', label: 'Close Group', onSelect: () => { void runGroupCommand(groupMenu.id, 'close'); } },
        ] : []}
      />

      {/* Dragged tab overlay */}
      {draggingTabId && draggedTabPosition && !dragUsesNativeWindow && (() => {
        const draggedTab = tabs.find(tab => tab.id === draggingTabId);
        if (!draggedTab) return null;
        const displayFavicon = getDisplayFavicon(draggedTab.url, draggedTab.favicon, draggedTab.restoreDeferred);
        const displayTitle = getDisplayTitle(draggedTab.url, draggedTab.title);
        const isInternalTab = draggedTab.url.startsWith('mira://');
        const faviconSize = isInternalTab ? 22 : 16;
        const isActive = draggedTab.id === activeId;
        const groupColor = !draggedTab.isPinned && !isVertical && draggedTab.group ? TAB_GROUP_COLORS[draggedTab.group.color] : undefined;
        const activeOutlineColor = groupColor ?? 'var(--surfaceBorder, var(--tabBorder))';
        
        return (
          <div
            style={{
              position: 'fixed',
              left: isVertical
                ? isRightSidebar ? originalTabPosition?.x ?? 0 : originalTabPosition?.right ?? 0
                : draggedTabPosition.x,
              top: !isVertical && originalTabPosition
                ? originalTabPosition.y
                : draggedTabPosition.y - dragPointerToTopRef.current,
              zIndex: 1000,
              pointerEvents: 'none',
            }}
          >
            <div
              className={`theme-tab tab-drag-preview ${draggedTab.id === activeId ? 'theme-tab-selected' : ''}`}
              data-tab-drag-preview={draggedTab.id}
              style={{
                height: isActive ? draggedTabHeight ?? TAB_ROW_HEIGHT : TAB_ROW_HEIGHT,
                borderRadius: isActive ? (isVertical ? (isRightSidebar ? `0 ${tabRadius} ${tabRadius} 0` : `${tabRadius} 0 0 ${tabRadius}`) : `${tabRadius} ${tabRadius} 0 0`) : tabRadius,
                borderTopColor: isActive ? activeOutlineColor : undefined,
                borderBottomColor: isActive ? (!isVertical ? 'var(--surfaceBgHover, var(--tabBgHover))' : activeOutlineColor) : undefined,
                borderLeftColor: isActive ? (isVertical && isRightSidebar ? 'var(--surfaceBgHover, var(--tabBgHover))' : activeOutlineColor) : undefined,
                borderRightColor: isActive ? (isVertical && !isRightSidebar ? 'var(--surfaceBgHover, var(--tabBgHover))' : activeOutlineColor) : undefined,
                display: 'flex',
                gap: 6,
                alignItems: isActive && !isVertical ? 'flex-start' : 'center',
                whiteSpace: 'nowrap',
                width: draggedTabWidth ?? TAB_TARGET_WIDTH,
                minWidth: 0,
                transform: isVertical
                  ? isRightSidebar ? undefined : 'translateX(-100%)'
                  : `translateX(${-dragPointerWidthRatioRef.current * 100}%)`,
                boxShadow: isActive ? undefined : 'var(--tabDragShadow, 0 6px 18px rgba(0, 0, 0, 0.28))',
                position: 'relative',
                overflow: isActive ? 'visible' : 'hidden',
                padding: draggedTab.isPinned && !isVertical ? '0' : isVertical && isActive ? (isRightSidebar ? '0 6px 0 16px' : '0 12px 0 10px') : '0 6px 0 10px',
                justifyContent: draggedTab.isPinned && !isVertical ? 'center' : undefined,
                background: draggedTab.id === activeId ? 'var(--surfaceBgHover, var(--tabBgHover))' : undefined,
              }}
            >
              {isActive && <TabConnection vertical={isVertical} rightSidebar={isRightSidebar} color={groupColor} />}
              <div data-tab-drag-content style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0,
                height: `calc(${TAB_ROW_HEIGHT} - 2 * ${borderWidth})`, flexShrink: 0,
                justifyContent: draggedTab.isPinned && !isVertical ? 'center' : undefined }}>
              <TabFavicon url={draggedTab.url} src={displayFavicon} size={faviconSize} deferred={draggedTab.restoreDeferred} />
              {(!draggedTab.isPinned || isVertical) && <span
                title={displayTitle}
                className="tab-title"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  maskImage: 'linear-gradient(to right, black calc(100% - 10px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 10px), transparent 100%)',
                }}
              >
                {displayTitle}
              </span>}
              {!draggedTab.isPinned && <span
                aria-hidden="true"
                className="theme-btn tab-close-btn"
                style={{ opacity: 0.8, padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              >
                <X size={14} strokeWidth={2.2} />
              </span>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
