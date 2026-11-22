import type { BrowserSettings } from '../features/settings/browserSettings';
import { resolveAddressBarPosition } from '../features/settings/addressBarPlacement';
import { getLayoutById } from '../features/layouts/layoutLoader';
import type { SidebarSection } from '../features/sidebar/sidebarSettings';

const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;
const VERTICAL_TABS_WIDTH = 280;
const SIDEBAR_WIDTH = 48;
const EXPANDED_SIDEBAR_WIDTH = 220;

/** All rectangles use browser pixels in one fixed viewport, scaled uniformly by SVG. */
export default function LayoutSetupPreview({ settings, focus, menu, tooltip = false }: { settings: BrowserSettings; focus?: SidebarSection; menu?: SidebarSection; tooltip?: boolean }) {
  const values = getLayoutById(settings.layoutId)?.values;
  const size = (key: string, fallback: number) => {
    const value = Number.parseFloat(values?.[key] || '');
    return Number.isFinite(value) ? value : fallback;
  };
  const top = size('layoutTopBarHeight', 38);
  const tabHeight = size('layoutTabHeight', 27);
  const tabWidth = size('layoutTabTargetWidth', 220);
  const tabRadius = size('layoutTabRadius', 10);
  const gap = size('layoutTabGap', 6);
  const navHeight = size('layoutNavButtonHeight', 30);
  const urlHeight = Math.max(34, navHeight);
  const toolbarHeight = urlHeight + size('layoutAddressBarPaddingY', 6) * 2 + 1;
  const vertical = settings.tabStripPosition !== 'top';
  const address = resolveAddressBarPosition(settings.addressBarPosition, vertical);
  const expanded = settings.sidebarMode !== 'collapsed';
  const sidebarWidth = settings.sidebarEnabled ? expanded ? EXPANDED_SIDEBAR_WIDTH : SIDEBAR_WIDTH : 0;
  const sidebarX = settings.sidebarSide === 'left' ? 0 : WINDOW_WIDTH - sidebarWidth;
  const leftEdge = settings.sidebarEnabled && settings.sidebarSide === 'left' ? sidebarWidth : 0;
  const rightEdge = WINDOW_WIDTH - (settings.sidebarEnabled && settings.sidebarSide === 'right' ? sidebarWidth : 0);
  const railX = settings.tabStripPosition === 'right' ? rightEdge - VERTICAL_TABS_WIDTH : leftEdge;
  const contentX = leftEdge + (vertical && settings.tabStripPosition === 'left' ? VERTICAL_TABS_WIDTH : 0);
  const contentWidth = rightEdge - contentX - (vertical && settings.tabStripPosition === 'right' ? VERTICAL_TABS_WIDTH : 0);
  const inSidebar = (section: SidebarSection) => settings.sidebarEnabled && settings.sidebarSections.includes(section);
  const muted = 'var(--text2)';
  const surface = 'var(--surfaceBg, var(--tabBg))';
  const active = 'var(--tabBgActive)';
  const skeleton = (x: number, y: number, width: number, height = 8) => <rect x={x} y={y} width={width} height={height} rx={height / 2} fill={muted} opacity=".3" />;
  const button = (x: number, y: number, highlighted = false) => <rect x={x} y={y} width="18" height="18" rx="5" fill={muted} opacity={highlighted ? '.85' : '.32'} />;
  const toolbar = (x: number, y: number, width: number, height: number, inRail = false) => {
    const controlsY = y + (inRail ? 6 : (height - 18) / 2);
    const actions = [settings.showProfileMenu && !inSidebar('profiles') && 'profiles', settings.showWorkspaceMenu && !inSidebar('workspaces') && 'workspaces', 'settings', 'menu'].filter(Boolean);
    const actionsWidth = actions.length * 30;
    const urlX = inRail ? x + 6 : x + 108;
    const urlY = inRail ? y + 6 + navHeight + 8 : y + (height - urlHeight) / 2;
    const urlWidth = inRail ? width - 12 : Math.max(50, width - 120 - actionsWidth);
    return <g>
      {!inRail && <rect x={x} y={y} width={width} height={height} fill={y === 0 ? 'transparent' : 'var(--surfaceBgHover, var(--tabBgHover))'} />}
      {[0, 1, 2].map(index => <g key={index}>{button(x + 12 + index * 30, controlsY)}</g>)}
      {actions.map((action, index) => <g key={String(action)}>{button(x + width - actionsWidth + index * 30, controlsY, action === focus)}</g>)}
      <rect x={urlX} y={urlY} width={urlWidth} height={urlHeight} rx={urlHeight / 2} fill="var(--fieldBg)" stroke="var(--fieldBorder)" />
    </g>;
  };
  const railToolbarHeight = navHeight + urlHeight + 26;
  const menuWidth = 280;
  const menuX = address === 'vertical-tabs' ? settings.tabStripPosition === 'left' ? railX + 6 : railX + VERTICAL_TABS_WIDTH - menuWidth - 6 : address === 'topbar' ? WINDOW_WIDTH - 138 - menuWidth - 8 : contentX + contentWidth - menuWidth - 8;
  const menuY = address === 'vertical-tabs' ? top + navHeight + 12 : address === 'topbar' ? top + 4 : top + toolbarHeight + 4;
  return <svg className="setup-preview" viewBox={`0 0 ${WINDOW_WIDTH} ${WINDOW_HEIGHT}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true" data-tabs={settings.tabStripPosition} data-sidebar={settings.sidebarEnabled ? settings.sidebarSide : 'hidden'}>
    <rect width={WINDOW_WIDTH} height={WINDOW_HEIGHT} fill="var(--bg)" />
    <rect width={WINDOW_WIDTH} height={top} fill="var(--tabBg)" />
    {skeleton(12, (top - 16) / 2, 52, 16)}
    {[0, 1, 2].map(index => <g key={index}>{skeleton(WINDOW_WIDTH - 120 + index * 40, (top - 8) / 2, 12, 8)}</g>)}
    {!vertical && [0, 1].map(index => <rect key={index} x={84 + index * (tabWidth + gap)} y={(top - tabHeight) / 2} width={tabWidth} height={tabHeight} rx={tabRadius} fill={index === 0 ? active : surface} />)}
    {vertical && address === 'topbar' && toolbar(84, 0, WINDOW_WIDTH - 84 - 138, top)}
    {settings.sidebarEnabled && <g>
      <rect x={sidebarX} y={top} width={sidebarWidth} height={WINDOW_HEIGHT - top} fill={surface} />
      {settings.sidebarSectionOrder.filter(section => settings.sidebarSections.includes(section)).map((section, index) => <g key={section}>
        {focus === section && <rect x={sidebarX + 6} y={top + 8 + index * 54} width={sidebarWidth - 12} height="34" rx="8" fill={active} />}
        {button(sidebarX + 15, top + 16 + index * 54, focus === section)}
        {expanded && skeleton(sidebarX + 42, top + 21 + index * 54, section === 'recently-closed' ? 105 : 74)}
      </g>)}
      {button(sidebarX + 15, WINDOW_HEIGHT - 30)}
    </g>}
    {vertical && <g>
      <rect x={railX} y={top} width={VERTICAL_TABS_WIDTH} height={WINDOW_HEIGHT - top} fill={surface} />
      {address === 'vertical-tabs' && toolbar(railX, top, VERTICAL_TABS_WIDTH, railToolbarHeight, true)}
      {[0, 1, 2].map(index => <rect key={index} x={railX + 6} y={top + 6 + (address === 'vertical-tabs' ? railToolbarHeight : 0) + index * (tabHeight + gap)} width={VERTICAL_TABS_WIDTH - 12} height={tabHeight} rx={tabRadius} fill={index === 0 ? active : 'var(--tabBg)'} />)}
    </g>}
    {address === 'toolbar' && toolbar(contentX, top, contentWidth, toolbarHeight)}
    {settings.showBookmarksBar && !inSidebar('bookmarks') && <g>
      <rect x={contentX} y={top + (address === 'toolbar' ? toolbarHeight : 0)} width={contentWidth} height="26" fill={surface} />
      {[0, 1, 2].map(index => <g key={index}>{skeleton(contentX + 10 + index * 105, top + (address === 'toolbar' ? toolbarHeight : 0) + 9, 85, 8)}</g>)}
    </g>}
    {menu && <g>
      <rect x={menuX} y={menuY} width={menuWidth} height="260" rx={size('layoutAddressMenuPanelRadius', 12)} fill={surface} stroke="var(--surfaceBorder)" />
      {[0, 1, 2, 3, 4].map(index => <g key={index}>
        {index === 2 && <rect x={menuX + 8} y={menuY + 12 + index * 46} width={menuWidth - 16} height="34" rx="8" fill={active} />}
        {button(menuX + 20, menuY + 20 + index * 46, index === 2)}
        {skeleton(menuX + 52, menuY + 25 + index * 46, index === 2 ? 140 : 110)}
      </g>)}
    </g>}
    {tooltip && settings.sidebarEnabled && <rect x={settings.sidebarSide === 'left' ? SIDEBAR_WIDTH + 8 : WINDOW_WIDTH - SIDEBAR_WIDTH - 108} y={top + 14} width="100" height="28" rx="8" fill="var(--surfaceBgHover)" stroke="var(--surfaceBorder)" />}
    {settings.sidebarEnabled && settings.sidebarMode === 'hover' && <path d={`M${sidebarX + 30} ${top + 48} l0 24 7 -7 7 12 5 -3 -7 -12 10 0Z`} fill={muted} stroke="var(--bg)" strokeWidth="2" />}
  </svg>;
}
