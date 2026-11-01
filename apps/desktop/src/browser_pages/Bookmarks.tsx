import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useTabs } from '../features/tabs/TabsProvider';
import type { Bookmark } from '../features/bookmarks/BookmarksProvider';
import { useBookmarks } from '../features/bookmarks/BookmarksProvider';
import { Folder, FolderOpen, Plus, Trash2, Edit2, X, Check, GripVertical } from 'lucide-react';

// Drag configuration - matching BookmarksBar style
const SWAP_TRIGGER_RATIO = 0.5;
const SWAP_MIN_POINTER_DELTA_PX = 5;
const SWAP_COOLDOWN_MS = 50;
const REORDER_ANIMATION_MS = 150;
const REORDER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const DRAG_THRESHOLD_PX = 3;

interface DragState {
  bookmarkId: string | null;
  parentId: string | undefined;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  movedEnough: boolean;
  pointerToItemTop: number;
  pointerToItemLeft: number;
  dropTargetFolderId: string | null;
}

function BookmarkItem({
  bookmark,
  level = 0,
  onDelete,
  onEdit,
  expandedFolders,
  onToggleFolder,
  onStartDrag,
  draggedBookmarkId,
  isDragActive,
  dropTargetFolderId,
  dragPosition,
  parentId,
  itemRef,
  style,
  suppressClickRef,
}: {
  bookmark: Bookmark;
  level?: number;
  onDelete: (id: string) => void;
  onEdit: (bookmark: Bookmark) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (id: string) => void;
  onStartDrag: (bookmarkId: string, parentId: string | undefined, x: number, y: number, pointerToTop: number, pointerToLeft: number) => void;
  draggedBookmarkId: string | null;
  isDragActive: boolean;
  dropTargetFolderId: string | null;
  dragPosition: { x: number; y: number } | null;
  parentId?: string;
  itemRef: (el: HTMLDivElement | null, bookmarkId: string) => void;
  style?: React.CSSProperties;
  suppressClickRef?: React.RefObject<boolean>;
}) {
  const { navigate, tabs } = useTabs();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(bookmark.title);
  const [editUrl, setEditUrl] = useState(bookmark.url || '');
  const [isHovered, setIsHovered] = useState(false);
  const elementRef = useRef<HTMLDivElement>(null);
  const isDraggedItem = draggedBookmarkId === bookmark.id;
  const isDropTarget = bookmark.type === 'folder' && dropTargetFolderId === bookmark.id;

  const handleSave = () => {
    onEdit({ ...bookmark, title: editTitle, url: editUrl });
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditTitle(bookmark.title);
    setEditUrl(bookmark.url || '');
    setIsEditing(false);
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
  };

  const handleClick = (e: React.MouseEvent) => {
    // Suppress click if it was just after a drag
    if (suppressClickRef?.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || isEditing) {
      return;
    }
    if (bookmark.type === 'folder') {
      onToggleFolder(bookmark.id);
      return;
    }
    if (bookmark.url) navigate(bookmark.url);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.closest('.drag-handle')) return;
    
    e.preventDefault();
    
    const rect = elementRef.current?.getBoundingClientRect();
    const pointerToTop = rect ? e.clientY - rect.top : 0;
    const pointerToLeft = rect ? e.clientX - rect.left : 0;
    
    onStartDrag(bookmark.id, parentId, e.clientX, e.clientY, pointerToTop, pointerToLeft);
  };

  // Get favicon
  const getTabFavicon = (url?: string) => {
    if (!url) return undefined;
    const tab = tabs.find(tab => tab.url === url);
    if (tab?.favicon) return tab.favicon;
    try {
      const urlObj = new URL(url);
      return `${urlObj.origin}/favicon.ico`;
    } catch {
      return undefined;
    }
  };

  const tabFavicon = getTabFavicon(bookmark.url);

  const icon = bookmark.type === 'folder'
    ? (expandedFolders.has(bookmark.id) ? <FolderOpen size={16} /> : <Folder size={16} />)
    : tabFavicon ? (
      <img
        src={tabFavicon}
        alt=""
        style={{ width: 16, height: 16, display: 'block' }}
        onError={(e) => {
          const target = e.target as HTMLImageElement;
          target.style.display = 'none';
          const fallback = target.nextElementSibling as HTMLElement;
          if (fallback) fallback.style.display = 'block';
        }}
      />
    ) : null;

  return (
    <div data-mira-prevent-suspension={isEditing} style={{ paddingLeft: level * 20 }}>
      <div
        ref={(el) => {
          elementRef.current = el;
          itemRef(el, bookmark.id);
        }}
        data-folder-id={bookmark.type === 'folder' ? bookmark.id : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 12px',
          borderRadius: 4,
          cursor: bookmark.type === 'folder' ? 'default' : 'pointer',
          border: isDropTarget 
            ? '2px solid var(--accentPrimary, #8f8f85)' 
            : isHovered 
              ? '1px solid var(--surfaceBorder)' 
              : '1px solid transparent',
          backgroundColor: isDropTarget
            ? 'color-mix(in srgb, var(--accentPrimary) 15%, transparent)'
            : isDraggedItem && isDragActive
              ? 'var(--surfaceBgHover)' 
              : isHovered 
                ? 'var(--surfaceBgHover)' 
                : 'transparent',
          transition: 'background-color 0.15s ease, border-color 0.15s ease',
          position: 'relative',
          opacity: isDraggedItem && isDragActive ? 0.3 : undefined,
          ...style,
        }}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Drag handle */}
        <div
          className="drag-handle"
          onMouseDown={handleMouseDown}
          style={{
            marginRight: 8,
            color: 'var(--text3)',
            display: 'flex',
            alignItems: 'center',
            cursor: 'grab',
            opacity: 0.5,
          }}
          title="Drag to reorder"
        >
          <GripVertical size={16} />
        </div>

        <div style={{ marginRight: 8, color: 'var(--text3)', display: 'flex', alignItems: 'center' }}>
          {bookmark.type === 'folder' ? (
            icon
          ) : (
            <>
              {icon}
              {!icon && (
                <div 
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: '3px',
                    background: 'var(--accent)',
                    display: 'block'
                  }}
                />
              )}
            </>
          )}
        </div>

        {isEditing ? (
          <div style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="theme-input"
              style={{ flex: 1, fontSize: 13 }}
              placeholder="Title"
            />
            {bookmark.type === 'bookmark' && (
              <input
                type="text"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                className="theme-input"
                style={{ flex: 2, fontSize: 13 }}
                placeholder="URL"
              />
            )}
            <button
              onClick={handleSave}
              className="theme-btn theme-btn-go"
              style={{ padding: '4px 8px', fontSize: 12 }}
            >
              <Check size={14} />
            </button>
            <button
              onClick={handleCancel}
              className="theme-btn theme-btn-nav"
              style={{ padding: '4px 8px', fontSize: 12 }}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={bookmark.title}
              >
                {bookmark.title}
              </div>
              {bookmark.type === 'bookmark' && bookmark.url && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text3)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={bookmark.url}
                >
                  {bookmark.url}
                </div>
              )}
              {bookmark.type === 'folder' && bookmark.children && (
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {bookmark.children.length} items
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsEditing(true);
                }}
                className="theme-btn theme-btn-nav"
                style={{ padding: '4px 8px', fontSize: 12 }}
                title="Edit"
              >
                <Edit2 size={14} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(bookmark.id);
                }}
                className="theme-btn theme-btn-nav"
                style={{ padding: '4px 8px', fontSize: 12 }}
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Dragged item overlay - follows mouse */}
      {isDraggedItem && isDragActive && dragPosition && (
        <div
          style={{
            position: 'fixed',
            left: dragPosition.x,
            top: dragPosition.y,
            zIndex: 1000,
            pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
            borderRadius: '4px',
            background: 'var(--surfaceBg, #1d1d1d)',
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            opacity: 0.9,
            width: elementRef.current?.getBoundingClientRect().width,
          }}
        >
          <GripVertical size={16} color="var(--text3)" />
          <div style={{ color: 'var(--text3)', display: 'flex', alignItems: 'center' }}>
            {icon}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text1)' }}>
            {bookmark.title}
          </div>
        </div>
      )}

      {bookmark.type === 'folder' && expandedFolders.has(bookmark.id) && bookmark.children?.map((child: Bookmark) => (
        <BookmarkItem
          key={child.id}
          bookmark={child}
          level={level + 1}
          onDelete={onDelete}
          onEdit={onEdit}
          expandedFolders={expandedFolders}
          onToggleFolder={onToggleFolder}
          onStartDrag={onStartDrag}
          draggedBookmarkId={draggedBookmarkId}
          isDragActive={isDragActive}
          dropTargetFolderId={dropTargetFolderId}
          dragPosition={dragPosition}
          parentId={bookmark.id}
          itemRef={itemRef}
          suppressClickRef={suppressClickRef}
        />
      ))}
    </div>
  );
}

