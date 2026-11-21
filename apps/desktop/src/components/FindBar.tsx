import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTabs } from '../features/tabs/TabsProvider';
import { isEditorUrl } from '../features/editor/editorLifecycle';
import { usePromptPresence } from '../hooks/usePromptPresence';
import { electron } from '../electronBridge';
import './FindBar.css';

type FindBarProps = { open: boolean; focusToken: number; onClose: () => void };

export default function FindBar({ open, focusToken, onClose }: FindBarProps) {
  const {
    tabs,
    activeId,
    searchInPage,
    stopFindInPage,
    findInPageActiveMatchOrdinal,
    findInPageMatches,
    findInPageSearching,
  } = useTabs();
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useMemo(() => (open ? { requestId: 'find-in-page' } : null), [open]);
  const { displayed, closing, animated } = usePromptPresence(request);
  const visible = !!displayed;
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const canSearch =
    !!activeTab && (!activeTab.url.startsWith('mira://') || isEditorUrl(activeTab.url));
  const hasQuery = query.trim().length > 0;
  const count = canSearch && hasQuery ? findInPageMatches : 0;
  const ordinal = count ? Math.min(findInPageActiveMatchOrdinal, count) : 0;
  const close = useCallback(() => {
    stopFindInPage();
    onClose();
  }, [stopFindInPage, onClose]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focusToken, visible]);

  useLayoutEffect(() => {
    if (!open || !canSearch || !hasQuery) stopFindInPage();
    else searchInPage(query, { forward: true, findNext: false, matchCase });
  }, [open, canSearch, hasQuery, query, matchCase, activeId, searchInPage, stopFindInPage]);

  useLayoutEffect(() => {
    // Clear the old tab on switch or close without resetting counts on each keystroke.
    return stopFindInPage;
  }, [open, activeId, stopFindInPage]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', escape, true);
    // Escape from a focused guest arrives through Electron's shortcut bridge.
    const shortcut = (_event: unknown, action: unknown) => {
      if (action === 'stop-loading') close();
    };
    electron?.ipcRenderer.on('app-shortcut', shortcut);
    return () => {
      window.removeEventListener('keydown', escape, true);
      electron?.ipcRenderer.off('app-shortcut', shortcut);
    };
  }, [open, close]);

  const next = (forward: boolean) => {
    if (canSearch && hasQuery) searchInPage(query, { forward, findNext: true, matchCase });
  };
  if (!displayed) return null;
  return (
    <div className="find-popover-slot">
      <section
        className={`theme-panel find-popover ${animated ? (closing ? 'find-popover-out' : 'find-popover-in') : ''}`}
        role="search"
        aria-label="Find in page"
        inert={!open}
        aria-hidden={!open}
      >
        <Search className="find-search-icon" size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          className="theme-input find-input"
          aria-label="Find in page"
          value={query}
          placeholder={canSearch ? 'Find in page' : 'Unavailable on this page'}
          disabled={!canSearch}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              next(!event.shiftKey);
            }
          }}
        />
        <output
          className="find-count"
          data-empty={hasQuery && count === 0 && !findInPageSearching}
          data-searching={findInPageSearching}
          aria-busy={findInPageSearching}
          aria-live="polite"
          aria-label={
            findInPageSearching
              ? 'Searching'
              : hasQuery
                ? `${ordinal} of ${count} matches`
                : 'Enter text to find'
          }
        >
          {hasQuery ? (findInPageSearching && !count ? '…' : `${ordinal}/${count}`) : ''}
        </output>
        <button
          type="button"
          className="theme-btn theme-btn-nav find-action find-case"
          aria-label="Match case"
          title="Match case"
          aria-pressed={matchCase}
          disabled={!canSearch}
          onClick={() => setMatchCase((value) => !value)}
        >
          Aa
        </button>
        <span className="find-divider" aria-hidden="true" />
        <button
          type="button"
          className="theme-btn theme-btn-nav find-action"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={!count}
          onClick={() => next(false)}
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          className="theme-btn theme-btn-nav find-action"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={!count}
          onClick={() => next(true)}
        >
          <ChevronDown size={16} />
        </button>
        <button
          type="button"
          className="theme-btn theme-btn-nav find-action"
          aria-label="Close find"
          title="Close find (Escape)"
          onClick={close}
        >
          <X size={16} />
        </button>
      </section>
    </div>
  );
}
