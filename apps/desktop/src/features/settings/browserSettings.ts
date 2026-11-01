import { DEFAULT_THEME_ID } from '../themes/themeLoader';
import { DEFAULT_LAYOUT_ID } from '../layouts/layoutLoader';

export type TabSleepUnit = 'seconds' | 'minutes' | 'hours';
export type TabSleepMode = 'freeze' | 'discard';
export type DevToolsOpenMode = 'side' | 'window';
export type StartupRestoreBehavior = 'ask' | 'windows' | 'tabs' | 'fresh';
export type TabStripPosition = 'top' | 'left' | 'right';

export type AutoUpdateMode =
  | 'off'
  | 'ask-on-launch'
  | 'ask-on-close'
  | 'auto-on-launch'
  | 'auto-on-close';
export type SearchEngine =
  | 'google'
  | 'duckduckgo'
  | 'bing'
  | 'yahoo'
  | 'startpage'
  | 'qwant'
  | 'yandex'
  | 'brave'
  | 'ecosia';

export const SEARCH_ENGINE_OPTIONS: ReadonlyArray<{
  value: SearchEngine;
  label: string;
}> = [
  { value: 'google', label: 'Google' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' },
  { value: 'yahoo', label: 'Yahoo' },
  { value: 'startpage', label: 'Startpage' },
  { value: 'qwant', label: 'Qwant' },
  { value: 'yandex', label: 'Yandex' },
  { value: 'brave', label: 'Brave Search' },
  { value: 'ecosia', label: 'Ecosia' },
];

export type SearchEngineShortcutChars = Record<SearchEngine, string>;

export const DEFAULT_SEARCH_ENGINE_SHORTCUT_PREFIX = '!';

export const DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS: SearchEngineShortcutChars = {
  google: 'g',
  duckduckgo: 'd',
  bing: 'b',
  yahoo: 'y',
  startpage: 's',
  qwant: 'q',
  yandex: 'a',
  brave: 'r',
  ecosia: 'e',
};

export type BrowserSettings = {
  newTabPage: string;
  themeId: string;
  rawFileDarkModeEnabled: boolean;
  animationsEnabled: boolean;
  nativeTextFieldContextMenu: boolean;
  layoutId: string;
  tabSleepValue: number;
  tabSleepUnit: TabSleepUnit;
  tabSleepMode: TabSleepMode;
  suspendMinimizedWindows: boolean;
  minimizedWindowSleepValue: number;
  minimizedWindowSleepUnit: TabSleepUnit;
  devToolsOpenMode: DevToolsOpenMode;
  adBlockEnabled: boolean;
  youtubeAdBlockBetaEnabled: boolean;
  trackerBlockEnabled: boolean;
  quitOnLastWindowClose: boolean;
  showNewTabBranding: boolean;
  disableNewTabIntro: boolean;
  includePrereleaseUpdates: boolean;
  autoUpdateOnLaunch: AutoUpdateMode;
  runOnStartup: boolean;
  startupRestoreBehavior: StartupRestoreBehavior;
  tabStripPosition: TabStripPosition;
  verticalTabsAddressBarInTopBar: boolean;
  searchEngine: SearchEngine;
  searchEngineShortcutsEnabled: boolean;
  searchEngineShortcutPrefix: string;
  searchEngineShortcutChars: SearchEngineShortcutChars;
  showPerfOverlay: boolean;
  dev: boolean;
  showBookmarkButton: boolean;
  showBookmarksBar: boolean;
  cookiesEnabled: boolean;
};

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  newTabPage: 'mira://NewTab',
  themeId: DEFAULT_THEME_ID,
  rawFileDarkModeEnabled: true,
  animationsEnabled: false,
  nativeTextFieldContextMenu: true,
  layoutId: DEFAULT_LAYOUT_ID,
  tabSleepValue: 3,
  tabSleepUnit: 'minutes',
  tabSleepMode: 'freeze',
  suspendMinimizedWindows: false,
  minimizedWindowSleepValue: 5,
  minimizedWindowSleepUnit: 'minutes',
  devToolsOpenMode: 'side',
  adBlockEnabled: false,
  youtubeAdBlockBetaEnabled: false,
  trackerBlockEnabled: false,
  quitOnLastWindowClose: false,
  showNewTabBranding: false,
  disableNewTabIntro: false,
  includePrereleaseUpdates: false,
  autoUpdateOnLaunch: 'off',
  runOnStartup: false,
  startupRestoreBehavior: 'ask',
  tabStripPosition: 'top',
  verticalTabsAddressBarInTopBar: true,
  searchEngine: 'google',
  searchEngineShortcutsEnabled: false,
  searchEngineShortcutPrefix: DEFAULT_SEARCH_ENGINE_SHORTCUT_PREFIX,
  searchEngineShortcutChars: DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS,
  showPerfOverlay: false,
  dev: true,
  showBookmarkButton: true,
  showBookmarksBar: false,
  cookiesEnabled: true,
};

