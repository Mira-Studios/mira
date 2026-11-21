// Only window-local preferences belong here. Profile data and OS behavior stay shared.
export const WORKSPACE_SETTING_KEYS = [
  'newTabPage',
  'searchEngine',
  'searchEngineShortcutsEnabled',
  'searchEngineShortcutPrefix',
  'searchEngineShortcutChars',
  'themeId',
  'layoutId',
  'animationsEnabled',
  'rawFileDarkModeEnabled',
  'nativeTextFieldContextMenu',
  'devToolsOpenMode',
  'backgroundImage',
  'useThemeBackgroundImage',
  'backgroundImageFit',
  'backgroundImagePositionX',
  'backgroundImagePositionY',
  'showNewTabSearch',
  'showQuickNavigate',
  'showNewTabBranding',
  'disableNewTabIntro',
  'tabStripPosition',
  'verticalTabsAddressBarInTopBar',
  'showBookmarkButton',
  'showBookmarksBar',
  'showProfileMenu',
  'showWorkspaceMenu',
  'sidebarEnabled',
  'sidebarMode',
  'sidebarSide',
  'sidebarSections',
  'sidebarSectionOrder',
  'sidebarShowTooltips',
  'tabSleepValue',
  'tabSleepUnit',
  'tabSleepMode',
  'suspendMinimizedWindows',
  'pipOnTabSwitch',
  'pipOnWindowHidden',
  'minimizedWindowSleepValue',
  'minimizedWindowSleepUnit',
] as const;
export function workspaceSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    WORKSPACE_SETTING_KEYS.filter((key) => key in value).map((key) => [
      key,
      (value as Record<string, unknown>)[key],
    ]),
  );
}
export const WORKSPACE_ICONS = [
  'panels',
  'briefcase',
  'home',
  'code',
  'book',
  'globe',
  'coffee',
  'star',
] as const;
export type Workspace = {
  id: string;
  name: string;
  icon: string;
  avatar: string | null;
  startup: 'restore' | 'fixed';
  urls: string[];
  settings: Record<string, unknown>;
};
