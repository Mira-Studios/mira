import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Plus, X } from 'lucide-react';
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
const TAB_ROW_HEIGHT = 'var(--layoutTabHeight, 30px)';
const TAB_SWAP_TRIGGER_RATIO = 0.1;
const TAB_SWAP_MIN_POINTER_DELTA_PX = 10;
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
    if (!parsed.hostname) return undefined;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=64`;
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
    moveTabToNewWindow,
  } = useTabs();
  const [tabMenuState, setTabMenuState] = useState<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [draggedTabPosition, setDraggedTabPosition] = useState<{ x: number; y: number } | null>(null);
  const [originalTabPosition, setOriginalTabPosition] = useState<{ x: number; y: number } | null>(null);
  const [draggedTabWidth, setDraggedTabWidth] = useState<number | null>(null);
  const [dragUsesNativeWindow, setDragUsesNativeWindow] = useState(false);
  const [dragRegionsTemporarilyDisabled, setDragRegionsTemporarilyDisabled] = useState(false);
  const [transitionSuppressedTabId, setTransitionSuppressedTabId] = useState<string | null>(null);
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
  const previousRectsRef = useRef<Record<string, DOMRect>>({});
  const previousLayoutOrderRef = useRef<string[]>([]);
  const enterTimerByTabIdRef = useRef<Record<string, number>>({});
  const exitTimerByTabIdRef = useRef<Record<string, number>>({});
  const reorderAnimationByTabIdRef = useRef<Partial<Record<string, Animation>>>({});
  const dragPointerToLeftRef = useRef(0);
  const dragPointerToTopRef = useRef(0);
  const lastSwapClientXRef = useRef<number | null>(null);
  const lastSwapClientYRef = useRef<number | null>(null);
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
      const tabWidth = Array.from(el.querySelectorAll('.theme-tab'))
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
    const hasTabsToRight = tabIndex >= 0 && tabIndex < tabs.length - 1;
    const hasOtherTabs = tabs.length > 1;
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
  }, [newTabToRight, reloadTab, duplicateTab, closeTab, closeOtherTabs, closeTabsToRight, orientation]);

  useEffect(() => {
    if (!draggingTabId) return;
    let didEndDrag = false;

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
      lastSwapClientXRef.current = null;
      lastSwapClientYRef.current = null;
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

      const currentTabs = tabsRef.current;
      if (!draggingTabId) return;

      const isVertical = orientation === 'vertical';
      const draggedEl = tabElementRefs.current[draggingTabId];
      const containerRect = scrollRef.current?.getBoundingClientRect();
      const draggedRect = draggedEl?.getBoundingClientRect();
      const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

      // Only update position when actually dragging (after threshold)
      if (Math.abs(event.movementX) > 2 || Math.abs(event.movementY) > 2) {
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

      const currentIndex = currentTabs.findIndex((tab) => tab.id === draggingTabId);
      if (currentIndex === -1) return;
      const now = Date.now();
      if (now - lastSwapAtRef.current < TAB_SWAP_COOLDOWN_MS) return;

      // Use the mouse position for swap detection (revert to working approach)
      const draggedCenterPrimary = isVertical ? event.clientY : event.clientX;
      if (currentIndex > 0) {
        const prevTab = currentTabs[currentIndex - 1];
        const prevEl = prevTab ? tabElementRefs.current[prevTab.id] : null;
        if (prevEl) {
          const prevRect = prevEl.getBoundingClientRect();
          const prevTrigger = isVertical
            ? prevRect.top + prevRect.height * (1 - TAB_SWAP_TRIGGER_RATIO)
            : prevRect.left + prevRect.width * (1 - TAB_SWAP_TRIGGER_RATIO);
          const canSwap =
            (isVertical ? lastSwapClientYRef.current : lastSwapClientXRef.current) === null ||
            Math.abs(
              (isVertical ? event.clientY : event.clientX) -
                (isVertical
                  ? (lastSwapClientYRef.current ?? 0)
                  : (lastSwapClientXRef.current ?? 0)),
            ) >= TAB_SWAP_MIN_POINTER_DELTA_PX;
          if (draggedCenterPrimary < prevTrigger && canSwap) {
            moveTabToIndex(draggingTabId, currentIndex - 1);
            if (isVertical) {
              lastSwapClientYRef.current = event.clientY;
            } else {
              lastSwapClientXRef.current = event.clientX;
            }
            lastSwapAtRef.current = now;
            return;
          }
        }
      }

      if (currentIndex < currentTabs.length - 1) {
        const nextTab = currentTabs[currentIndex + 1];
        const nextEl = nextTab ? tabElementRefs.current[nextTab.id] : null;
        if (nextEl) {
          const nextRect = nextEl.getBoundingClientRect();
          const nextTrigger = isVertical
            ? nextRect.top + nextRect.height * TAB_SWAP_TRIGGER_RATIO
            : nextRect.left + nextRect.width * TAB_SWAP_TRIGGER_RATIO;
          const canSwap =
            (isVertical ? lastSwapClientYRef.current : lastSwapClientXRef.current) === null ||
            Math.abs(
              (isVertical ? event.clientY : event.clientX) -
                (isVertical
                  ? (lastSwapClientYRef.current ?? 0)
                  : (lastSwapClientXRef.current ?? 0)),
            ) >= TAB_SWAP_MIN_POINTER_DELTA_PX;
          if (draggedCenterPrimary > nextTrigger && canSwap) {
            moveTabToIndex(draggingTabId, currentIndex + 1);
            if (isVertical) {
              lastSwapClientYRef.current = event.clientY;
            } else {
              lastSwapClientXRef.current = event.clientX;
            }
            lastSwapAtRef.current = now;
            return;
          }
        }
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
    orientation,
    scheduleDragRegionRefresh,
    suppressReleasedTabTransition,
  ]);

  // Add a small delay when orientation changes to ensure proper cleanup
  useEffect(() => {
    // Reset any drag state when orientation changes
    setDraggingTabId(null);
    setDraggedTabPosition(null);
    setOriginalTabPosition(null);
    setDraggedTabWidth(null); // Clear dragged tab width on orientation change
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
    const releasedDragTabId = releasedDragTabIdRef.current;
    const isVertical = orientation === 'vertical';

    if (animationsEnabled) {
      for (const item of renderedTabs) {
        // Ensure measurements use layout positions, not in-flight transforms.
        const animation = reorderAnimationByTabIdRef.current[item.tab.id];
        if (animation) {
          animation.cancel();
          delete reorderAnimationByTabIdRef.current[item.tab.id];
        }
      }
    }

    for (const item of renderedTabs) {
      const tabId = item.tab.id;
      const el = tabElementRefs.current[tabId];
      if (!el) continue;
      const nextRect = el.getBoundingClientRect();
      const prevRect = previousRectsRef.current[tabId];
      if (tabId === draggingTabId) {
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
      if (!orderChanged) continue;
      if (!prevRect) continue;
      if (tabId === releasedDragTabId) continue;
      const delta = isVertical ? prevRect.top - nextRect.top : prevRect.left - nextRect.left;
      if (Math.abs(delta) < 2) continue;
      if (!animationsEnabled) continue;

      const deltaAbs = Math.abs(delta);
      // Loosen thresholds while dragging so surrounding tabs animate during swaps.
      const isDeliberateReorder = draggingTabId
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
  }, [renderedTabs, draggingTabId, animationsEnabled, orientation]);

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
  const isActivelyDragging = draggingTabId !== null && draggedTabPosition !== null;
  const isRightSidebar = isVertical && tabStripPosition === 'right';
  const tabRadius = 'var(--layoutTabRadius, 8px)';
  const borderWidth = 'var(--layoutBorderWidth, 1px)';

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
        ['--tabGapMarginMs' as string]: isVertical ? '0ms' : `${TAB_ENTER_EXIT_DURATION_MS}ms`,
      } as CSSProperties}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
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
            height: isVertical ? undefined : '100%',
            WebkitAppRegion: !isVertical && (canScrollLeft || canScrollRight)
              ? 'no-drag'
              : dragRegionsTemporarilyDisabled ? 'no-drag' : 'drag',
            padding: isVertical ? 6 : '0 4px',
          }}
        >
          {renderedTabs.map(({ tab, phase }) => {
            const displayFavicon = getDisplayFavicon(tab.url, tab.favicon, tab.restoreDeferred);
            const displayTitle = getDisplayTitle(tab.url, tab.title);
            const isInternalTab = tab.url.startsWith('mira://');
            const faviconSize = isInternalTab ? 22 : 16;
            const isExiting = phase === 'exiting';
            const isCollapsed = phase !== 'stable';

            return (
              <div
                key={tab.id}
                ref={(el) => {
                  tabElementRefs.current[tab.id] = el;
                }}
                data-tab-id={tab.id}
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
                    dragPointerToTopRef.current = event.clientY - rect.top;
                    setOriginalTabPosition({ x: rect.left, y: rect.top });
                    setDraggedTabWidth(rect.width);
                  } else {
                    dragPointerToLeftRef.current = 0;
                    dragPointerToTopRef.current = 0;
                    setOriginalTabPosition({ x: event.clientX, y: event.clientY });
                  }
                  lastSwapClientXRef.current = null;
                  lastSwapClientYRef.current = null;
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
                    const hasTabsToRight = tabIndex >= 0 && tabIndex < tabs.length - 1;
                    const hasOtherTabs = tabs.length > 1;
                    const isVertical = orientation === 'vertical';
                    setTabMenuState(null);
                    void electron.ipcRenderer
                      .invoke('tab-show-native-context-menu', {
                        tabId: tab.id,
                        x: event.clientX,
                        y: event.clientY,
                        hasTabsToRight,
                        hasOtherTabs,
                        isVertical,
                      })
                      .catch(() => undefined);
                    return;
                  }
                  setTabMenuState({ tabId: tab.id, x: event.clientX, y: event.clientY });
                }}
                className={`theme-tab ${tab.id === activeId ? 'theme-tab-selected' : ''}${
                  (isActivelyDragging && draggingTabId === tab.id) || transitionSuppressedTabId === tab.id
                    ? ' tab-is-dragging'
                    : ''
                }`}
                style={{
                  height: TAB_ROW_HEIGHT,
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
                  alignItems: 'center',
                  whiteSpace: 'nowrap',
                  flex: isVertical ? '0 0 auto' : `1 1 ${TAB_TARGET_WIDTH}`,
                  minWidth: isVertical ? 0 : isCollapsed ? 0 : TAB_MIN_WIDTH,
                  maxWidth: isVertical ? '100%' : isCollapsed ? 0 : TAB_TARGET_WIDTH,
                  overflow: 'hidden',
                  padding: isCollapsed ? '0' : '0 6px 0 10px',
                  position: 'relative',
                  marginBottom: 0,
                  marginRight:
                    !isVertical && isCollapsed
                      ? `calc(-1 * ${TAB_STRIP_GAP})`
                      : tab.id === activeId && isVertical && !isRightSidebar
                      ? `calc(-1 * ${borderWidth})`
                      : 0,
                  borderWidth: isCollapsed ? 0 : borderWidth,
                  marginLeft:
                    tab.id === activeId && isVertical && isRightSidebar
                      ? `calc(-1 * ${borderWidth})`
                      : 0,
                  background:
                    tab.id === activeId ? 'var(--surfaceBgHover, var(--tabBgHover))' : undefined,
                  opacity: isCollapsed
                    ? 0
                    : draggingTabId === tab.id && draggedTabPosition
                      ? 0  // Completely hide when overlay is visible (actual dragging)
                      : 1,
                  transform:
                    draggingTabId === tab.id && draggedTabPosition
                      ? `translate(${draggedTabPosition.x - dragPointerToLeftRef.current}px, ${draggedTabPosition.y - dragPointerToTopRef.current}px)`
                      : undefined,
                  borderBottomColor:
                    tab.id === activeId && !isVertical
                      ? 'var(--surfaceBgHover, var(--tabBgHover))'
                      : undefined,
                  borderLeftColor:
                    tab.id === activeId && isVertical && isRightSidebar
                      ? 'var(--surfaceBgHover, var(--tabBgHover))'
                      : undefined,
                  borderRightColor:
                    tab.id === activeId && isVertical && !isRightSidebar
                      ? 'var(--surfaceBgHover, var(--tabBgHover))'
                      : undefined,
                  pointerEvents:
                    isExiting || (isActivelyDragging && tab.id !== draggingTabId) ? 'none' : 'auto',
                  zIndex: isActivelyDragging && draggingTabId === tab.id ? 20 : tab.id === activeId ? 2 : 1,
                  borderTopStyle: tab.isSleeping ? 'dashed' : undefined,
                  borderTopWidth: tab.isSleeping ? borderWidth : undefined,
                }}
              >
                {displayFavicon ? (
                  <img
                    src={displayFavicon}
                    alt=""
                    draggable={false}
                    style={{
                      width: faviconSize,
                      height: faviconSize,
                      borderRadius: 3,
                      flexShrink: 0,
                      pointerEvents: 'none',
                    }}
                  />
                ) : (
                  <span
                    aria-hidden={true}
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 3,
                      display: 'inline-block',
                      background: 'var(--tabPlaceholderBg, var(--surfaceBorder, var(--tabBorder)))',
                      flexShrink: 0,
                    }}
                  />
                )}
                <span
                  title={displayTitle}
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
                </span>
                <button
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
                    padding: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'default',
                    WebkitAppRegion: 'no-drag',
                  }}
                >
                  <X size={14} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <button
            onClick={() => newTab()}
            className="theme-btn theme-btn-nav nav-icon-btn tab-new-tab-btn"
            style={{
              height: TAB_ROW_HEIGHT,
              flex: isVertical
                ? '0 0 auto'
                : 'none',
              width: isVertical
                ? '100%'
                : 'calc(var(--layoutNavButtonHeight, 30px) + 3px)',
              minWidth: isVertical
                ? 0
                : 'calc(var(--layoutNavButtonHeight, 30px) + 3px)',
              maxWidth: isVertical
                ? '100%'
                : 'calc(var(--layoutNavButtonHeight, 30px) + 3px)',
              marginTop: isVertical ? 0 : 1,
              flexShrink: 0,
              borderRadius: isVertical
                ? 'var(--layoutTabRadius, 8px)'
                : undefined,
              WebkitAppRegion: 'no-drag',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
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
              style={{ opacity: canScrollLeft ? 1 : 0 }}
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
      
      {/* Dragged tab overlay */}
      {draggingTabId && draggedTabPosition && !dragUsesNativeWindow && (() => {
        const draggedTab = tabs.find(tab => tab.id === draggingTabId);
        if (!draggedTab) return null;
        const displayFavicon = getDisplayFavicon(draggedTab.url, draggedTab.favicon, draggedTab.restoreDeferred);
        const displayTitle = getDisplayTitle(draggedTab.url, draggedTab.title);
        const isInternalTab = draggedTab.url.startsWith('mira://');
        const faviconSize = isInternalTab ? 22 : 16;
        
        return (
          <div
            style={{
              position: 'fixed',
              left: isVertical
                ? originalTabPosition?.x ?? 0
                : draggedTabPosition.x - dragPointerToLeftRef.current,
              top: !isVertical && originalTabPosition
                ? originalTabPosition.y
                : draggedTabPosition.y - dragPointerToTopRef.current,
              zIndex: 1000,
              pointerEvents: 'none',
              boxShadow:
                draggingTabId === draggedTab.id
                  ? 'var(--tabDragShadow, 0 6px 18px rgba(0, 0, 0, 0.28))'
                  : undefined,
            }}
          >
            <div
              className={`theme-tab ${draggedTab.id === activeId ? 'theme-tab-selected' : ''}`}
              style={{
                height: TAB_ROW_HEIGHT,
                borderRadius: 'var(--layoutTabRadius, 8px)',
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                whiteSpace: 'nowrap',
                width: draggedTabWidth ?? TAB_TARGET_WIDTH,
                minWidth: isVertical ? 0 : TAB_MIN_WIDTH,
                overflow: 'hidden',
                padding: '0 6px 0 10px',
                background: draggedTab.id === activeId ? 'var(--surfaceBgHover, var(--tabBgHover))' : undefined,
              }}
            >
              {displayFavicon ? (
                <img
                  src={displayFavicon}
                  alt=""
                  draggable={false}
                  style={{
                    width: faviconSize,
                    height: faviconSize,
                    borderRadius: 3,
                    flexShrink: 0,
                  }}
                />
              ) : (
                <span
                  aria-hidden={true}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    display: 'inline-block',
                    background: 'var(--tabPlaceholderBg, var(--surfaceBorder, var(--tabBorder)))',
                    flexShrink: 0,
                  }}
                />
              )}
              <span
                title={displayTitle}
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
              </span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
