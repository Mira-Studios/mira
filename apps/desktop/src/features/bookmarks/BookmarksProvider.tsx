import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import { confirmDialog } from '../../components/appDialogs';

export type Bookmark = {
  id: string;
  title: string;
  type: 'bookmark' | 'folder';
  url?: string;
  parentId?: string;
  children?: Bookmark[];
  createdAt: number;
  updatedAt: number;
};

type BookmarksContextType = {
  bookmarks: Bookmark[];
  addBookmark: (bookmark: Omit<Bookmark, 'id' | 'createdAt' | 'updatedAt'>) => void;
  deleteBookmark: (id: string) => Promise<void>;
  updateBookmark: (bookmark: Bookmark) => void;
  getBookmarkById: (id: string) => Bookmark | undefined;
  moveBookmark: (id: string, toIndex: number) => void;
  moveBookmarkInFolder: (id: string, folderId: string | undefined, toIndex: number) => void;
  moveBookmarkToFolder: (id: string, targetFolderId: string | null) => void;
};

const BookmarksContext = createContext<BookmarksContextType | undefined>(undefined);

const STORAGE_KEY = 'mira.bookmarks.v1';

function generateId(): string {
  return `bookmark_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function loadBookmarksFromStorage(): Bookmark[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBookmarksToStorage(bookmarks: Bookmark[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
    // Silent fail for storage issues
  }
}

function findBookmarkById(bookmarks: Bookmark[], id: string): Bookmark | undefined {
  for (const bookmark of bookmarks) {
    if (bookmark.id === id) return bookmark;
    if (bookmark.children) {
      const found = findBookmarkById(bookmark.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function bookmarkTreeContainsId(bookmarks: Bookmark[] | undefined, id: string): boolean {
  if (!bookmarks) return false;
  return findBookmarkById(bookmarks, id) !== undefined;
}

function deleteBookmarkFromTree(bookmarks: Bookmark[], id: string): Bookmark[] {
  return bookmarks
    .filter(bookmark => bookmark.id !== id)
    .map(bookmark => ({
      ...bookmark,
      children: bookmark.children ? deleteBookmarkFromTree(bookmark.children, id) : undefined
    }));
}

function updateBookmarkInTree(bookmarks: Bookmark[], updatedBookmark: Bookmark): Bookmark[] {
  return bookmarks.map(bookmark => {
    if (bookmark.id === updatedBookmark.id) {
      return { ...updatedBookmark, updatedAt: Date.now() };
    }
    if (bookmark.children) {
      return {
        ...bookmark,
        children: updateBookmarkInTree(bookmark.children, updatedBookmark)
      };
    }
    return bookmark;
  });
}

function moveBookmarkInTree(bookmarks: Bookmark[], id: string, toIndex: number): Bookmark[] {
  const fromIndex = bookmarks.findIndex(b => b.id === id);
  if (fromIndex === -1) return bookmarks;

  const normalizedToIndex = Math.floor(toIndex);
  if (!Number.isFinite(normalizedToIndex)) return bookmarks;

  const boundedTargetIndex = Math.max(0, Math.min(normalizedToIndex, bookmarks.length - 1));
  if (boundedTargetIndex === fromIndex) {
    return bookmarks;
  }

  const nextBookmarks = [...bookmarks];
  const [moved] = nextBookmarks.splice(fromIndex, 1);
  const boundedIndex = Math.max(0, Math.min(boundedTargetIndex, nextBookmarks.length));
  nextBookmarks.splice(boundedIndex, 0, moved);
  return nextBookmarks;
}
function findBookmarkAndParent(bookmarks: Bookmark[], id: string, parent: Bookmark | null = null): { bookmark: Bookmark | undefined; parent: Bookmark | null; parentArray: Bookmark[] } {
  for (let i = 0; i < bookmarks.length; i++) {
    const bookmark = bookmarks[i];
    if (bookmark.id === id) {
      return { bookmark, parent, parentArray: bookmarks };
    }
    if (bookmark.children) {
      const found = findBookmarkAndParent(bookmark.children, id, bookmark);
      if (found.bookmark) return found;
    }
  }
  return { bookmark: undefined, parent: null, parentArray: [] };
}

function removeBookmarkFromTree(bookmarks: Bookmark[], id: string): Bookmark[] {
  return bookmarks
    .filter(b => b.id !== id)
    .map(b => ({
      ...b,
      children: b.children ? removeBookmarkFromTree(b.children, id) : undefined
    }));
}

function addBookmarkToFolder(bookmarks: Bookmark[], bookmark: Bookmark, folderId: string): Bookmark[] {
  return bookmarks.map(b => {
    if (b.id === folderId && b.type === 'folder') {
      return {
        ...b,
        children: [...(b.children || []), bookmark],
        updatedAt: Date.now(),
      };
    }
    if (b.children) {
      return {
        ...b,
        children: addBookmarkToFolder(b.children, bookmark, folderId)
      };
    }
    return b;
  });
}

function moveBookmarkBetweenParents(bookmarks: Bookmark[], id: string, targetFolderId: string | null): Bookmark[] {
  // Find the bookmark
  const { bookmark } = findBookmarkAndParent(bookmarks, id);
  
  if (!bookmark) return bookmarks;
  if (targetFolderId === id) return bookmarks;
  if (bookmark.type === 'folder' && bookmarkTreeContainsId(bookmark.children, targetFolderId ?? '')) {
    return bookmarks;
  }
  
  // Remove from current location
  let newBookmarks = removeBookmarkFromTree(bookmarks, id);
  
  // Update the bookmark's parentId
  const updatedBookmark = { ...bookmark, parentId: targetFolderId || undefined, updatedAt: Date.now() };
  
  // Add to target folder or root
  if (targetFolderId) {
    newBookmarks = addBookmarkToFolder(newBookmarks, updatedBookmark, targetFolderId);
  } else {
    // Add to root
    newBookmarks = [...newBookmarks, updatedBookmark];
  }
  
  return newBookmarks;
}

function moveBookmarkInTreeAtParent(
  bookmarks: Bookmark[],
  id: string,
  folderId: string | undefined,
  toIndex: number
): Bookmark[] {
  // If folderId is undefined, we're moving at root level
  if (!folderId) {
    return moveBookmarkInTree(bookmarks, id, toIndex);
  }

  // Find the folder and move within its children
  return bookmarks.map(b => {
    if (b.id === folderId && b.type === 'folder' && b.children) {
      const fromIndex = b.children.findIndex(child => child.id === id);
      if (fromIndex === -1) return b;
      
      const boundedTargetIndex = Math.max(0, Math.min(toIndex, b.children.length - 1));
      if (boundedTargetIndex === fromIndex) return b;
      
      const nextChildren = [...b.children];
      const [moved] = nextChildren.splice(fromIndex, 1);
      const boundedIndex = Math.max(0, Math.min(boundedTargetIndex, nextChildren.length));
      nextChildren.splice(boundedIndex, 0, moved);
      
      return { ...b, children: nextChildren, updatedAt: Date.now() };
    }
    if (b.children) {
      return { ...b, children: moveBookmarkInTreeAtParent(b.children, id, folderId, toIndex) };
    }
    return b;
  });
}

function addBookmarkToTree(
  bookmarks: Bookmark[], 
  newBookmark: Omit<Bookmark, 'id' | 'createdAt' | 'updatedAt'>,
  parentId?: string
): Bookmark[] {
  const bookmark: Bookmark = {
    ...newBookmark,
    id: generateId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (!parentId) {
    return [...bookmarks, bookmark];
  }

  return bookmarks.map(existingBookmark => {
    if (existingBookmark.id === parentId && existingBookmark.type === 'folder') {
      return {
        ...existingBookmark,
        children: [...(existingBookmark.children || []), bookmark],
        updatedAt: Date.now(),
      };
    }
    if (existingBookmark.children) {
      return {
        ...existingBookmark,
        children: addBookmarkToTree(existingBookmark.children, newBookmark, parentId)
      };
    }
    return existingBookmark;
  });
}

export function BookmarksProvider({ children }: { children: ReactNode }) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => loadBookmarksFromStorage());
  const pendingDeletions = useRef(new Set<string>());

  const addBookmark = useCallback((bookmark: Omit<Bookmark, 'id' | 'createdAt' | 'updatedAt'>) => {
    setBookmarks(prev => {
      const updated = addBookmarkToTree(prev, bookmark, bookmark.parentId);
      saveBookmarksToStorage(updated);
      return updated;
    });
  }, []);

  const deleteBookmark = useCallback(async (id: string) => {
    const bookmark = findBookmarkById(bookmarks, id);
    if (!bookmark || pendingDeletions.current.has(id)) return;
    pendingDeletions.current.add(id);
    try {
      const confirmed = await confirmDialog({
        title: bookmark.type === 'folder' ? 'Delete this folder?' : 'Delete this bookmark?',
        message: bookmark.type === 'folder' ? `${bookmark.title} and its bookmarks will be deleted.` : bookmark.title,
        confirmLabel: 'Delete',
      });
      if (!confirmed) return;
      setBookmarks(prev => {
        const updated = deleteBookmarkFromTree(prev, id);
        saveBookmarksToStorage(updated);
        return updated;
      });
    } finally {
      pendingDeletions.current.delete(id);
    }
  }, [bookmarks]);

  const updateBookmark = useCallback((bookmark: Bookmark) => {
    setBookmarks(prev => {
      const updated = updateBookmarkInTree(prev, bookmark);
      saveBookmarksToStorage(updated);
      return updated;
    });
  }, []);

  const getBookmarkById = useCallback((id: string): Bookmark | undefined => {
    return findBookmarkById(bookmarks, id);
  }, [bookmarks]);

  const moveBookmarkInFolder = useCallback((id: string, folderId: string | undefined, toIndex: number) => {
    if (!id) return;

    setBookmarks(prev => {
      const updated = moveBookmarkInTreeAtParent(prev, id, folderId, toIndex);
      saveBookmarksToStorage(updated);
      return updated;
    });
  }, []);

  const moveBookmark = useCallback((id: string, toIndex: number) => {
    if (!id) return;

    setBookmarks(prev => {
      const updated = moveBookmarkInTree(prev, id, toIndex);
      saveBookmarksToStorage(updated);
      return updated;
    });
  }, []);

  const moveBookmarkToFolder = useCallback((id: string, targetFolderId: string | null) => {
    if (!id) return;

    setBookmarks(prev => {
      const updated = moveBookmarkBetweenParents(prev, id, targetFolderId);
      saveBookmarksToStorage(updated);
      return updated;
    });
  }, []);

  return (
    <BookmarksContext.Provider value={{
      bookmarks,
      addBookmark,
      deleteBookmark,
      updateBookmark,
      getBookmarkById,
      moveBookmark,
      moveBookmarkInFolder,
      moveBookmarkToFolder,
    }}>
      {children}
    </BookmarksContext.Provider>
  );
}

export function useBookmarks(): BookmarksContextType {
  const context = useContext(BookmarksContext);
  if (context === undefined) {
    throw new Error('useBookmarks must be used within a BookmarksProvider');
  }
  return context;
}
