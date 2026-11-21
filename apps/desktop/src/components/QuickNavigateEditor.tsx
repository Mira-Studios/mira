import { useEffect, useRef, useState } from 'react';
import {
  cacheQuickFavicon,
  QUICK_NAVIGATE_EDITOR,
  saveQuickLink,
  type QuickLink,
} from '../features/quickNavigate/quickNavigate';
import { usePromptPresence } from '../hooks/usePromptPresence';
import './QuickNavigate.css';

function LinkEditor({
  link,
  closing,
  onClose,
}: {
  link: Partial<QuickLink>;
  closing: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(link.name || '');
  const [url, setUrl] = useState(link.url || '');
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    form.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="site-interaction-backdrop profile-editor-backdrop"
      inert={closing}
      aria-hidden={closing || undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        ref={form}
        className="site-interaction theme-panel quick-navigate-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-navigate-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const controls = [
            ...(form.current?.querySelectorAll<HTMLElement>('input, button') || []),
          ];
          event.preventDefault();
          const index = controls.indexOf(document.activeElement as HTMLElement);
          controls[
            (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
          ]?.focus();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (closing) return;
          try {
            const saved = saveQuickLink({
              ...link,
              name,
              url,
              favicon:
                link.favicon?.startsWith('data:image/') && url === link.url
                  ? link.favicon
                  : undefined,
            });
            if (!saved.favicon)
              void cacheQuickFavicon(saved, saved.url === link.url ? link.favicon : undefined);
            onClose();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not save this link.');
          }
        }}
      >
        <strong id="quick-navigate-title">
          {link.id ? 'Edit Quick Navigate link' : 'Add Quick Navigate link'}
        </strong>
        <label htmlFor="quick-navigate-name">Name</label>
        <input
          id="quick-navigate-name"
          className="theme-input"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="quick-navigate-url">URL</label>
        <input
          id="quick-navigate-url"
          className="theme-input"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com"
        />
        {error && (
          <span role="alert" className="quick-navigate-error">
            {error}
          </span>
        )}
        <div className="site-interaction-actions">
          <button type="button" className="theme-btn theme-btn-nav" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="theme-btn theme-btn-nav">
            {link.id ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function QuickNavigateEditor() {
  const [request, setRequest] = useState<{ requestId: string; link: Partial<QuickLink> } | null>(
    null,
  );
  const presence = usePromptPresence(request);
  useEffect(() => {
    const open = (event: Event) =>
      setRequest({
        requestId: crypto.randomUUID(),
        link: (event as CustomEvent<Partial<QuickLink>>).detail || {},
      });
    window.addEventListener(QUICK_NAVIGATE_EDITOR, open);
    return () => window.removeEventListener(QUICK_NAVIGATE_EDITOR, open);
  }, []);
  return presence.displayed ? (
    <div
      className={`profile-editor-presence ${presence.animated ? (presence.closing ? 'prompt-motion-out' : 'prompt-motion-in') : ''}`}
    >
      <LinkEditor
        key={presence.displayed.requestId}
        link={presence.displayed.link}
        closing={presence.closing}
        onClose={() => setRequest(null)}
      />
    </div>
  ) : null;
}