export const BROWSER_SETTINGS_STORAGE_KEY = 'mira.settings.browser.v1';
export const BROWSER_SETTINGS_CHANGED_EVENT = 'mira:settings-changed';
const FORCE_DISABLE_DEV_SETTING = import.meta.env.VITE_DEV === 'false';

const TAB_SLEEP_UNIT_TO_MS: Record<TabSleepUnit, number> = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
};

function normalizeNewTabPage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BROWSER_SETTINGS.newTabPage;

  const normalized = value.trim();
  if (!normalized) return DEFAULT_BROWSER_SETTINGS.newTabPage;
  if (normalized.toLowerCase() === DEFAULT_BROWSER_SETTINGS.newTabPage.trim().toLowerCase()) {
    return DEFAULT_BROWSER_SETTINGS.newTabPage;
  }

  return normalized;
}

function normalizeThemeId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BROWSER_SETTINGS.themeId;

  const normalized = value.trim();
  if (!normalized) return DEFAULT_BROWSER_SETTINGS.themeId;

  return normalized;
}

function normalizeRawFileDarkModeEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.rawFileDarkModeEnabled;
  }

  return value;
}

function normalizeAnimationsEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.animationsEnabled;
  }

  return value;
}

function normalizeNativeTextFieldContextMenu(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.nativeTextFieldContextMenu;
  }

  return value;
}

function normalizeTabSleepValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BROWSER_SETTINGS.tabSleepValue;
  }

  const normalized = Math.max(1, Math.floor(value));
  return normalized;
}

function normalizeTabSleepUnit(value: unknown): TabSleepUnit {
  if (value === 'seconds' || value === 'minutes' || value === 'hours') {
    return value;
  }

  return DEFAULT_BROWSER_SETTINGS.tabSleepUnit;
}

function normalizeTabSleepMode(value: unknown): TabSleepMode {
  if (value === 'freeze' || value === 'discard') {
    return value;
  }

  return DEFAULT_BROWSER_SETTINGS.tabSleepMode;
}

function normalizeDevToolsOpenMode(value: unknown): DevToolsOpenMode {
  if (value === 'side' || value === 'window') {
    return value;
  }

  return DEFAULT_BROWSER_SETTINGS.devToolsOpenMode;
}

function normalizeAdBlockEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.adBlockEnabled;
  }

  return value;
}

function normalizeTrackerBlockEnabled(value: unknown, fallbackAdBlockEnabled: boolean): boolean {
  if (typeof value !== 'boolean') {
    return fallbackAdBlockEnabled;
  }

  return value;
}

function normalizeQuitOnLastWindowClose(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.quitOnLastWindowClose;
  }

  return value;
}

function normalizeLayoutId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BROWSER_SETTINGS.layoutId;

  const normalized = value.trim();
  if (!normalized) return DEFAULT_BROWSER_SETTINGS.layoutId;

  return normalized;
}

function normalizeDisableNewTabIntro(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.disableNewTabIntro;
  }

  return value;
}

function normalizeShowNewTabBranding(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.showNewTabBranding;
  }

  return value;
}

function normalizeIncludePrereleaseUpdates(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.includePrereleaseUpdates;
  }

  return value;
}

function normalizeAutoUpdateOnLaunch(value: unknown): AutoUpdateMode {
  // Backwards compatibility: older settings stored this as a boolean.
  if (typeof value === 'boolean') {
    return value ? 'ask-on-launch' : 'off';
  }

  if (
    value === 'off'
    || value === 'ask-on-launch'
    || value === 'ask-on-close'
    || value === 'auto-on-launch'
    || value === 'auto-on-close'
  ) {
    return value;
  }

  return DEFAULT_BROWSER_SETTINGS.autoUpdateOnLaunch;
}

