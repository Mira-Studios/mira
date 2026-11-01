import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** Original pixel geometry, drawn inside the tab so movement needs no tracking. */
export default function TabConnection({ vertical, rightSidebar, color }: {
  vertical: boolean; rightSidebar: boolean; color?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [radius, setRadius] = useState(10);
  useLayoutEffect(() => {
    const tab = ref.current?.parentElement;
    if (!tab) return;
    const measureRadius = () => {
      const style = getComputedStyle(tab);
      const configured = Math.max(...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
        .map(corner => parseFloat(style[corner as keyof CSSStyleDeclaration] as string) || 0));
      setRadius(Math.min(configured, tab.offsetWidth / 2, tab.offsetHeight / 2));
    };
    measureRadius();
    const resize = new ResizeObserver(measureRadius);
    resize.observe(tab);
    const mutations = new MutationObserver(measureRadius);
    mutations.observe(tab, { attributes: true, attributeFilter: ['style', 'class'] });
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => { resize.disconnect(); mutations.disconnect(); };
  }, []);

  const r = radius;
  const size = r + 2;
  // These are the former overlay paths translated to a corner-sized SVG.
  // Keep the half-pixel centers, 1px stroke joins and 2px fill overlap intact.
  const horizontalStroke = `M ${r + 0.5} 0.5 V 1.5 A ${r} ${r} 0 0 1 0.5 ${r + 1.5}`;
  const horizontalFill = `M ${r + 0.5} 1.5 A ${r} ${r} 0 0 1 0.5 ${r + 1.5} V ${size} H ${size} V 1.5 Z`;
  const verticalStroke = `M -0.5 ${r + 0.5} H 0.5 A ${r} ${r} 0 0 0 ${r + 0.5} 0.5`;
  const verticalFill = `M 0.5 ${r + 0.5} A ${r} ${r} 0 0 0 ${r + 0.5} 0.5 H ${r + 1} V ${size} H 0.5 Z`;
  const side = vertical ? rightSidebar ? 'right' : 'left' : 'horizontal';
  return <div ref={ref} aria-hidden="true" className={`tab-connection tab-connection-${side}`}
    style={{ '--tabConnectionRadius': `${r}px`, '--tabConnectionBorder': color ?? 'var(--surfaceBorder, var(--tabBorder))' } as CSSProperties}>
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