export default function Bookmarks() {
  const { bookmarks, addBookmark, deleteBookmark, updateBookmark, moveBookmark, moveBookmarkToFolder, moveBookmarkInFolder, getBookmarkById } = useBookmarks();
  const [showAddBookmarkForm, setShowAddBookmarkForm] = useState(false);
  const [showAddFolderForm, setShowAddFolderForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Drag state
  const [dragState, setDragState] = useState<DragState>({
    bookmarkId: null,
    parentId: undefined,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    movedEnough: false,
    pointerToItemTop: 0,
    pointerToItemLeft: 0,
    dropTargetFolderId: null,
  });

  const itemElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const previousRectsRef = useRef<Record<string, DOMRect>>({});
  const lastSwapClientYRef = useRef<number | null>(null);
  const lastSwapAtRef = useRef<number>(0);
  const dragMovedRef = useRef<boolean>(false);
  const suppressClickRef = useRef<boolean>(false);
  const isOverFolderRef = useRef<boolean>(false);
  const folderTimeoutRef = useRef<number | null>(null);
  const dragOutOfFolderRef = useRef<boolean>(false);

  const handleStartDrag = useCallback((bookmarkId: string, parentId: string | undefined, x: number, y: number, pointerToTop: number, pointerToLeft: number) => {
    // If dragging a folder, collapse it first
    const bookmark = getBookmarkById(bookmarkId);
    if (bookmark?.type === 'folder') {
      setExpandedFolders(prev => {
        const newSet = new Set(prev);
        newSet.delete(bookmarkId);
        return newSet;
      });
    }
    
    setDragState({
      bookmarkId,
      parentId,
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
      movedEnough: false,
      pointerToItemTop: pointerToTop,
      pointerToItemLeft: pointerToLeft,
      dropTargetFolderId: null,
    });
    lastSwapClientYRef.current = null;
    lastSwapAtRef.current = 0;
    dragMovedRef.current = false;
    isOverFolderRef.current = false;
  }, [getBookmarkById]);

  // Handle global mouse move during drag
  useEffect(() => {
    if (!dragState.bookmarkId) return;

    const onMouseMove = (event: MouseEvent) => {
      setDragState(prev => {
        if (!prev.bookmarkId) return prev;

        const movedEnough = prev.movedEnough ||
          Math.abs(event.clientX - prev.startX) > DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - prev.startY) > DRAG_THRESHOLD_PX;

        if (movedEnough && !prev.movedEnough) {
          dragMovedRef.current = true;
        }

        // Check if hovering over a folder
        const elements = document.elementsFromPoint(event.clientX, event.clientY);
        let overFolderId: string | null = null;
        for (const el of elements) {
          const folderEl = el.closest('[data-folder-id]');
          if (folderEl) {
            const folderId = folderEl.getAttribute('data-folder-id');
            if (folderId && folderId !== prev.bookmarkId) {
              overFolderId = folderId;
              break;
            }
          }
        }

        // Check if dragging left to exit folder (only for nested items)
        const draggedToLeft = prev.parentId && event.clientX < (prev.startX - 50);
        if (draggedToLeft) {
          dragOutOfFolderRef.current = true;
        } else if (prev.parentId) {
          // Reset if they drag back right
          dragOutOfFolderRef.current = false;
        }
        if (overFolderId && !isOverFolderRef.current) {
          isOverFolderRef.current = true;
          if (folderTimeoutRef.current) {
            window.clearTimeout(folderTimeoutRef.current);
          }
          folderTimeoutRef.current = window.setTimeout(() => {
            setExpandedFolders(prevFolders => {
              if (!prevFolders.has(overFolderId!)) {
                const newSet = new Set(prevFolders);
                newSet.add(overFolderId!);
                return newSet;
              }
              return prevFolders;
            });
          }, 500);
        } else if (!overFolderId) {
          isOverFolderRef.current = false;
          if (folderTimeoutRef.current) {
            window.clearTimeout(folderTimeoutRef.current);
            folderTimeoutRef.current = null;
          }
        }

        return {
          ...prev,
          currentX: event.clientX,
          currentY: event.clientY,
          movedEnough,
          dropTargetFolderId: overFolderId,
        };
      });

      // Handle swapping - only after moved enough and not over a folder
      if (!dragState.movedEnough || dragState.dropTargetFolderId) return;

      const bookmarkId = dragState.bookmarkId;
      const parentId = dragState.parentId;
      if (!bookmarkId) return;

      // Helper to find folder and its children anywhere in the tree
      function findFolderChildren(bookmarks: Bookmark[], folderId: string): Bookmark[] | null {
        for (const b of bookmarks) {
          if (b.id === folderId && b.type === 'folder') {
            return b.children || [];
          }
          if (b.children) {
            const found = findFolderChildren(b.children, folderId);
            if (found) return found;
          }
        }
        return null;
      }

      // Find the array containing the bookmark (root or folder children)
      let currentBookmarks: Bookmark[];
      if (parentId) {
        // Find the parent folder recursively and use its children
        const children = findFolderChildren(bookmarks, parentId);
        currentBookmarks = children || [];
      } else {
        currentBookmarks = bookmarks;
      }
      
      const currentIndex = currentBookmarks.findIndex((b) => b.id === bookmarkId);
      if (currentIndex === -1) return;

      const now = Date.now();
      if (now - lastSwapAtRef.current < SWAP_COOLDOWN_MS) return;

      const draggedCenterY = event.clientY;

      // Check swap with previous bookmark
      if (currentIndex > 0) {
        const prevBookmark = currentBookmarks[currentIndex - 1];
        const prevEl = prevBookmark ? itemElementsRef.current.get(prevBookmark.id) : null;
        if (prevEl) {
          const prevRect = prevEl.getBoundingClientRect();
          const prevTrigger = prevRect.top + prevRect.height * (1 - SWAP_TRIGGER_RATIO);
          const canSwap = lastSwapClientYRef.current === null ||
            Math.abs(event.clientY - (lastSwapClientYRef.current ?? 0)) >= SWAP_MIN_POINTER_DELTA_PX;

          if (draggedCenterY < prevTrigger && canSwap) {
            if (parentId) {
              moveBookmarkInFolder(bookmarkId, parentId, currentIndex - 1);
            } else {
              moveBookmark(bookmarkId, currentIndex - 1);
            }
            lastSwapClientYRef.current = event.clientY;
            lastSwapAtRef.current = now;
            return;
          }
        }
      }

      // Check swap with next bookmark
      if (currentIndex < currentBookmarks.length - 1) {
        const nextBookmark = currentBookmarks[currentIndex + 1];
        const nextEl = nextBookmark ? itemElementsRef.current.get(nextBookmark.id) : null;
        if (nextEl) {
          const nextRect = nextEl.getBoundingClientRect();
          const nextTrigger = nextRect.top + nextRect.height * SWAP_TRIGGER_RATIO;
          const canSwap = lastSwapClientYRef.current === null ||
            Math.abs(event.clientY - (lastSwapClientYRef.current ?? 0)) >= SWAP_MIN_POINTER_DELTA_PX;

          if (draggedCenterY > nextTrigger && canSwap) {
            if (parentId) {
              moveBookmarkInFolder(bookmarkId, parentId, currentIndex + 1);
            } else {
              moveBookmark(bookmarkId, currentIndex + 1);
            }
            lastSwapClientYRef.current = event.clientY;
            lastSwapAtRef.current = now;
            return;
          }
        }
      }
    };

    const onMouseUp = () => {
      const moved = dragMovedRef.current;
      const dropFolderId = dragState.dropTargetFolderId;
      const draggedBookmarkId = dragState.bookmarkId;
      const draggedParentId = dragState.parentId;
      
      // If dragged left from a folder, move to parent/grandparent level
      if (draggedBookmarkId && moved && draggedParentId && dragOutOfFolderRef.current) {
        // Move to root (or could find parent of parent for nested folders)
        moveBookmarkToFolder(draggedBookmarkId, null);
      }
      // If dropped on a folder, move bookmark into that folder
      else if (draggedBookmarkId && dropFolderId && moved) {
        moveBookmarkToFolder(draggedBookmarkId, dropFolderId);
      }
      // If dragged from a folder to root area (not over any folder), move to root
      else if (draggedBookmarkId && moved && draggedParentId && !dropFolderId) {
        moveBookmarkToFolder(draggedBookmarkId, null);
      }
      
      dragOutOfFolderRef.current = false;
      
      if (folderTimeoutRef.current) {
        window.clearTimeout(folderTimeoutRef.current);
        folderTimeoutRef.current = null;
      }
      
      setDragState({
        bookmarkId: null,
        parentId: undefined,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0,
        movedEnough: false,
        pointerToItemTop: 0,
        pointerToItemLeft: 0,
        dropTargetFolderId: null,
      });
      
      lastSwapClientYRef.current = null;
      lastSwapAtRef.current = 0;
      dragMovedRef.current = false;
      isOverFolderRef.current = false;
      
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
  }, [dragState.bookmarkId, dragState.movedEnough, dragState.dropTargetFolderId, dragState.parentId, bookmarks, moveBookmark, moveBookmarkToFolder, moveBookmarkInFolder]);

  // Animation effect for reordering
  useLayoutEffect(() => {
    const nextRects: Record<string, DOMRect> = {};

    itemElementsRef.current.forEach((el, bookmarkId) => {
      if (!el) return;
      
      // Cancel any in-flight animations
      for (const animation of el.getAnimations()) {
        animation.cancel();
      }

      const nextRect = el.getBoundingClientRect();
      const prevRect = previousRectsRef.current[bookmarkId];

      nextRects[bookmarkId] = nextRect;

      if (!prevRect) return;
      if (bookmarkId === dragState.bookmarkId) return; // Don't animate the dragged item
      
      const deltaY = prevRect.top - nextRect.top;
      if (Math.abs(deltaY) < 2) return;

      el.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: 'translateY(0px)' },
        ],
        {
          duration: REORDER_ANIMATION_MS,
          easing: REORDER_EASING,
        },
      );
    });

    previousRectsRef.current = nextRects;
  }, [bookmarks, dragState.bookmarkId]);

  const handleAddBookmark = () => {
    const title = newTitle.trim();
    if (!title) return;

    addBookmark({
      title,
      type: 'bookmark',
      url: newUrl.trim() || undefined,
      parentId: selectedParent || undefined,
    });
    setNewTitle('');
    setNewUrl('');
    setSelectedParent(null);
    setShowAddBookmarkForm(false);
  };

  const handleAddFolder = () => {
    const title = newTitle.trim();
    if (!title) return;

    addBookmark({
      title,
      type: 'folder',
      parentId: selectedParent || undefined,
      children: [],
    });
    setNewTitle('');
    setSelectedParent(null);
    setShowAddFolderForm(false);
  };

  const closeForms = () => {
    setShowAddBookmarkForm(false);
    setShowAddFolderForm(false);
    setNewTitle('');
    setNewUrl('');
    setSelectedParent(null);
  };

  const handleDelete = (id: string) => {
    void deleteBookmark(id);
  };

  const handleEdit = (bookmark: Bookmark) => {
    updateBookmark(bookmark);
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
      }
      return newSet;
    });
  };

  const renderBookmarkOptions = (bookmark: Bookmark, level = 0): string => {
    const indent = '\u3000'.repeat(level);
    return `${indent}${bookmark.title}`;
  };

  const getAllBookmarksForSelect = (bookmarks: Bookmark[], level = 0): Array<{ value: string; label: string }> => {
    const options: Array<{ value: string; label: string }> = [];

    for (const bookmark of bookmarks) {
      if (bookmark.type === 'folder') {
        options.push({
          value: bookmark.id,
          label: renderBookmarkOptions(bookmark, level),
        });
        if (bookmark.children) {
          options.push(...getAllBookmarksForSelect(bookmark.children, level + 1));
        }
      }
    }

    return options;
  };

  const folderOptions = getAllBookmarksForSelect(bookmarks);

  const itemRefCallback = (el: HTMLDivElement | null, bookmarkId: string) => {
    if (el) {
      itemElementsRef.current.set(bookmarkId, el);
    } else {
      itemElementsRef.current.delete(bookmarkId);
    }
  };

  // Calculate drag position
  const dragPosition = dragState.bookmarkId && dragState.movedEnough
    ? { 
        x: dragState.currentX - dragState.pointerToItemLeft, 
        y: dragState.currentY - dragState.pointerToItemTop 
      }
    : null;

  return (
    <div data-mira-prevent-suspension={showAddBookmarkForm || showAddFolderForm}
      style={{ padding: 20, background: 'var(--bg)', color: 'var(--text1)', minHeight: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Bookmarks</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => {
              closeForms();
              setShowAddFolderForm(true);
            }}
            className="theme-btn theme-btn-nav"
            style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <Folder size={16} />
            New Folder
          </button>
          <button
            onClick={() => {
              closeForms();
              setShowAddBookmarkForm(true);
            }}
            className="theme-btn theme-btn-go"
            style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <Plus size={16} />
            Add Bookmark
          </button>
        </div>
      </div>

      {showAddBookmarkForm && (
        <div className="theme-panel" style={{ padding: 16, marginBottom: 20, borderRadius: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Add Bookmark</h3>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Title"
              className="theme-input"
              style={{ padding: '8px 12px', fontSize: 13 }}
            />
            <input
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="URL (e.g., https://example.com)"
              className="theme-input"
              style={{ padding: '8px 12px', fontSize: 13 }}
            />
            {folderOptions.length > 0 && (
              <select
                value={selectedParent || ''}
                onChange={(e) => setSelectedParent(e.target.value || null)}
                className="theme-input"
                style={{ padding: '8px 12px', fontSize: 13 }}
              >
                <option value="">Root level</option>
                {folderOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleAddBookmark}
                className="theme-btn theme-btn-go"
                style={{ padding: '8px 16px' }}
              >
                Add
              </button>
              <button
                onClick={closeForms}
                className="theme-btn theme-btn-nav"
                style={{ padding: '8px 16px' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddFolderForm && (
        <div className="theme-panel" style={{ padding: 16, marginBottom: 20, borderRadius: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>New Folder</h3>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Folder name"
              className="theme-input"
              style={{ padding: '8px 12px', fontSize: 13 }}
            />
            {folderOptions.length > 0 && (
              <select
                value={selectedParent || ''}
                onChange={(e) => setSelectedParent(e.target.value || null)}
                className="theme-input"
                style={{ padding: '8px 12px', fontSize: 13 }}
              >
                <option value="">Root level</option>
                {folderOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleAddFolder}
                className="theme-btn theme-btn-go"
                style={{ padding: '8px 16px' }}
              >
                Create
              </button>
              <button
                onClick={closeForms}
                className="theme-btn theme-btn-nav"
                style={{ padding: '8px 16px' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {bookmarks.length === 0 ? (
        <div className="theme-text2" style={{ textAlign: 'center', padding: 40 }}>
          No bookmarks yet. Click "Add Bookmark" or "New Folder" to get started.
        </div>
      ) : (
        <div className="theme-panel" style={{ borderRadius: 8, overflow: 'hidden' }}>
          {bookmarks.map((bookmark) => (
            <div key={bookmark.id}>
              <BookmarkItem
                bookmark={bookmark}
                onDelete={handleDelete}
                onEdit={handleEdit}
                expandedFolders={expandedFolders}
                onToggleFolder={toggleFolder}
                onStartDrag={handleStartDrag}
                draggedBookmarkId={dragState.bookmarkId}
                isDragActive={dragState.movedEnough}
                dropTargetFolderId={dragState.dropTargetFolderId}
                dragPosition={dragPosition}
                itemRef={itemRefCallback}
                suppressClickRef={suppressClickRef}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
