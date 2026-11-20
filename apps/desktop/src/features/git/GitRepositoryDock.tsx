import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { electron } from '../../electronBridge';
import { useGitRepository } from './GitProvider';
import GitRepositoryView from './GitRepositoryView';

const WIDTH_STORAGE_KEY = 'mira:git-dock-width';
const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 420;

export default function GitRepositoryDock() {
  const { sidebarOpen, repository, link, close } = useGitRepository();
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
      return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const [availableWidth, setAvailableWidth] = useState(window.innerWidth);
  const dock = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const maximumWidth = Math.floor(availableWidth * 0.75);
  const minimumWidth = Math.min(MIN_WIDTH, maximumWidth);
  const displayedWidth = Math.max(minimumWidth, Math.min(width, maximumWidth));

  useEffect(() => {
    if (electron?.isPrivate) return;
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      /* Storage may be unavailable. */
    }
  }, [width]);

  useLayoutEffect(() => {
    const parent = dock.current?.parentElement;
    if (!sidebarOpen || !parent) return;
    const update = () => setAvailableWidth(parent.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [sidebarOpen]);

  if (!sidebarOpen) return null;
  const resize = (value: number) => setWidth(Math.max(minimumWidth, Math.min(value, maximumWidth)));
  return (
    <aside
      ref={dock}
      className="git-repository-dock"
      aria-label="Local Git repository"
      style={{ width: displayedWidth }}
    >
      <div
        role="separator"
        className="git-dock-resizer"
        aria-label="Resize local Git sidebar"
        aria-orientation="vertical"
        aria-valuenow={Math.round(displayedWidth)}
        aria-valuemin={minimumWidth}
        aria-valuemax={maximumWidth}
        tabIndex={0}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, width: dock.current!.getBoundingClientRect().width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current) resize(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          resize(
            event.key === 'Home'
              ? minimumWidth
              : event.key === 'End'
                ? maximumWidth
                : displayedWidth + (event.key === 'ArrowLeft' ? 20 : -20),
          );
        }}
      />
      <div className="git-dock-content">
        <GitRepositoryView key={`${repository?.key}:${link?.path}`} onClose={close} />
      </div>
    </aside>
  );
}
