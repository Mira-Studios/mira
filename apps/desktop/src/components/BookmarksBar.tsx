import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTabs } from '../features/tabs/TabsProvider';
import { useBookmarks, type Bookmark } from '../features/bookmarks/BookmarksProvider';
import { getBrowserSettings } from '../features/settings/browserSettings';
import { electron } from '../electronBridge';
import { ChevronRight, Folder } from 'lucide-react';
import ContextMenu, { type ContextMenuEntry } from './ContextMenu';

// Folder Dropdown Component - uses fixed positioning to avoid clipping
function FolderDropdown({
  bookmark,
  parentFolderId,
  folderRefs,
  expandedFolders,
  getTabFavicon,
  handleNavigate,
  handleContextMenu,
  toggleFolder,
  closeAllFolders,
  cancelPendingFolderClose,
  scheduleFolderClose,
  collapseChildFolderBranches,
}: {
  bookmark: Bookmark;
  parentFolderId?: string;
  folderRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  expandedFolders: Set<string>;
  getTabFavicon: (url?: string) => string | undefined;
  handleNavigate: (url: string) => void;
  handleContextMenu: (event: React.MouseEvent, bookmark: Bookmark, parentFolderId?: string) => void;
  toggleFolder: (folderId: string) => void;
  closeAllFolders: () => void;
  cancelPendingFolderClose: () => void;
  scheduleFolderClose: (folderId: string) => void;
  collapseChildFolderBranches: (parentFolderId: string, exceptFolderId?: string) => void;
}) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    const folderButton = document.querySelector<HTMLElement>(`[data-folder-button="${bookmark.id}"]`);
    if (folderButton) {
      const rect = folderButton.getBoundingClientRect();
      const isNested = !!parentFolderId;
      const menuWidth = 250;
      const menuHeight = 300;
      const viewportPadding = 8;
      let nextLeft = isNested ? rect.right + 4 : rect.left;
      let nextTop = isNested ? rect.top : rect.bottom + 4;

      if (nextLeft + menuWidth > window.innerWidth - viewportPadding) {
        nextLeft = isNested
          ? rect.left - menuWidth - 4
          : Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
      }

      if (nextTop + menuHeight > window.innerHeight - viewportPadding) {
        nextTop = Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding);
      }

      setPosition({
        top: nextTop,
        left: Math.max(viewportPadding, nextLeft),
      });
    }
  }, [bookmark.id, parentFolderId]);

  useEffect(() => {
    const currentRef = dropdownRef.current;
    const folderRegistry = folderRefs.current;
    folderRegistry[bookmark.id] = currentRef;
    return () => {
      folderRegistry[bookmark.id] = null;
    };
  }, [bookmark.id, folderRefs]);

  return (
    <div
      ref={dropdownRef}
      data-folder-children
      onMouseEnter={cancelPendingFolderClose}
      onMouseLeave={() => scheduleFolderClose(bookmark.id)}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        background: 'var(--surfaceBg, #2a2a2a)',
        border: '1px solid var(--surfaceBorder, #3a3a3a)',
        borderRadius: 6,
        padding: 4,
        minWidth: 150,
        maxWidth: 250,
        maxHeight: 300,
        overflowY: 'auto',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        zIndex: 9999,
      }}
    >
      {bookmark.children?.map((child) => (
        <div
          key={child.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <button
            data-folder-button={child.type === 'folder' ? child.id : undefined}
            onClick={(event) => {
              event.stopPropagation();
              if (child.type === 'folder') {
                toggleFolder(child.id);
                return;
              }
              if (child.url) {
                handleNavigate(child.url);
                closeAllFolders();
              }
            }}
            onMouseEnter={() => {
              cancelPendingFolderClose();
              collapseChildFolderBranches(
                bookmark.id,
                child.type === 'folder' ? child.id : undefined,
              );
              if (child.type === 'folder' && expandedFolders.size > 0 && !expandedFolders.has(child.id)) {
                toggleFolder(child.id);
              }
            }}
            onMouseLeave={() => {
              if (child.type === 'folder') {
                scheduleFolderClose(child.id);
              }
            }}
            onContextMenu={(e) => {
              e.stopPropagation();
              handleContextMenu(e, child, bookmark.id);
            }}
            className="theme-btn theme-btn-nav"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              fontSize: 12,
              textAlign: 'left',
              border: 'none',
              background: child.type === 'folder' && expandedFolders.has(child.id)
                ? 'rgba(128, 128, 128, 0.2)'
                : 'transparent',
              color: 'var(--text2)',
              borderRadius: 4,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              justifyContent: 'space-between',
            }}
            title={child.title}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {child.type === 'bookmark' ? (
                <>
                  {getTabFavicon(child.url) ? (
                    <img
                      src={getTabFavicon(child.url)}
                      alt=""
                      style={{ width: 14, height: 14, flexShrink: 0 }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div style={{ width: 14, height: 14, borderRadius: 2, background: 'var(--accent)', flexShrink: 0 }} />
                  )}
                </>
              ) : (
                <Folder size={14} style={{ flexShrink: 0 }} />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{child.title}</span>
            </span>
            {child.type === 'folder' && (
              <ChevronRight size={13} style={{ flexShrink: 0, opacity: 0.75 }} />
            )}
          </button>
          {child.type === 'folder' && expandedFolders.has(child.id) && child.children && (
            <FolderDropdown
              bookmark={child}
              parentFolderId={bookmark.id}
              folderRefs={folderRefs}
              expandedFolders={expandedFolders}
              getTabFavicon={getTabFavicon}
              handleNavigate={handleNavigate}
              handleContextMenu={handleContextMenu}
              toggleFolder={toggleFolder}
              closeAllFolders={closeAllFolders}
              cancelPendingFolderClose={cancelPendingFolderClose}
              scheduleFolderClose={scheduleFolderClose}
              collapseChildFolderBranches={collapseChildFolderBranches}
            />
          )}
        </div>
      ))}
    </div>
  );
}

