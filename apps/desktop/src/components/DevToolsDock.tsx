import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { electron } from '../electronBridge';
import type { DevToolsDockState } from '../../electron/devTools';

const WIDTH_STORAGE_KEY = 'mira:devtools-dock-width';

export default function DevToolsDock({ getWebContentsId, active = true }: {
  getWebContentsId?: () => number | undefined;
  active?: boolean;
}) {
  const [state, setState] = useState<DevToolsDockState | null>(null);
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
      return Number.isFinite(stored) && stored >= 180 ? stored : 420;
    } catch { return 420; }
  });
  useEffect(() => {
    try { localStorage.setItem(WIDTH_STORAGE_KEY, String(width)); } catch { /* Storage may be unavailable. */ }
  }, [width]);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    let live = true;
    let received = false;
    const changed = (_event: unknown, value: DevToolsDockState) => {
      received = true;
      setState(value);
    };
    ipc.on('devtools-dock-state', changed);
    void ipc.invoke<DevToolsDockState | null>('devtools-dock-get-state').then((value) => {
      if (live && !received) setState(value);
    }).catch(() => undefined);
    return () => {
      live = false;
      ipc.off('devtools-dock-state', changed);
    };
  }, []);
  let id: number | undefined;
  try {
    id = getWebContentsId ? getWebContentsId() : state?.hostId;
  } catch { /* The guest has not attached yet. */ }
  const open = id !== undefined && !!state?.ids.includes(id);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!open || !active || !element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      void electron?.ipcRenderer.invoke('devtools-dock-set-bounds', {
        webContentsId: id, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      }).catch(() => undefined);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    // Address/bookmark bars can move the surface without changing its size.
    window.addEventListener('resize', update);
    const frame = requestAnimationFrame(update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      cancelAnimationFrame(frame);
    };
  }, [open, active, id, width, state]);
  if (!open) return null;
  return (
    <aside aria-label="Developer Tools" style={{
      display: 'flex', flex: '0 0 auto', width, maxWidth: '75%', minWidth: 180,
      minHeight: 0, background: 'var(--surfaceBg)', color: 'var(--text1)',
    }}>
      <div role="separator" aria-label="Resize Developer Tools" aria-orientation="vertical"
        aria-valuenow={width} aria-valuemin={180} tabIndex={0}
        style={{ width: 5, cursor: 'col-resize', background: 'var(--surfaceBorder)', flexShrink: 0 }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current) setWidth(Math.max(180, drag.current.width + drag.current.x - event.clientX));
        }}
        onPointerUp={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setWidth((value) => Math.max(180, value + (event.key === 'ArrowLeft' ? 20 : -20)));
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px' }}>
          <span>Developer Tools</span>
          <button type="button" aria-label="Close Developer Tools" title="Close Developer Tools"
            className="theme-btn theme-btn-nav nav-icon-btn"
            style={{
              padding: '4px 8px', height: 'var(--layoutNavButtonHeight, 30px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={() => { void electron?.ipcRenderer.invoke('devtools-dock-close', id).catch(() => undefined); }}>
            <X size={16} strokeWidth={2.1} aria-hidden="true" />
          </button>
        </div>
        <div ref={surface} style={{ flex: 1, minHeight: 0 }} />
      </div>
    </aside>
  );
}