function normalizeRunOnStartup(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.runOnStartup;
  }

  return value;
}

function normalizeStartupRestoreBehavior(value: unknown): StartupRestoreBehavior {
  if (value === 'ask' || value === 'windows' || value === 'tabs' || value === 'fresh') {
    return value;
  }

  return DEFAULT_BROWSER_SETTINGS.startupRestoreBehavior;
}

function normalizeTabStripPosition(value: unknown): TabStripPosition {
  if (value === 'top' || value === 'left' || value === 'right') {
    return value;
  }

  return DEFAULT_BROWSER_SETTINGS.tabStripPosition;
}

function normalizeSearchEngine(value: unknown): SearchEngine {
  if (
    value === 'google' ||
    value === 'duckduckgo' ||
    value === 'bing' ||
    value === 'yahoo' ||
    value === 'startpage' ||
    value === 'qwant' ||
    value === 'yandex' ||
    value === 'brave' ||
    value === 'ecosia'
  ) {
    return value;
  }

  return DEFAULT_BROWSER_SETTINGS.searchEngine;
}

function normalizeSearchEngineShortcutsEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.searchEngineShortcutsEnabled;
  }

  return value;
}

function normalizeSearchEngineShortcutPrefix(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_BROWSER_SETTINGS.searchEngineShortcutPrefix;
  }

  const normalized = value.trim();
  if (!normalized) {
    return DEFAULT_BROWSER_SETTINGS.searchEngineShortcutPrefix;
  }

  return normalized[0];
}

function normalizeShortcutChar(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return normalized[0];
}

function normalizeSearchEngineShortcutChars(value: unknown): SearchEngineShortcutChars {
  const source =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<SearchEngine, unknown>>)
      : {};

  return {
    google: normalizeShortcutChar(source.google, DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.google),
    duckduckgo: normalizeShortcutChar(
      source.duckduckgo,
      DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.duckduckgo,
    ),
    bing: normalizeShortcutChar(source.bing, DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.bing),
    yahoo: normalizeShortcutChar(source.yahoo, DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.yahoo),
    startpage: normalizeShortcutChar(
      source.startpage,
      DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.startpage,
    ),
    qwant: normalizeShortcutChar(source.qwant, DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.qwant),
    yandex: normalizeShortcutChar(source.yandex, DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.yandex),
    brave: normalizeShortcutChar(source.brave, DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.brave),
    ecosia: normalizeShortcutChar(source.ecosia, DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS.ecosia),
  };
}

function normalizeShowPerfOverlay(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.showPerfOverlay;
  }

  return value;
}

function normalizeShowBookmarkButton(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.showBookmarkButton;
  }

  return value;
}

function normalizeShowBookmarksBar(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.showBookmarksBar;
  }

  return value;
}

function normalizeCookiesEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.cookiesEnabled;
  }

  return value;
}

function normalizeDevSetting(value: unknown): boolean {
  // Only force-disable this in explicit release builds.
  if (FORCE_DISABLE_DEV_SETTING) {
    return false;
  }

  if (typeof value !== 'boolean') {
    return DEFAULT_BROWSER_SETTINGS.dev;
  }

  return value;
}

/**
 * Coerces arbitrary persisted data into a fully valid browser settings object.
 */