const BOOKMARK_SWAP_TRIGGER_RATIO = 0.5;
const BOOKMARK_SWAP_MIN_POINTER_DELTA_PX = 5;
const BOOKMARK_SWAP_COOLDOWN_MS = 50;
const BOOKMARK_REORDER_ANIMATION_MS = 150;
const BOOKMARK_REORDER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const BOOKMARK_FOLDER_CLOSE_DELAY_MS = 140;

type RenderedBookmarkState = {
  bookmark: Bookmark;
  lastKnownIndex: number;
};

function BookmarkBarItem({
  bookmark,
  onNavigate,
  tabFavicon,
  isDragging,
  isDragOverlay,
  onContextMenu,
  onClick,
  isFolderExpanded,
  folderButtonId,
  onMouseEnter,
  onMouseLeave,
}: {
  bookmark: Bookmark;
  onNavigate: (url: string) => void;
  tabFavicon?: string;
  isDragging?: boolean;
  isDragOverlay?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  isFolderExpanded?: boolean;
  folderButtonId?: string;
  onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      onClick(e);
    } else if (bookmark.type === 'bookmark' && bookmark.url) {
      onNavigate(bookmark.url);
    }
  };

  const icon = bookmark.type === 'folder' ? (
    <Folder size={12} />
  ) : tabFavicon ? (
    <img
      src={tabFavicon}
      alt=""
      style={{
        width: 12,
        height: 12,
        marginRight: 4,
        display: 'block'
      }}
      onError={(e) => {
        const target = e.target as HTMLImageElement;
        target.style.display = 'none';
        const fallback = target.nextElementSibling as HTMLElement;
        if (fallback) {
          fallback.style.display = 'block';
        }
      }}
    />
  ) : null;

  return (
    <button
      onClick={handleClick}
      data-folder-button={folderButtonId}
      className="theme-btn theme-btn-nav bookmarks-bar-item"
      title={bookmark.url || bookmark.title}
      onContextMenu={onContextMenu}
      style={{
        padding: '2px 6px',
        fontSize: 11,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        minWidth: 0,
        maxWidth: bookmark.type === 'folder' ? undefined : 120,
        height: '22px',
        border: 'none',
        background: isFolderExpanded ? 'rgba(128, 128, 128, 0.25)' : 'transparent',
        borderRadius: '3px',
        color: 'var(--text2)',
        transition: 'background-color 0.15s ease',
        opacity: isDragging ? 0 : 1,
        cursor: isDragOverlay ? 'grabbing' : 'default',
      }}
      onMouseEnter={(e) => {
        onMouseEnter?.(e);
        if (!isDragOverlay) {
          e.currentTarget.style.backgroundColor = 'rgba(128, 128, 128, 0.15)';
        }
      }}
      onMouseLeave={(e) => {
        onMouseLeave?.(e);
        if (!isDragOverlay) {
          e.currentTarget.style.backgroundColor = isFolderExpanded ? 'rgba(128, 128, 128, 0.25)' : 'transparent';
        }
      }}
    >
      {bookmark.type === 'folder' ? (
        <span style={{ color: 'var(--text3)', flexShrink: 0 }}>
          {icon}
        </span>
      ) : (
        <>
          {icon}
          {!icon && (
            <div
              style={{
                width: 12,
                height: 12,
                marginRight: 4,
                borderRadius: '2px',
                background: 'var(--accent)',
                flexShrink: 0,
                display: 'block'
              }}
            />
          )}
        </>
      )}
      <span style={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1
      }}>
        {bookmark.title}
      </span>
    </button>
  );
}

