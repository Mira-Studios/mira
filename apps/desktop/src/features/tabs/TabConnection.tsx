import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** Original pixel geometry, drawn inside the tab so movement needs no tracking. */
export default function TabConnection({ vertical, rightSidebar, color }: {
  vertical: boolean; rightSidebar: boolean; color?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ radius: 10, startOffset: 0, endOffset: 0 });
  useLayoutEffect(() => {
    const tab = ref.current?.parentElement;
    if (!tab) return;
    let frame = 0;
    const measure = () => {
      const style = getComputedStyle(tab);
      const configured = Math.max(...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
        .map(corner => parseFloat(style[corner as keyof CSSStyleDeclaration] as string) || 0));
      // These corners sit outside the tab; narrowing a pinned tab must not
      // shrink them and move their upper edge down.
      const radius = Math.min(configured, tab.offsetHeight / 2);
      const bounds = tab.getBoundingClientRect();
      const configuredBorder = parseFloat(style.getPropertyValue('--layoutBorderWidth'));
      const border = Number.isFinite(configuredBorder) ? configuredBorder : 1;
      const scale = window.devicePixelRatio || 1;
      const snap = (value: number) => Math.round(value * scale) / scale;
      const round = (value: number) => Math.round(value * 1000) / 1000;
      // CSS borders snap to device pixels; SVG paths otherwise retain a different
      // fractional phase on each edge. Align each mirrored join independently.
      const startOffset = round(snap(bounds.left) - bounds.left + border - .5 - parseFloat(style.borderLeftWidth) / 2);
      const endOffset = round(snap(bounds.right) - bounds.right - border + .5 + parseFloat(style.borderRightWidth) / 2);
      setGeometry(previous => previous.radius === radius && previous.startOffset === startOffset && previous.endOffset === endOffset
        ? previous : { radius, startOffset, endOffset });
    };
    const scheduleMeasure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    measure();
    const resize = new ResizeObserver(scheduleMeasure);
    resize.observe(tab);
    const parent = tab.parentElement;
    if (parent) resize.observe(parent);
    const strip = tab.closest('.tab-strip-scroll');
    strip?.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    const mutations = new MutationObserver(scheduleMeasure);
    mutations.observe(tab, { attributes: true, attributeFilter: ['style', 'class'] });
    if (parent) mutations.observe(parent, { attributes: true, attributeFilter: ['style', 'class'], childList: true });
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      strip?.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, []);

  const r = geometry.radius;
  const size = r + 2;
  // These are the former overlay paths translated to a corner-sized SVG.
  // Keep the half-pixel centers, 1px stroke joins and 2px fill overlap intact.
  const horizontalStroke = `M ${r + 0.5} 0.5 V 1.5 A ${r} ${r} 0 0 1 0.5 ${r + 1.5}`;
  const horizontalFill = `M ${r + 0.5} 1.5 A ${r} ${r} 0 0 1 0.5 ${r + 1.5} V ${size} H ${size} V 1.5 Z`;
  const verticalStroke = `M -0.5 ${r + 0.5} H 0.5 A ${r} ${r} 0 0 0 ${r + 0.5} 0.5`;
  const verticalFill = `M 0.5 ${r + 0.5} A ${r} ${r} 0 0 0 ${r + 0.5} 0.5 H ${r + 1} V ${size} H 0.5 Z`;
  const side = vertical ? rightSidebar ? 'right' : 'left' : 'horizontal';
  return <div ref={ref} aria-hidden="true" className={`tab-connection tab-connection-${side}`}
    style={{ '--tabConnectionRadius': `${r}px`, '--tabConnectionStartOffset': `${geometry.startOffset}px`, '--tabConnectionEndOffset': `${geometry.endOffset}px`, '--tabConnectionBorder': color ?? 'var(--surfaceBorder, var(--tabBorder))' } as CSSProperties}>
    {[0, 1].map(index => {
      const mirrorX = vertical ? rightSidebar : index === 1;
      const mirrorY = vertical && index === 1;
      return <svg key={index} className={`tab-connection-curve tab-connection-curve-${index}`}
        viewBox={`0 0 ${size} ${size}`} overflow="visible">
        <g transform={`translate(${mirrorX ? size : 0} ${mirrorY ? size : 0}) scale(${mirrorX ? -1 : 1} ${mirrorY ? -1 : 1})`}>
          <path d={vertical ? verticalFill : horizontalFill} fill="var(--surfaceBgHover, var(--tabBgHover))" />
          <path d={vertical ? verticalStroke : horizontalStroke} fill="none" stroke="var(--tabConnectionBorder)" strokeWidth="1" />
        </g>
      </svg>;
    })}
  </div>;
}