export function normalizeBrowserSettings(value: unknown): BrowserSettings {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_BROWSER_SETTINGS;
  }

  const candidate = value as Partial<BrowserSettings> & {
    hiddenDevSettingEnabled?: unknown;
  };
  const minimizedWindowSleepUnit = candidate.minimizedWindowSleepUnit === 'seconds'
    || candidate.minimizedWindowSleepUnit === 'hours'
    ? candidate.minimizedWindowSleepUnit : DEFAULT_BROWSER_SETTINGS.minimizedWindowSleepUnit;
  const maxWindowSleepValue = minimizedWindowSleepUnit === 'hours' ? 24
    : minimizedWindowSleepUnit === 'minutes' ? 1440 : 86400;
  return {
    newTabPage: normalizeNewTabPage(candidate.newTabPage),
    themeId: normalizeThemeId(candidate.themeId),
    rawFileDarkModeEnabled: normalizeRawFileDarkModeEnabled(candidate.rawFileDarkModeEnabled),
    animationsEnabled: normalizeAnimationsEnabled(candidate.animationsEnabled),
    nativeTextFieldContextMenu: normalizeNativeTextFieldContextMenu(
      candidate.nativeTextFieldContextMenu,
    ),
    layoutId: normalizeLayoutId(candidate.layoutId),
    tabSleepValue: normalizeTabSleepValue(candidate.tabSleepValue),
    tabSleepUnit: normalizeTabSleepUnit(candidate.tabSleepUnit),
    tabSleepMode: normalizeTabSleepMode(candidate.tabSleepMode),
    suspendMinimizedWindows: candidate.suspendMinimizedWindows === true,
    minimizedWindowSleepValue:
      typeof candidate.minimizedWindowSleepValue === 'number' && Number.isFinite(candidate.minimizedWindowSleepValue)
        ? Math.min(maxWindowSleepValue, Math.max(1, Math.floor(candidate.minimizedWindowSleepValue)))
        : DEFAULT_BROWSER_SETTINGS.minimizedWindowSleepValue,
    minimizedWindowSleepUnit,
    devToolsOpenMode: normalizeDevToolsOpenMode(candidate.devToolsOpenMode),
    adBlockEnabled: normalizeAdBlockEnabled(candidate.adBlockEnabled),
    youtubeAdBlockBetaEnabled: candidate.youtubeAdBlockBetaEnabled === true,
    trackerBlockEnabled: normalizeTrackerBlockEnabled(
      candidate.trackerBlockEnabled,
      normalizeAdBlockEnabled(candidate.adBlockEnabled),
    ),
    quitOnLastWindowClose: normalizeQuitOnLastWindowClose(candidate.quitOnLastWindowClose),
    showNewTabBranding: normalizeShowNewTabBranding(candidate.showNewTabBranding),
    disableNewTabIntro: normalizeDisableNewTabIntro(candidate.disableNewTabIntro),
    includePrereleaseUpdates: normalizeIncludePrereleaseUpdates(candidate.includePrereleaseUpdates),
    autoUpdateOnLaunch: normalizeAutoUpdateOnLaunch(candidate.autoUpdateOnLaunch),
    runOnStartup: normalizeRunOnStartup(candidate.runOnStartup),
    startupRestoreBehavior: normalizeStartupRestoreBehavior(candidate.startupRestoreBehavior),
    tabStripPosition: normalizeTabStripPosition(candidate.tabStripPosition),
    verticalTabsAddressBarInTopBar:
      typeof candidate.verticalTabsAddressBarInTopBar === 'boolean'
        ? candidate.verticalTabsAddressBarInTopBar
        : DEFAULT_BROWSER_SETTINGS.verticalTabsAddressBarInTopBar,
    searchEngine: normalizeSearchEngine(candidate.searchEngine),
    searchEngineShortcutsEnabled: normalizeSearchEngineShortcutsEnabled(
      candidate.searchEngineShortcutsEnabled,
    ),
    searchEngineShortcutPrefix: normalizeSearchEngineShortcutPrefix(
      candidate.searchEngineShortcutPrefix,
    ),
    searchEngineShortcutChars: normalizeSearchEngineShortcutChars(
      candidate.searchEngineShortcutChars,
    ),
    showPerfOverlay: normalizeShowPerfOverlay(candidate.showPerfOverlay),
    showBookmarkButton: normalizeShowBookmarkButton(candidate.showBookmarkButton),
    showBookmarksBar: normalizeShowBookmarksBar(candidate.showBookmarksBar),
    cookiesEnabled: normalizeCookiesEnabled(candidate.cookiesEnabled),
    dev: normalizeDevSetting(candidate.dev ?? candidate.hiddenDevSettingEnabled),
  };
}

/**
 * Converts the tab sleep setting into milliseconds.
 */
export function getTabSleepAfterMs(settings: BrowserSettings): number {
  return settings.tabSleepValue * TAB_SLEEP_UNIT_TO_MS[settings.tabSleepUnit];
}

export function getMinimizedWindowSleepAfterMs(settings: BrowserSettings): number {
  return Math.min(24 * 60 * 60 * 1000,
    settings.minimizedWindowSleepValue * TAB_SLEEP_UNIT_TO_MS[settings.minimizedWindowSleepUnit]);
}

/**
 * Builds a search URL for a query using the selected engine template.
 */
