import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { TAB_GROUP_COLORS } from '../../../electron/tabGroups';
import type { Tab } from './types';

type Outline = { id: string; color: string; path: string; opacity: number };
type GroupEndMotion = { members: string; vertical: boolean; from: number; value: number; startedAt: number; label: number };
const GROUP_END_ANIMATION_MS = 170;

/** Draw one connected group line across tab gaps and around its active tab. */
export default function TabGroupOutlines({ scrollRef, tabs, activeId, vertical, rightSidebar, draggingTabId, draggingGroupId }: {
  scrollRef: RefObject<HTMLDivElement | null>; tabs: Tab[]; activeId: string; vertical: boolean; rightSidebar: boolean;
  draggingTabId: string | null; draggingGroupId: string | null;
}) {
  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [clip, setClip] = useState(0);
  const frameRef = useRef<number | null>(null);
  const groupEndsRef = useRef(new Map<string, GroupEndMotion>());

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const wrapper = scroller?.parentElement;
    if (!scroller || !wrapper) return;
    const measure = () => {
      frameRef.current = null;
      const bounds = wrapper.getBoundingClientRect();
      const elements = [...scroller.querySelectorAll<HTMLElement>('[data-tab-id]')];
      const headers = [...scroller.querySelectorAll<HTMLElement>('[data-tab-group]')];
      const byId = new Map(elements.map(element => [element.dataset.tabId, element]));
      const preview = draggingTabId ? wrapper.parentElement?.querySelector<HTMLElement>('[data-tab-drag-preview]') : null;
      const next: Outline[] = [];
      let endAnimating = false;
      const animationsEnabled = !!wrapper.closest('.tab-animations-enabled')
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const now = performance.now();
      for (const header of headers) {
        const id = header.dataset.tabGroup!;
        const group = tabs.find(tab => tab.group?.id === id)?.group;
        if (!group) continue;
        const members = tabs.filter(tab => !tab.isPinned && tab.group?.id === id)
          .map(tab => ({ tab, rect: (tab.id === draggingTabId && preview ? preview : byId.get(tab.id))?.getBoundingClientRect() }))
          .filter((entry): entry is { tab: Tab; rect: DOMRect } => !!entry.rect && entry.rect.width > 0.5 && entry.rect.height > 0.5);
        if (!members.length) continue;
        const label = header.getBoundingClientRect();
        const measuredEnd = Math.max(...members.map(member => vertical ? member.rect.bottom : member.rect.right))
          - (vertical ? bounds.top : bounds.left) - 0.5;
        const targetEnd = vertical ? measuredEnd : Math.max(label.right - bounds.left - 0.5, measuredEnd);
        const signature = members.map(member => member.tab.id).sort().join('|');
        const labelPosition = vertical ? label.top - bounds.top : label.left - bounds.left;
        let motion = groupEndsRef.current.get(id);
        if (!motion || motion.vertical !== vertical) {
          motion = { members: signature, vertical, from: targetEnd, value: targetEnd, startedAt: -Infinity, label: labelPosition };
          groupEndsRef.current.set(id, motion);
        }
        const labelDelta = labelPosition - motion.label;
        motion.from += labelDelta;
        motion.value += labelDelta;
        motion.label = labelPosition;
        if (motion.members !== signature) {
          motion.members = signature;
          motion.from = motion.value;
          motion.startedAt = now;
        }
        const progress = animationsEnabled ? Math.min(1, (now - motion.startedAt) / GROUP_END_ANIMATION_MS) : 1;
        motion.value = motion.from + (targetEnd - motion.from) * (1 - Math.pow(1 - progress, 3));
        if (progress < 1) endAnimating = true;
        // The animated tail may approach the group edge, but never pass it.
        const end = Math.min(motion.value, targetEnd);
        let path: string;
        if (vertical) {
          const x = Math.round((rightSidebar ? label.right - 4 : label.left + 4) - bounds.left);
          const gap = parseFloat(getComputedStyle(scroller).rowGap) || 0;
          const start = label.bottom - bounds.top + gap;
          path = end > start ? `M ${x} ${start} V ${end}` : '';
        } else {
          // Share the toolbar divider's pixel center with the neutral connection.
          const y = bounds.height + 0.5;
          const activeElement = byId.get(activeId);
          const configuredRadius = activeElement ? Math.max(parseFloat(getComputedStyle(activeElement).borderTopLeftRadius) || 0,
            parseFloat(getComputedStyle(activeElement).borderTopRightRadius) || 0) : 0;
          const start = Math.min(label.left, ...members.map(member => member.rect.left - configuredRadius)) - bounds.left;
          const active = members.find(member => member.tab.id === activeId)?.rect;
          path = `M ${start} ${y}`;
          let trailingStart: number | undefined;
          if (active && active.width > 12) {
            const left = active.left - bounds.left + 0.5;
            const right = active.right - bounds.left - 0.5;
            const radius = Math.min(configuredRadius, active.height / 2, active.width / 2);
            path += ` H ${left - radius}`;
            trailingStart = right + radius;
          }
          if (trailingStart === undefined) path += ` H ${end}`;
          else if (end > trailingStart) path += ` M ${trailingStart} ${y} H ${end}`;
        }
        const opacity = Math.max(...members.map(member => {
          const element = member.tab.id === draggingTabId && preview ? preview : byId.get(member.tab.id);
          return element ? Number(getComputedStyle(element).opacity) : 0;
        }));
        next.push({ id, path, color: TAB_GROUP_COLORS[group.color], opacity });
      }
      setOutlines(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      const visibleGroups = new Set(next.map(outline => outline.id));
      for (const id of groupEndsRef.current.keys()) if (!visibleGroups.has(id)) groupEndsRef.current.delete(id);
      const pins = elements.filter(element => element.dataset.pinned === 'true');
      setClip(vertical || !pins.length ? 0 : Math.max(...pins.map(pin => pin.getBoundingClientRect().right - bounds.left)) + 1);
      // FLIP transforms do not trigger ResizeObserver; follow them until settled.
      if (endAnimating || draggingTabId || draggingGroupId || scroller.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')) {
        frameRef.current = requestAnimationFrame(measure);
      }
    };
    const schedule = () => {
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const observe = () => { resize.disconnect(); resize.observe(scroller); for (const child of scroller.children) resize.observe(child); schedule(); };
    const mutations = new MutationObserver(observe);
    mutations.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    measure();
    observe();
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('transitionrun', schedule, true);
    scroller.addEventListener('animationstart', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      resize.disconnect(); mutations.disconnect();
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('transitionrun', schedule, true);
      scroller.removeEventListener('animationstart', schedule, true);
      window.removeEventListener('resize', schedule);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [scrollRef, tabs, activeId, vertical, rightSidebar, draggingTabId, draggingGroupId]);

  return <svg aria-hidden="true" className="tab-group-outlines tab-group-base-outline" style={{ clipPath: `inset(0 0 -1px ${clip}px)` }}>
    {outlines.map(outline => <path key={outline.id} data-tab-group-outline={outline.id} d={outline.path} fill="none" stroke={outline.color} opacity={outline.opacity} strokeWidth={vertical ? 2 : 1} strokeLinecap="round" strokeLinejoin="round" />)}
  </svg>;
}
