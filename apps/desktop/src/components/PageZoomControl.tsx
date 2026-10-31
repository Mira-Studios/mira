import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, ZoomIn, ZoomOut } from 'lucide-react';
import { electron } from '../electronBridge';
import { useTabs } from '../features/tabs/TabsProvider';
import './PageZoomControl.css';

type ZoomChange = { webContentsId: number; factor: number; showPopup: boolean };

export default function PageZoomControl({
  animationsEnabled,
  onOpen,
}: {
  animationsEnabled: boolean;
  onOpen: () => void;
}) {
  const { activeId, getWebContentsIdForTab, zoomIn, zoomOut, resetZoom } = useTabs();
  const [factor, setFactor] = useState(1);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  const finishClosing = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setClosing(false);
  }, []);
  const hide = useCallback(() => {
    if (!openRef.current) return;
    openRef.current = false;
    clearHideTimer();
    setOpen(false);
    if (animationsEnabled && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      setClosing(true);
      closeTimer.current = window.setTimeout(finishClosing, 250);
    } else finishClosing();
  }, [animationsEnabled, clearHideTimer, finishClosing]);
  const show = useCallback(() => {
    openRef.current = true;
    clearHideTimer();
    finishClosing();
    onOpen();
    setOpen(true);
  }, [clearHideTimer, finishClosing, onOpen]);

  useEffect(
    () => () => {
      clearHideTimer();
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [clearHideTimer],
  );

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    let live = true;
    let received = false;
    const receive = (_event: unknown, raw: unknown) => {
      const value = raw as ZoomChange;
      if (
        !value ||
        value.webContentsId !== getWebContentsIdForTab(activeId) ||
        !Number.isFinite(value.factor) ||
        value.factor <= 0
      )
        return;
      received = true;
      setFactor(value.factor);
      if (value.showPopup) {
        show();
        if (!slot.current?.matches(':hover') && !slot.current?.contains(document.activeElement)) {
          hideTimer.current = window.setTimeout(hide, 1800);
        }
      }
    };
    const dismiss = (_event: unknown, id: unknown) => {
      if (id === getWebContentsIdForTab(activeId)) hide();
    };
    ipc.on('page-zoom-changed', receive);
    ipc.on('page-zoom-dismiss', dismiss);
    void ipc
      .invoke<number | null>('page-zoom-get', getWebContentsIdForTab(activeId))
      .then((value) => {
        if (live && !received && typeof value === 'number' && value > 0) setFactor(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      ipc.off('page-zoom-changed', receive);
      ipc.off('page-zoom-dismiss', dismiss);
    };
  }, [activeId, getWebContentsIdForTab, show, hide]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!slot.current?.contains(event.target as Node)) hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', hide);
    };
  }, [open, hide]);

  const percent = Math.round(factor * 100);
  const visible = percent !== 100 || open || closing;
  const Icon = factor < 1 ? ZoomOut : ZoomIn;
  return (
    <div
      ref={slot}
      className={`page-zoom-control ${visible ? 'page-zoom-control-visible' : ''}`}
      data-animate={animationsEnabled}
      aria-hidden={!visible}
    >
      <button
        type="button"
        className="theme-btn theme-btn-nav nav-icon-btn page-zoom-trigger"
        title={`Zoom: ${percent}%`}
        aria-label={`Page zoom: ${percent}%`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!visible}
        tabIndex={visible ? 0 : -1}
        onClick={() => {
          if (open) hide();
          else show();
        }}
      >
        <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
      </button>
      {(open || closing) && (
        <section
          className={`theme-panel page-zoom-popover ${closing ? 'page-zoom-popover-closing' : ''}`}
          role="dialog"
          aria-label="Page zoom"
          aria-hidden={!open}
          inert={!open}
          onPointerEnter={clearHideTimer}
          onFocusCapture={clearHideTimer}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === 'page-zoom-out')
              finishClosing();
          }}
        >
          <button
            type="button"
            className="theme-btn theme-btn-nav page-zoom-step"
            aria-label="Zoom out"
            disabled={factor <= 0.25}
            onClick={zoomOut}
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <output className="page-zoom-percent" aria-live="polite">
            {percent}%
          </output>
          <button
            type="button"
            className="theme-btn theme-btn-nav page-zoom-step"
            aria-label="Zoom in"
            disabled={factor >= 5}
            onClick={zoomIn}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="theme-btn theme-btn-go page-zoom-reset"
            disabled={percent === 100}
            onClick={resetZoom}
          >
            Reset
          </button>
        </section>
      )}
    </div>
  );
}
