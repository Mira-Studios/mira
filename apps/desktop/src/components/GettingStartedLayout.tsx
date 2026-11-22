import { useSidebarSettings } from '../features/sidebar/useSidebarSettings';
import { getBrowserSettings, saveBrowserSettings, type BrowserSettings } from '../features/settings/browserSettings';
import type { SidebarSection } from '../features/sidebar/sidebarSettings';
import LayoutSetupPreview from './LayoutSetupPreview';

export const LAYOUT_PAGES = ['tabs', 'toolbar', 'sidebar', 'sidebar-mode', 'sidebar-tooltips', 'bookmarks', 'profiles', 'workspaces', 'recently-closed'] as const;
export type LayoutPage = typeof LAYOUT_PAGES[number];
export const LAYOUT_PAGE_TITLES: Record<LayoutPage, string> = { tabs: 'Where do you want your tabs?', toolbar: 'Place your URL bar and controls', sidebar: 'Choose a sidebar', 'sidebar-mode': 'How should the sidebar expand?', 'sidebar-tooltips': 'Show tooltips when collapsed?', bookmarks: 'Where do you want bookmarks?', profiles: 'Where do you want profiles?', workspaces: 'Where do you want workspaces?', 'recently-closed': 'Where do you want recently closed tabs?' };
export function availableLayoutPages(settings: BrowserSettings) {
  return LAYOUT_PAGES.filter(page => (page !== 'toolbar' || settings.tabStripPosition !== 'top') && (!['sidebar-mode', 'sidebar-tooltips'].includes(page) || settings.sidebarEnabled) && (page !== 'sidebar-tooltips' || settings.sidebarMode !== 'expanded'));
}
const PAGE_KEY = 'mira.setup.layout-page.v1';
export function loadLayoutPage(): LayoutPage {
  try { const stored = localStorage.getItem(PAGE_KEY); if (LAYOUT_PAGES.includes(stored as LayoutPage)) return stored as LayoutPage; } catch { /* Start at tabs. */ }
  return 'tabs';
}
export function persistLayoutPage(page: LayoutPage) { localStorage.setItem(PAGE_KEY, page); }

type Choice = { value: string; label: string; patch: Partial<BrowserSettings>; previewPatch?: Partial<BrowserSettings>; menu?: SidebarSection; tooltip?: boolean };
function placement(settings: BrowserSettings, section: SidebarSection, destination: string): Partial<BrowserSettings> {
  const sections = settings.sidebarSections.filter(item => item !== section);
  const patch: Partial<BrowserSettings> = { sidebarSections: destination === 'sidebar' ? [...sections, section] : sections };
  if (destination === 'sidebar') patch.sidebarEnabled = true;
  if (section === 'bookmarks') patch.showBookmarksBar = destination === 'bar';
  if (section === 'profiles') patch.showProfileMenu = destination === 'toolbar';
  if (section === 'workspaces') patch.showWorkspaceMenu = destination === 'toolbar';
  return patch;
}

export default function GettingStartedLayout({ page }: { page: LayoutPage }) {
  const settings = useSidebarSettings();
  const inSidebar = (section: SidebarSection) => settings.sidebarEnabled && settings.sidebarSections.includes(section);
  let current: string;
  let choices: Choice[];
  let focus: SidebarSection | undefined;
  switch (page) {
    case 'tabs':
      current = settings.tabStripPosition;
      choices = [{ value: 'top', label: 'Tabs on top', patch: { tabStripPosition: 'top' } }, { value: 'left', label: 'Tabs on the left', patch: { tabStripPosition: 'left' } }, { value: 'right', label: 'Tabs on the right', patch: { tabStripPosition: 'right' } }]; break;
    case 'toolbar':
      current = settings.addressBarPosition;
      choices = [{ value: 'topbar', label: 'In the top bar', patch: { addressBarPosition: 'topbar' } }, { value: 'toolbar', label: 'In the toolbar', patch: { addressBarPosition: 'toolbar' } }, { value: 'vertical-tabs', label: 'In the vertical tab panel', patch: { addressBarPosition: 'vertical-tabs' } }]; break;
    case 'sidebar':
      current = settings.sidebarEnabled ? settings.sidebarSide : 'hidden';
      choices = [{ value: 'hidden', label: 'No sidebar', patch: { sidebarEnabled: false } }, { value: 'left', label: 'Sidebar on the left', patch: { sidebarEnabled: true, sidebarSide: 'left' } }, { value: 'right', label: 'Sidebar on the right', patch: { sidebarEnabled: true, sidebarSide: 'right' } }]; break;
    case 'sidebar-mode':
      current = settings.sidebarMode;
      choices = [{ value: 'collapsed', label: 'Keep collapsed', patch: { sidebarMode: 'collapsed' } }, { value: 'expanded', label: 'Keep expanded', patch: { sidebarMode: 'expanded' } }, { value: 'hover', label: 'Expand on hover', patch: { sidebarMode: 'hover' } }]; break;
    case 'sidebar-tooltips':
      current = String(settings.sidebarShowTooltips);
      choices = [{ value: 'true', label: 'Show tooltips', patch: { sidebarShowTooltips: true }, previewPatch: { sidebarMode: 'collapsed' }, tooltip: true }, { value: 'false', label: 'No tooltips', patch: { sidebarShowTooltips: false }, previewPatch: { sidebarMode: 'collapsed' } }]; break;
    default: {
      focus = page;
      current = inSidebar(page) ? 'sidebar' : page === 'bookmarks' ? settings.showBookmarksBar ? 'bar' : 'hidden' : page === 'profiles' ? settings.showProfileMenu ? 'toolbar' : 'menu' : page === 'workspaces' ? settings.showWorkspaceMenu ? 'toolbar' : 'menu' : 'menu';
      const options = page === 'bookmarks' ? [['hidden', 'Hidden'], ['bar', 'Bookmarks bar'], ['sidebar', 'In the sidebar']] : page === 'recently-closed' ? [['menu', 'In the main menu'], ['sidebar', 'In the sidebar']] : [['menu', 'In the main menu'], ['toolbar', 'In the toolbar'], ['sidebar', 'In the sidebar']];
      choices = options.map(([value, label]) => ({ value, label, patch: placement(settings, page, value), menu: value === 'menu' ? page : undefined }));
    }
  }
  return <div className="getting-started-layout" data-layout-page={page}>
    <div className="setup-picture-choices" role="radiogroup" aria-label={LAYOUT_PAGE_TITLES[page]}>
      {choices.map(choice => <label className="setup-picture-choice" key={choice.value} data-selected={current === choice.value}>
        <LayoutSetupPreview settings={{ ...settings, ...choice.patch, ...choice.previewPatch }} focus={focus} menu={choice.menu} tooltip={choice.tooltip} />
        <span className="setup-picture-caption"><strong>{choice.label}</strong><input type="radio" name={`setup-${page}`} value={choice.value} aria-label={choice.label} checked={current === choice.value} onChange={() => {
          // Recompute placement using the newest persisted settings, including other windows.
          saveBrowserSettings(focus ? placement(getBrowserSettings(), focus, choice.value) : choice.patch);
        }} /></span>
      </label>)}
    </div>
  </div>;
}