export default function BookmarksBar() {
  const { navigate, tabs, newTab } = useTabs();
  const { bookmarks, moveBookmark, deleteBookmark } = useBookmarks();

  const [draggingBookmarkId, setDraggingBookmarkId] = useState<string | null>(null);
  const [draggedPosition, setDraggedPosition] = useState<{ x: number; y: number } | null>(null);
  const [originalPosition, setOriginalPosition] = useState<{ x: number; y: number } | null>(null);
  const dragPointerToLeftRef = useRef(0);
  const dragPointerToTopRef = useRef(0);
  const lastSwapClientXRef = useRef<number | null>(null);
  const lastSwapAtRef = useRef(0);
  const dragMovedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const releasedDragIdRef = useRef<string | null>(null);
  const bookmarkElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const previousRectsRef = useRef<Record<string, DOMRect>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragMovedEnoughRef = useRef(false);
  const lastNativeBookmarkCommandRef = useRef<{ signature: string; at: number } | null>(null);
  const folderCloseTimeoutsRef = useRef<Record<string, number | undefined>>({});

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    anchor: { x: number; y: number };
    bookmark: Bookmark;
  } | null>(null);
  const [nativeContextMenusEnabled, setNativeContextMenusEnabled] = useState(
    () => getBrowserSettings().nativeTextFieldContextMenu,
  );


  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const folderRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const contextMenuParentFolderRef = useRef<string | null>(null);

  // Get bookmark by ID from entire tree (including nested)
  const getBookmarkById = useCallback((id: string, bookmarkList: Bookmark[] = bookmarks): Bookmark | undefined => {
    for (const b of bookmarkList) {
      if (b.id === id) return b;
      if (b.children) {
        const found = getBookmarkById(id, b.children);
        if (found) return found;
      }
    }
    return undefined;
  }, [bookmarks]);

  const getDescendantFolderIds = useCallback((folder: Bookmark | undefined): string[] => {
    if (!folder?.children) return [];

    const descendants: string[] = [];
    for (const child of folder.children) {
      if (child.type === 'folder') {
        descendants.push(child.id, ...getDescendantFolderIds(child));
      }
    }
    return descendants;
  }, []);

  const cancelPendingFolderClose = useCallback(() => {
    const closeTimeouts = folderCloseTimeoutsRef.current;
    for (const folderId of Object.keys(closeTimeouts)) {
      const timeoutId = closeTimeouts[folderId];
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        delete closeTimeouts[folderId];
      }
    }
  }, []);

  const closeAllFolders = useCallback(() => {
    cancelPendingFolderClose();
    setExpandedFolders(new Set());
  }, [cancelPendingFolderClose]);

  const collapseFolderBranch = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.delete(folderId);

      const folder = getBookmarkById(folderId);
      for (const descendantId of getDescendantFolderIds(folder)) {
        next.delete(descendantId);
      }

      return next;
    });
  }, [getBookmarkById, getDescendantFolderIds]);

  const collapseChildFolderBranches = useCallback((parentFolderId: string, exceptFolderId?: string) => {
    const parentFolder = getBookmarkById(parentFolderId);
    if (!parentFolder?.children) return;

    for (const child of parentFolder.children) {
      if (child.type === 'folder' && child.id !== exceptFolderId) {
        collapseFolderBranch(child.id);
      }
    }
  }, [collapseFolderBranch, getBookmarkById]);

  const scheduleFolderClose = useCallback((folderId: string) => {
    const closeTimeouts = folderCloseTimeoutsRef.current;
    const existingTimeout = closeTimeouts[folderId];
    if (existingTimeout !== undefined) {
      window.clearTimeout(existingTimeout);
    }

    closeTimeouts[folderId] = window.setTimeout(() => {
      delete closeTimeouts[folderId];
      collapseFolderBranch(folderId);
    }, BOOKMARK_FOLDER_CLOSE_DELAY_MS);
  }, [collapseFolderBranch]);

  const toggleFolder = useCallback((folderId: string) => {
    cancelPendingFolderClose();
    if (expandedFolders.has(folderId)) {
      collapseFolderBranch(folderId);
      return;
    }

    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.add(folderId);
      return next;
    });
  }, [cancelPendingFolderClose, collapseFolderBranch, expandedFolders]);

  useEffect(() => () => {
    const closeTimeouts = folderCloseTimeoutsRef.current;
    for (const timeoutId of Object.values(closeTimeouts)) {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    }
  }, []);

  const topLevelBookmarks = bookmarks.filter(bookmark => !bookmark.parentId);

  const [renderedBookmarks, setRenderedBookmarks] = useState<RenderedBookmarkState[]>(() =>
    topLevelBookmarks.map((bookmark, index) => ({ bookmark, lastKnownIndex: index }))
  );
  const renderedBookmarksRef = useRef(renderedBookmarks);
  const bookmarksRef = useRef(topLevelBookmarks);

  // Sync rendered bookmarks with actual bookmarks
  useEffect(() => {
    const newTopLevel = bookmarks.filter(b => !b.parentId);
    setRenderedBookmarks(prev => {
      // Keep existing rendered state but update bookmark data
      const newRendered = newTopLevel.map((bookmark, index) => {
        const existing = prev.find(r => r.bookmark.id === bookmark.id);
        return existing ? { ...existing, bookmark, lastKnownIndex: index } : { bookmark, lastKnownIndex: index };
      });
      return newRendered;
    });
    bookmarksRef.current = newTopLevel;
  }, [bookmarks]);

  // Sync native context menu setting
  useEffect(() => {
    const syncSettings = () => {
      const settings = getBrowserSettings();
      setNativeContextMenusEnabled(settings.nativeTextFieldContextMenu);
    };
    syncSettings();
    
    // Listen for settings changes
    const handleSettingsChange = () => syncSettings();
    window.addEventListener('BROWSER_SETTINGS_CHANGED_EVENT', handleSettingsChange);
    return () => window.removeEventListener('BROWSER_SETTINGS_CHANGED_EVENT', handleSettingsChange);
  }, []);

  useEffect(() => {
    renderedBookmarksRef.current = renderedBookmarks;
  }, [renderedBookmarks]);

  // Handle drag mouse events
  useEffect(() => {
    if (!draggingBookmarkId) return;

    const onMouseMove = (event: MouseEvent) => {
      const currentBookmarks = bookmarksRef.current;
      if (!draggingBookmarkId) return;

      // Check if moved enough to start dragging
      if (!dragMovedEnoughRef.current) {
        if (Math.abs(event.movementX) > 2 || Math.abs(event.movementY) > 2) {
          dragMovedEnoughRef.current = true;
          dragMovedRef.current = true;
        } else {
          return;
        }
      }

      // Update dragged position
      const containerRect = containerRef.current?.getBoundingClientRect();
      const draggedEl = bookmarkElementRefs.current[draggingBookmarkId];
      const draggedRect = draggedEl?.getBoundingClientRect();
      const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

      let nextX = event.clientX;
      if (containerRect && draggedRect) {
        const minX = containerRect.left + dragPointerToLeftRef.current;
        const maxX = containerRect.right - (draggedRect.width - dragPointerToLeftRef.current);
        nextX = clamp(nextX, minX, maxX);
      }
      setDraggedPosition({ x: nextX, y: 0 });

      // Handle swapping
      const currentIndex = currentBookmarks.findIndex((b) => b.id === draggingBookmarkId);
      if (currentIndex === -1) return;

      const now = Date.now();
      if (now - lastSwapAtRef.current < BOOKMARK_SWAP_COOLDOWN_MS) return;

      const draggedCenterX = event.clientX;

      // Check swap with previous bookmark
      if (currentIndex > 0) {
        const prevBookmark = currentBookmarks[currentIndex - 1];
        const prevEl = prevBookmark ? bookmarkElementRefs.current[prevBookmark.id] : null;
        if (prevEl) {
          const prevRect = prevEl.getBoundingClientRect();
          const prevTrigger = prevRect.left + prevRect.width * (1 - BOOKMARK_SWAP_TRIGGER_RATIO);
          const canSwap = lastSwapClientXRef.current === null ||
            Math.abs(event.clientX - (lastSwapClientXRef.current ?? 0)) >= BOOKMARK_SWAP_MIN_POINTER_DELTA_PX;

          if (draggedCenterX < prevTrigger && canSwap) {
            moveBookmark(draggingBookmarkId, currentIndex - 1);
            lastSwapClientXRef.current = event.clientX;
            lastSwapAtRef.current = now;
            return;
          }
        }
      }

      // Check swap with next bookmark
      if (currentIndex < currentBookmarks.length - 1) {
        const nextBookmark = currentBookmarks[currentIndex + 1];
        const nextEl = nextBookmark ? bookmarkElementRefs.current[nextBookmark.id] : null;
        if (nextEl) {
          const nextRect = nextEl.getBoundingClientRect();
          const nextTrigger = nextRect.left + nextRect.width * BOOKMARK_SWAP_TRIGGER_RATIO;
          const canSwap = lastSwapClientXRef.current === null ||
            Math.abs(event.clientX - (lastSwapClientXRef.current ?? 0)) >= BOOKMARK_SWAP_MIN_POINTER_DELTA_PX;

          if (draggedCenterX > nextTrigger && canSwap) {
            moveBookmark(draggingBookmarkId, currentIndex + 1);
            lastSwapClientXRef.current = event.clientX;
            lastSwapAtRef.current = now;
            return;
          }
        }
      }
    };

    const onMouseUp = () => {
      const moved = dragMovedRef.current;
      releasedDragIdRef.current = draggingBookmarkId;
      setDraggingBookmarkId(null);
      setDraggedPosition(null);
      setOriginalPosition(null);
      lastSwapClientXRef.current = null;
      lastSwapAtRef.current = 0;
      dragMovedRef.current = false;
      dragMovedEnoughRef.current = false;
      if (moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
    };
  }, [draggingBookmarkId, moveBookmark]);

  // Animation effect for reordering
  useLayoutEffect(() => {
    const nextRects: Record<string, DOMRect> = {};
    const releasedDragId = releasedDragIdRef.current;

    for (const item of renderedBookmarks) {
      const el = bookmarkElementRefs.current[item.bookmark.id];
      if (!el) continue;
      // Cancel any in-flight animations
      for (const animation of el.getAnimations()) {
        animation.cancel();
      }
    }

    for (const item of renderedBookmarks) {
      const bookmarkId = item.bookmark.id;
      const el = bookmarkElementRefs.current[bookmarkId];
      if (!el) continue;
      const nextRect = el.getBoundingClientRect();
      const prevRect = previousRectsRef.current[bookmarkId];

      if (bookmarkId === draggingBookmarkId) {
        // Keep the pre-drag baseline rect
        if (prevRect) {
          nextRects[bookmarkId] = prevRect;
        } else {
          nextRects[bookmarkId] = nextRect;
        }
        continue;
      }

      nextRects[bookmarkId] = nextRect;
      if (!prevRect) continue;
      if (bookmarkId === releasedDragId) continue;

      const delta = prevRect.left - nextRect.left;
      if (Math.abs(delta) < 2) continue;

      const deltaAbs = Math.abs(delta);
      const isDeliberateReorder = draggingBookmarkId
        ? deltaAbs > 4 && deltaAbs < 400
        : deltaAbs > 10 && deltaAbs < 200;
      if (!isDeliberateReorder) continue;

      // Cancel previous animations
      for (const animation of el.getAnimations()) {
        animation.cancel();
      }

      el.animate(
        [
          { transform: `translateX(${delta}px)` },
          { transform: 'translateX(0px)' },
        ],
        {
          duration: BOOKMARK_REORDER_ANIMATION_MS,
          easing: BOOKMARK_REORDER_EASING,
        },
      );
    }

    previousRectsRef.current = nextRects;
    if (releasedDragId) {
      releasedDragIdRef.current = null;
    }
  }, [renderedBookmarks, draggingBookmarkId]);

  const handleNavigate = useCallback((url: string) => {
    if (suppressClickRef.current) return;
    navigate(url);
  }, [navigate]);

  // Function to get favicon for a bookmark URL
  const getTabFavicon = (url?: string) => {
    if (!url) return undefined;

    // First try to find an open tab with this URL
    const tab = tabs.find(tab => tab.url === url);
    if (tab?.favicon) {
      return tab.favicon;
    }

    // If no open tab, try to construct favicon URL
    try {
      const urlObj = new URL(url);
      const faviconUrl = `${urlObj.origin}/favicon.ico`;
      return faviconUrl;
    } catch {
      return undefined;
    }
  };

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => closeContextMenu();
    if (contextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  // Handle bookmark native context menu commands - works for all bookmarks including nested
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;

    const handleBookmarkCommand = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || !payload) return;
      const candidate = payload as { command?: unknown; bookmarkId?: unknown };
      const command = typeof candidate.command === 'string' ? candidate.command.trim() : '';
      const bookmarkId = typeof candidate.bookmarkId === 'string' ? candidate.bookmarkId.trim() : '';
      if (!command || !bookmarkId) return;

      // Deduplicate rapid commands
      const dedupeSignature = `${command}|${bookmarkId}`;
      const now = Date.now();
      const previous = lastNativeBookmarkCommandRef.current;
      if (previous && previous.signature === dedupeSignature && now - previous.at < 250) {
        return;
      }
      lastNativeBookmarkCommandRef.current = { signature: dedupeSignature, at: now };

      // Find the bookmark anywhere in the tree
      const bookmark = getBookmarkById(bookmarkId);
      if (!bookmark) return;

      // Close parent folder if this was a nested bookmark
      const parentId = contextMenuParentFolderRef.current;
      if (parentId) {
        collapseFolderBranch(parentId);
        contextMenuParentFolderRef.current = null;
      }

      switch (command) {
        case 'open':
          if (bookmark.type === 'bookmark' && bookmark.url) {
            handleNavigate(bookmark.url);
          }
          break;
        case 'open-in-new-tab':
          if (bookmark.type === 'bookmark' && bookmark.url) {
            newTab(bookmark.url);
          }
          break;
        case 'open-in-new-window':
          if (bookmark.type === 'bookmark' && bookmark.url) {
            const renderer = electron?.ipcRenderer;
            if (renderer) {
              void renderer.invoke('window-new-with-url', bookmark.url).catch(() => undefined);
            } else {
              window.open(bookmark.url, '_blank', 'noopener,noreferrer');
            }
          }
          break;
        case 'delete':
          if (bookmark) {
            void deleteBookmark(bookmark.id);
          }
          break;
      }
    };

    ipc.on('bookmark-native-context-command', handleBookmarkCommand);
    return () => {
      ipc.off('bookmark-native-context-command', handleBookmarkCommand);
    };
  }, [bookmarks, collapseFolderBranch, handleNavigate, deleteBookmark, newTab, getBookmarkById]);

  // Context menu handlers - works for any bookmark including nested
  const handleContextMenu = (event: React.MouseEvent, bookmark: Bookmark, parentFolderId?: string) => {
    event.preventDefault();
    event.stopPropagation();

    // Store the parent folder ID so we can close it when action is selected
    contextMenuParentFolderRef.current = parentFolderId || null;

    if (nativeContextMenusEnabled && electron?.ipcRenderer) {
      setContextMenu(null);
      void electron.ipcRenderer
        .invoke('bookmark-show-native-context-menu', {
          bookmarkId: bookmark.id,
          x: event.clientX,
          y: event.clientY,
          hasUrl: bookmark.type === 'bookmark' && !!bookmark.url,
          isFolder: bookmark.type === 'folder',
        })
        .catch(() => undefined);
      return;
    }

    setContextMenu({
      anchor: { x: event.clientX, y: event.clientY },
      bookmark
    });
  };

  // Close folder when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-folder-children]') || target.closest('[data-folder-button]')) {
        return;
      }

      closeAllFolders();
    };

    if (expandedFolders.size > 0) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [closeAllFolders, expandedFolders]);

  const getContextMenuEntries = (bookmark: Bookmark): ContextMenuEntry[] => {
    const entries: ContextMenuEntry[] = [];

    // Helper to close parent folder if exists
    const closeParentFolder = () => {
      const parentId = contextMenuParentFolderRef.current;
      if (parentId) {
        collapseFolderBranch(parentId);
        contextMenuParentFolderRef.current = null;
      }
    };

    if (bookmark.type === 'bookmark' && bookmark.url) {
      entries.push({
        type: 'item',
        label: 'Open',
        onSelect: () => {
          closeParentFolder();
          if (bookmark.url) handleNavigate(bookmark.url);
        },
      });
    }

    entries.push({
      type: 'item',
      label: 'Delete',
      onSelect: () => {
        closeParentFolder();
        void deleteBookmark(bookmark.id);
      },
    });

    return entries;
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  if (topLevelBookmarks.length === 0) {
    return null;
  }

  const draggedBookmark = draggingBookmarkId && draggedPosition
    ? topLevelBookmarks.find(b => b.id === draggingBookmarkId)
    : null;

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '2px 6px',
        gap: 1,
        background: 'var(--surfaceBgHover, var(--tabBgHover))',
        borderBottom: '1px solid var(--surfaceBorder, var(--tabBorder))',
        minHeight: '26px',
        overflowX: 'auto',
        overflowY: 'hidden',
        flexShrink: 0,
        userSelect: draggingBookmarkId ? 'none' : 'auto',
      }}
    >
      {renderedBookmarks.map(({ bookmark }) => (
        <div
          key={bookmark.id}
          ref={(el) => {
            bookmarkElementRefs.current[bookmark.id] = el;
          }}
          data-bookmark-id={bookmark.id}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            // Don't start drag if clicking on folder children
            if ((event.target as HTMLElement).closest('[data-folder-children]')) return;
            const targetEl = bookmarkElementRefs.current[bookmark.id];
            if (targetEl) {
              const rect = targetEl.getBoundingClientRect();
              dragPointerToLeftRef.current = event.clientX - rect.left;
              dragPointerToTopRef.current = event.clientY - rect.top;
              setOriginalPosition({ x: rect.left, y: rect.top });
            } else {
              dragPointerToLeftRef.current = 0;
              dragPointerToTopRef.current = 0;
              setOriginalPosition({ x: event.clientX, y: event.clientY });
            }
            lastSwapClientXRef.current = null;
            lastSwapAtRef.current = 0;
            dragMovedRef.current = false;
            dragMovedEnoughRef.current = false;
            setDraggingBookmarkId(bookmark.id);
          }}
          style={{
            position: 'relative',
            zIndex: draggingBookmarkId === bookmark.id ? 20 : 1,
          }}
        >
          <BookmarkBarItem
            bookmark={bookmark}
            onNavigate={handleNavigate}
            tabFavicon={getTabFavicon(bookmark.url)}
            isDragging={draggingBookmarkId === bookmark.id && draggedPosition !== null}
            isFolderExpanded={bookmark.type === 'folder' ? expandedFolders.has(bookmark.id) : false}
            onClick={bookmark.type === 'folder' ? () => toggleFolder(bookmark.id) : undefined}
            onContextMenu={(e) => handleContextMenu(e, bookmark)}
            folderButtonId={bookmark.type === 'folder' ? bookmark.id : undefined}
            onMouseEnter={bookmark.type === 'folder' ? () => cancelPendingFolderClose() : undefined}
            onMouseLeave={bookmark.type === 'folder' ? () => scheduleFolderClose(bookmark.id) : undefined}
          />
          {/* Folder dropdown */}
          {bookmark.type === 'folder' && expandedFolders.has(bookmark.id) && bookmark.children && (
            <FolderDropdown
              bookmark={bookmark}
              folderRefs={folderRefs}
              expandedFolders={expandedFolders}
              getTabFavicon={getTabFavicon}
              handleNavigate={handleNavigate}
              handleContextMenu={handleContextMenu}
              toggleFolder={toggleFolder}
              closeAllFolders={closeAllFolders}
              cancelPendingFolderClose={cancelPendingFolderClose}
              scheduleFolderClose={scheduleFolderClose}
              collapseChildFolderBranches={collapseChildFolderBranches}
            />
          )}
        </div>
      ))}

      {/* Drag overlay */}
      {draggedBookmark && draggedPosition && originalPosition && (
        <div
          style={{
            position: 'fixed',
            left: draggedPosition.x - dragPointerToLeftRef.current,
            top: originalPosition.y,
            zIndex: 1000,
            pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
            borderRadius: '3px',
            background: 'var(--surfaceBg, white)',
          }}
        >
          <BookmarkBarItem
            bookmark={draggedBookmark}
            onNavigate={() => { }}
            tabFavicon={getTabFavicon(draggedBookmark.url)}
            isDragOverlay={true}
          />
        </div>
      )}

      {/* Context Menu - only show when native menus are disabled */}
      <ContextMenu
        open={!nativeContextMenusEnabled && !!contextMenu}
        anchor={contextMenu?.anchor || null}
        entries={contextMenu ? getContextMenuEntries(contextMenu.bookmark) : []}
        onClose={closeContextMenu}
        minWidth={150}
      />


    </div>
  );
}