export function getSearchUrlForQuery(query: string, engine: SearchEngine): string {
  const searchQuery = new URLSearchParams({ q: query }).toString();

  switch (engine) {
    case 'duckduckgo':
      return `https://duckduckgo.com/?${searchQuery}`;
    case 'bing':
      return `https://www.bing.com/search?${searchQuery}`;
    case 'yahoo':
      return `https://search.yahoo.com/search?${searchQuery}`;
    case 'startpage':
      return `https://www.startpage.com/sp/search?${searchQuery}`;
    case 'qwant':
      return `https://www.qwant.com/?${searchQuery}&t=web`;
    case 'yandex':
      return `https://yandex.com/search/?${searchQuery}`;
    case 'brave':
      return `https://search.brave.com/search?${searchQuery}`;
    case 'ecosia':
      return `https://www.ecosia.org/search?${searchQuery}`;
    case 'google':
    default:
      return `https://www.google.com/search?${searchQuery}`;
  }
}

/**
 * Returns the effective set of engine shortcut tokens (e.g. `!g`, `!d`).
 */
export function getSearchEngineShortcuts(
  shortcutPrefix: string,
  shortcutChars: SearchEngineShortcutChars,
): Array<{ shortcut: string; engine: SearchEngine; label: string }> {
  const normalizedPrefix = normalizeSearchEngineShortcutPrefix(shortcutPrefix);
  const normalizedChars = normalizeSearchEngineShortcutChars(shortcutChars);

  return SEARCH_ENGINE_OPTIONS.map((option) => ({
    shortcut: `${normalizedPrefix}${normalizedChars[option.value]}`,
    engine: option.value,
    label: option.label,
  }));
}

/**
 * Parses a user search input, applying engine shortcut overrides when enabled.
 */
export function parseSearchInput(
  input: string,
  fallbackEngine: SearchEngine,
  shortcutsEnabled: boolean,
  shortcutPrefix: string,
  shortcutChars: SearchEngineShortcutChars,
): { query: string; engine: SearchEngine } {
  const normalizedInput = input.trim();
  if (!normalizedInput) {
    return {
      query: '',
      engine: fallbackEngine,
    };
  }

  if (!shortcutsEnabled) {
    return {
      query: normalizedInput,
      engine: fallbackEngine,
    };
  }

  const shortcuts = getSearchEngineShortcuts(shortcutPrefix, shortcutChars);
  const [prefix, ...rest] = normalizedInput.split(/\s+/);
  const normalizedPrefixToken = prefix.toLowerCase();
  const shortcutMatch = shortcuts.find(
    (entry) => entry.shortcut.toLowerCase() === normalizedPrefixToken,
  );

  if (!shortcutMatch) {
    return {
      query: normalizedInput,
      engine: fallbackEngine,
    };
  }

  const queryAfterShortcut = rest.join(' ').trim();
  if (!queryAfterShortcut) {
    return {
      query: normalizedInput,
      engine: fallbackEngine,
    };
  }

  return {
    query: queryAfterShortcut,
    engine: shortcutMatch.engine,
  };
}

/**
 * Parses search input and returns a complete provider URL.
 */
export function getSearchUrlFromInput(
  input: string,
  fallbackEngine: SearchEngine,
  shortcutsEnabled = true,
  shortcutPrefix = DEFAULT_SEARCH_ENGINE_SHORTCUT_PREFIX,
  shortcutChars = DEFAULT_SEARCH_ENGINE_SHORTCUT_CHARS,
): string {
  const { query, engine } = parseSearchInput(
    input,
    fallbackEngine,
    shortcutsEnabled,
    shortcutPrefix,
    shortcutChars,
  );
  return getSearchUrlForQuery(query, engine);
}

/**
 * Reads and normalizes browser settings from local storage.
 */
export function getBrowserSettings(): BrowserSettings {
  try {
    const raw = localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_BROWSER_SETTINGS;

    const parsed = JSON.parse(raw) as unknown;
    return normalizeBrowserSettings(parsed);
  } catch {
    return DEFAULT_BROWSER_SETTINGS;
  }
}

/**
 * Merges, normalizes, persists, and broadcasts updated browser settings.
 */
export function saveBrowserSettings(next: Partial<BrowserSettings>): BrowserSettings {
  const merged = {
    ...getBrowserSettings(),
    ...next,
  };
  const normalized = normalizeBrowserSettings(merged);

  try {
    localStorage.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage failures and still return normalized values.
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BROWSER_SETTINGS_CHANGED_EVENT, { detail: normalized }));
  }

  return normalized;
}
