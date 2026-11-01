/**
 * Frozen tab state data for preservation during sleep.
 */
export type FrozenTabState = {
  scrollX: number;
  scrollY: number;
  formData: Array<{
    id: string;
    name: string;
    type: string;
    value: string;
    checked?: boolean;
    selectedIndex?: number;
  }>;
  textSelections: Array<{
    start: number;
    end: number;
    text: string;
    elementId?: string;
  }>;
  focusedElementId?: string;
  timestamp: number;
};

/**
 * In-memory tab model for navigation state and tab lifecycle flags.
 */
export type Tab = {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isPinned?: boolean;
  history: string[];
  historyIndex: number;
  reloadToken: number;
  isSleeping: boolean;
  lastActiveAt: number;
  /** Restored background content is not mounted until the tab is selected. */
  restoreDeferred?: boolean;
  frozenState?: FrozenTabState;
  transferredGuestInstance?: string;
  detachedTransferId?: string;
  transferredWebContentsId?: number;
  authFlowSourceTabId?: string;
  authFlowInitialUrl?: string;
};
