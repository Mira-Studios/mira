import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SidebarSide } from '../features/sidebar/sidebarSettings';

export default function SidebarTooltip({
  target,
  side,
  enabled,
  animated,
  dismissKey,
}: {
  target: HTMLElement | null;
  side: SidebarSide;
  enabled: boolean;
  animated: boolean;
  dismissKey: number;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<{
    target: HTMLElement;
    label: string;
    animate: boolean;
  } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const showing = useRef(false);
  const lastHiddenAt = useRef(0);
  const lastDismissKey = useRef(dismissKey);
  const label = target?.dataset.sidebarTooltip;
  const visible = enabled && !!shown;
  useLayoutEffect(() => {
    if (!enabled || lastDismissKey.current !== dismissKey) {
      lastDismissKey.current = dismissKey;
      showing.current = false;
      lastHiddenAt.current = 0;
      setShown(null);
      setPosition(null);
      return;
    }
    if (!target || !label) {
      const timer = window.setTimeout(() => {
        if (showing.current) lastHiddenAt.current = Date.now();
        showing.current = false;
        setShown(null);
      }, 80);
      return () => window.clearTimeout(timer);
    }
    // Reuse the mounted tooltip when moving between items. The opening delay
    // and fade run once, rather than replaying for every label or anchor.
    if (showing.current || Date.now() - lastHiddenAt.current < 500) {
      showing.current = true;
      setShown({ target, label, animate: false });
      return;
    }
    const timer = window.setTimeout(() => {
      showing.current = true;
      setShown({ target, label, animate: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [target, label, enabled, dismissKey]);
  useLayoutEffect(() => {
    const anchorTarget = shown?.target;
    if (!visible || !anchorTarget || !panel.current) return;
    const place = () => {
      if (!panel.current || !anchorTarget.isConnected) return;
      const anchor = anchorTarget.getBoundingClientRect();
      const tooltip = panel.current.getBoundingClientRect();
      const left = side === 'left' ? anchor.right + 10 : anchor.left - tooltip.width - 10;
      setPosition({
        left: Math.max(8, Math.min(left, window.innerWidth - tooltip.width - 8)),
        top: Math.max(
          8,
          Math.min(
            anchor.top + (anchor.height - tooltip.height) / 2,
            window.innerHeight - tooltip.height - 8,
          ),
        ),
      });
    };
    place();
    const previous = anchorTarget.getAttribute('aria-describedby');
    anchorTarget.setAttribute('aria-describedby', [previous, id].filter(Boolean).join(' '));
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      if (previous) anchorTarget.setAttribute('aria-describedby', previous);
      else anchorTarget.removeAttribute('aria-describedby');
    };
  }, [visible, shown, side, id]);
  if (!visible || !shown) return null;
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="tooltip"
      className={`browser-sidebar-tooltip ${animated && shown.animate ? 'browser-sidebar-tooltip-animated' : ''}`}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {shown.label}
    </div>,
    document.body,
  );
}
