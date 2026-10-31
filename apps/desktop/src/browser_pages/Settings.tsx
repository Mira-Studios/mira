import { Children, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { AppWindow, Check, ChevronLeft, Cookie, Globe, RefreshCw, Trash2, ChevronDown, ChevronRight, ChevronUp, Code2, Palette, PanelsTopLeft, Search, Settings2, Shield } from 'lucide-react';
import './Settings.css';
import { useTabs } from '../features/tabs/TabsProvider';
import { useDownloads } from '../features/downloads/DownloadProvider';
import { clearHistoryEntries } from '../features/history/clientHistory';
import {
  DEFAULT_BROWSER_SETTINGS,
  SEARCH_ENGINE_OPTIONS,
  getBrowserSettings,
  getSearchEngineShortcuts,
  saveBrowserSettings,
  type AutoUpdateMode,
  type DevToolsOpenMode,
  type SearchEngine,
  type SearchEngineShortcutChars,
  type StartupRestoreBehavior,
  type TabSleepMode,
  type TabStripPosition,
} from '../features/settings/browserSettings';
import { applyTheme } from '../features/themes/applyTheme';
import {
  deleteCustomTheme,
  getAllThemes,
  getThemeById,
  importThemeFromJson,
  type ThemeEntry,
} from '../features/themes/themeLoader';
import { applyLayout } from '../features/layouts/applyLayout';
import {
  deleteCustomLayout,
  getAllLayouts,
  getLayoutById,
  importLayoutFromJson,
  type LayoutEntry,
} from '../features/layouts/layoutLoader';
import { electron } from '../electronBridge';

type UpdateCheckPayload = {
  mode: 'portable' | 'installer';
  currentVersion: string;
  latestVersion: string;
  latestIsPrerelease: boolean;
  hasUpdate: boolean;
  releaseName: string;
  assetName: string;
  downloadUrl: string;
};

type UpdateCheckResponse = { ok: true; data: UpdateCheckPayload } | { ok: false; error: string };

type UpdateLaunchAutoSupportResponse = {
  canAutoInstall: boolean;
};

type OnboardingResetResponse = boolean;

type RunOnStartupStatusResponse = {
  ok: boolean;
  canConfigure: boolean;
  isEnabled: boolean;
  message?: string;
};

type DefaultBrowserStatusResponse = {
  isDefault: boolean;
  message?: string;
  support?: {
    code:
      | 'ok'
      | 'dev-build'
      | 'windows-portable'
      | 'manual-confirmation-required'
      | 'registration-failed';
    canAttemptRegistration: boolean;
    requiresUserAction: boolean;
    message: string;
    platform: string;
    isPackaged: boolean;
    isPortableBuild: boolean;
    processDefaultApp: boolean;
  };
};

type SetDefaultBrowserResponse = {
  ok: boolean;
  isDefault: boolean;
  requiresUserAction?: boolean;
  message?: string;
  support?: {
    code:
      | 'ok'
      | 'dev-build'
      | 'windows-portable'
      | 'manual-confirmation-required'
      | 'registration-failed';
    canAttemptRegistration: boolean;
    requiresUserAction: boolean;
    message: string;
    platform: string;
    isPackaged: boolean;
    isPortableBuild: boolean;
    processDefaultApp: boolean;
  };
};

type SettingsSectionId = 'general' | 'search' | 'appearance' | 'layout' | 'privacy-security' | 'app' | 'dev';

type PrivacySecuritySubsection = 'site-permissions' | 'cookies';

const SETTINGS_SECTION_ICONS = {
  general: Settings2,
  search: Search,
  appearance: Palette,
  layout: PanelsTopLeft,
  'privacy-security': Shield,
  app: AppWindow,
  dev: Code2,
};

const SETTINGS_SECTION_TABS: Array<{
  id: SettingsSectionId;
  label: string;
}> = [
  {
    id: 'general',
    label: 'General',
  },
  {
    id: 'search',
    label: 'Search',
  },
  {
    id: 'appearance',
    label: 'Appearance',
  },
  {
    id: 'layout',
    label: 'Layout',
  },
  {
    id: 'privacy-security',
    label: 'Privacy & Security',
  },
  {
    id: 'app',
    label: 'App',
  },
];

const APP_DATA_STORAGE_KEYS = [
  'mira.settings.browser.v1',
  'mira.themes.custom.v1',
  'mira.layouts.custom.v1',
  'mira.session.tabs.v1',
];

// All site permission IDs and labels for detail view
const ALL_SITE_PERMISSIONS: Array<{ id: string; label: string }> = [
  { id: 'camera', label: 'Camera' },
  { id: 'microphone', label: 'Microphone' },
  { id: 'location', label: 'Location' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'fullscreen', label: 'Fullscreen' },
  { id: 'clipboard', label: 'Clipboard' },
  { id: 'pointer-lock', label: 'Pointer Lock' },
  { id: 'screen-capture', label: 'Screen Capture' },
  { id: 'midi', label: 'MIDI' },
  { id: 'sensors', label: 'Motion and orientation' },
  { id: 'storage-access', label: 'Cross-site cookies and site data' },
  { id: 'window-management', label: 'Window Management' },
  { id: 'idle-detection', label: 'Idle Detection' },
  { id: 'speaker-selection', label: 'Speaker Selection' },
  { id: 'keyboard-lock', label: 'Keyboard Lock' },
  { id: 'external-apps', label: 'External Apps' },
  { id: 'file-system', label: 'File System' },
];

const parseHashParams = (hash: string) => {
  const params: Record<string, string> = {};
  if (!hash) return params;
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmed) return params;
  const searchParams = new URLSearchParams(trimmed);
  let hasPairs = false;
  for (const [key, value] of searchParams.entries()) {
    hasPairs = true;
    if (!key) continue;
    params[key.toLowerCase()] = value;
  }
  if (!hasPairs && trimmed) {
    params.section = trimmed;
  }
  return params;
};

const resolveSectionFromParams = (
  params: Record<string, string>,
  available: SettingsSectionId[],
): SettingsSectionId | null => {
  const rawSection = params.section ?? '';
  const normalized = rawSection.trim().toLowerCase();
  return available.includes(normalized as SettingsSectionId)
    ? (normalized as SettingsSectionId)
    : null;
};

function isBuiltInNewTabPageUrl(value: string): boolean {
  return value.trim().toLowerCase() === DEFAULT_BROWSER_SETTINGS.newTabPage.trim().toLowerCase();
}

type SettingsVisibilityProps = {
  visible: boolean;
  animated: boolean;
  children: ReactNode;
};

function SettingsGroup({ children }: { children: ReactNode }) {
  const [heading, ...content] = Children.toArray(children);
  return (
    <section className="settings-group">
      {heading}
      <div className="settings-card">{content}</div>
    </section>
  );
}

function SettingsVisibility({ visible, animated, children }: SettingsVisibilityProps) {
  if (!animated) {
    return visible ? <>{children}</> : null;
  }

  return (
    <div
      className={`settings-visibility settings-visibility-animated ${
        visible ? 'settings-visibility-open' : 'settings-visibility-closed'
      }`}
      aria-hidden={!visible}
    >
      <div className="settings-visibility-inner">{children}</div>
    </div>
  );
}

export default function Settings() {
  const AUTO_SAVE_DELAY_MS = 300;
  const SAVED_BADGE_MS = 1600;

  const initialSettings = getBrowserSettings();
  const [newTabPage, setNewTabPage] = useState(() => initialSettings.newTabPage);
  const [searchEngine, setSearchEngine] = useState<SearchEngine>(
    () => initialSettings.searchEngine,
  );
  const [searchEngineShortcutsEnabled, setSearchEngineShortcutsEnabled] = useState(
    () => initialSettings.searchEngineShortcutsEnabled,
  );
  const [searchEngineShortcutPrefix, setSearchEngineShortcutPrefix] = useState(
    () => initialSettings.searchEngineShortcutPrefix,
  );
  const [searchEngineShortcutChars, setSearchEngineShortcutChars] =
    useState<SearchEngineShortcutChars>(() => initialSettings.searchEngineShortcutChars);
  const [themeId, setThemeId] = useState(() => initialSettings.themeId);
  const [rawFileDarkModeEnabled, setRawFileDarkModeEnabled] = useState(
    () => initialSettings.rawFileDarkModeEnabled,
  );
  const [animationsEnabled, setAnimationsEnabled] = useState(
    () => initialSettings.animationsEnabled,
  );
  const [nativeTextFieldContextMenu, setNativeTextFieldContextMenu] = useState(
    () => initialSettings.nativeTextFieldContextMenu,
  );
  const [layoutId, setLayoutId] = useState(() => initialSettings.layoutId);
  const [tabSleepValue, setTabSleepValue] = useState(() => initialSettings.tabSleepValue);
  const [tabSleepUnit, setTabSleepUnit] = useState(() => initialSettings.tabSleepUnit);
  const [tabSleepMode, setTabSleepMode] = useState(() => initialSettings.tabSleepMode);
  const [devToolsOpenMode, setDevToolsOpenMode] = useState(() => initialSettings.devToolsOpenMode);
  const [adBlockEnabled, setAdBlockEnabled] = useState(() => initialSettings.adBlockEnabled);
  const [trackerBlockEnabled, setTrackerBlockEnabled] = useState(
    () => initialSettings.trackerBlockEnabled,
  );
  const [quitOnLastWindowClose] = useState(() => initialSettings.quitOnLastWindowClose);
  const [showNewTabBranding, setShowNewTabBranding] = useState(
    () => initialSettings.showNewTabBranding,
  );
  const [disableNewTabIntro, setDisableNewTabIntro] = useState(
    () => initialSettings.disableNewTabIntro,
  );
  const [includePrereleaseUpdates, setIncludePrereleaseUpdates] = useState(
    () => initialSettings.includePrereleaseUpdates,
  );
  const [autoUpdateMode, setAutoUpdateMode] = useState<AutoUpdateMode>(
    () => initialSettings.autoUpdateOnLaunch,
  );
  const [runOnStartup, setRunOnStartup] = useState(() => initialSettings.runOnStartup);
  const [startupRestoreBehavior, setStartupRestoreBehavior] = useState<StartupRestoreBehavior>(
    () => initialSettings.startupRestoreBehavior,
  );
  const [tabStripPosition, setTabStripPosition] = useState<TabStripPosition>(
    () => initialSettings.tabStripPosition ?? DEFAULT_BROWSER_SETTINGS.tabStripPosition,
  );
  const [showPerfOverlay, setShowPerfOverlay] = useState(() => initialSettings.showPerfOverlay);
  const [showBookmarkButton, setShowBookmarkButton] = useState(() => initialSettings.showBookmarkButton);
  const [verticalTabsAddressBarInTopBar, setVerticalTabsAddressBarInTopBar] = useState(
    () => initialSettings.verticalTabsAddressBarInTopBar,
  );
  const [showBookmarksBar, setShowBookmarksBar] = useState(() => initialSettings.showBookmarksBar);
  const [cookiesEnabled, setCookiesEnabled] = useState(() => initialSettings.cookiesEnabled);
  const [themes, setThemes] = useState<ThemeEntry[]>(() => getAllThemes());
  const [layouts, setLayouts] = useState<LayoutEntry[]>(() => getAllLayouts());
  const [themeDropdownOpen, setThemeDropdownOpen] = useState(false);
  const [layoutDropdownOpen, setLayoutDropdownOpen] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const themeFileInputRef = useRef<HTMLInputElement | null>(null);
  const layoutFileInputRef = useRef<HTMLInputElement | null>(null);
  const layoutDropdownRef = useRef<HTMLDivElement | null>(null);
  const themeDropdownRef = useRef<HTMLDivElement | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckPayload | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isRunningUpdateAction, setIsRunningUpdateAction] = useState(false);
  const [isResettingOnboarding, setIsResettingOnboarding] = useState(false);
  const [isResettingAppData, setIsResettingAppData] = useState(false);
  const [canAutoInstallOnLaunch, setCanAutoInstallOnLaunch] = useState(false);
  const [canConfigureRunOnStartup, setCanConfigureRunOnStartup] = useState(false);
  const [runOnStartupStatus, setRunOnStartupStatus] = useState('');
  const [onboardingResetStatus, setOnboardingResetStatus] = useState('');
  const [appDataResetStatus, setAppDataResetStatus] = useState('');
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general');
  const [privacySecuritySubsection, setPrivacySecuritySubsection] = useState<PrivacySecuritySubsection | null>(null);
  const [isDefaultBrowser, setIsDefaultBrowser] = useState<boolean | null>(null);
  const [canAttemptDefaultBrowserRegistration, setCanAttemptDefaultBrowserRegistration] =
    useState(true);
  const [defaultBrowserStatus, setDefaultBrowserStatus] = useState('');
  const [isCheckingDefaultBrowser, setIsCheckingDefaultBrowser] = useState(false);
  const [isSettingDefaultBrowser, setIsSettingDefaultBrowser] = useState(false);
  const isFirstAutoSaveRef = useRef(true);
  const clearSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { navigate, tabs, activeId } = useTabs();
  const { clear: clearDownloads } = useDownloads();

  // Site permissions state
  const [sitePermissions, setSitePermissions] = useState<Array<{
    origin: string;
    siteLabel: string;
    permissions: Array<{ id: string; label: string; decision: string }>;
  }>>([]);
  const [isLoadingSitePermissions, setIsLoadingSitePermissions] = useState(false);
  const [sitePermissionStatus, setSitePermissionStatus] = useState('');
  const [selectedSiteOrigin, setSelectedSiteOrigin] = useState<string | null>(null);

  // Cookies state
  const [cookiesData, setCookiesData] = useState<Array<{
    origin: string;
    siteLabel: string;
    cookieCount: number;
  }>>([]);
  const [isLoadingCookies, setIsLoadingCookies] = useState(false);
  const [cookiesStatus, setCookiesStatus] = useState('');
  const [cookiesFilter, setCookiesFilter] = useState('');
  const [permissionsFilter, setPermissionsFilter] = useState('');

  const loadSitePermissions = useCallback(async () => {
    if (!electron?.ipcRenderer) {
      setSitePermissionStatus('Site permissions are only available in the desktop app.');
      return;
    }

    setIsLoadingSitePermissions(true);
    setSitePermissionStatus('');
    try {
      const response = await electron.ipcRenderer.invoke<{
        ok: boolean;
        origins?: Array<{
          origin: string;
          siteLabel: string;
          permissions: Array<{ id: string; label: string; decision: string }>;
        }>;
      }>('site-permissions-get-all');

      if (response.ok && response.origins) {
        setSitePermissions(response.origins);
      } else {
        setSitePermissionStatus('Could not load site permissions.');
      }
    } catch {
      setSitePermissionStatus('Failed to load site permissions.');
    } finally {
      setIsLoadingSitePermissions(false);
    }
  }, []);

  const deleteSitePermission = async (origin: string) => {
    if (!electron?.ipcRenderer) return;

    try {
      const response = await electron.ipcRenderer.invoke<{ ok: boolean }>(
        'site-permissions-delete',
        { origin }
      );

      if (!response.ok) throw new Error('Reset failed');
      if (response.ok) {
        setSitePermissions((current) => current.filter((site) => site.origin !== origin));
        if (selectedSiteOrigin?.replace(/^https?:\/\//, '') === origin.replace(/^https?:\/\//, '')) navigateToSitePermission(null);
      }
    } catch {
      setSitePermissionStatus('Failed to delete site permissions.');
    }
  };

  const deleteAllSitePermissions = async () => {
    const confirmed = window.confirm('This will clear all site permissions. Continue?');
    if (!confirmed) return;

    if (!electron?.ipcRenderer) return;

    try {
      const response = await electron.ipcRenderer.invoke<{ ok: boolean }>(
        'site-permissions-delete-all'
      );

      if (!response.ok) throw new Error('Reset failed');
      if (response.ok) {
        setSitePermissions([]);
        setSelectedSiteOrigin(null);
        setSitePermissionStatus('All site permissions cleared.');
      }
    } catch {
      setSitePermissionStatus('Failed to clear all site permissions.');
    }
  };

  const loadCookies = useCallback(async () => {
    if (!electron?.ipcRenderer) {
      setCookiesStatus('Cookie management is only available in the desktop app.');
      return;
    }

    setIsLoadingCookies(true);
    setCookiesStatus('');
    try {
      const response = await electron.ipcRenderer.invoke<{
        ok: boolean;
        origins?: Array<{
          origin: string;
          siteLabel: string;
          cookieCount: number;
        }>;
      }>('cookies-get-all');

      if (response.ok && response.origins) {
        setCookiesData(response.origins);
      } else {
        setCookiesStatus('Could not load cookies.');
      }
    } catch {
      setCookiesStatus('Failed to load cookies.');
    } finally {
      setIsLoadingCookies(false);
    }
  }, []);

  const deleteSiteCookies = async (origin: string) => {
    if (!electron?.ipcRenderer) return;

    try {
      const response = await electron.ipcRenderer.invoke<{ ok: boolean }>(
        'cookies-delete',
        { origin }
      );

      if (!response.ok) throw new Error('Delete failed');
      if (response.ok) {
        setCookiesData((current) => current.filter((site) => site.origin !== origin));
      }
    } catch {
      setCookiesStatus('Failed to delete cookies.');
    }
  };

  const deleteAllCookies = async () => {
    if (!electron?.ipcRenderer || !window.confirm('Clear cookies for all sites?')) return;
    setIsLoadingCookies(true);
    setCookiesStatus('');
    try {
      const response = await electron.ipcRenderer.invoke<{ ok: boolean }>('cookies-delete-all');
      if (!response.ok) throw new Error('Clear failed');
      setCookiesData([]);
      setCookiesStatus('Cookies cleared.');
    } catch {
      setCookiesStatus('Could not clear cookies.');
    } finally {
      setIsLoadingCookies(false);
    }
  };

  const updateSitePermission = async (origin: string, permissionId: string, decision: 'allow' | 'ask' | 'block') => {
    if (!electron?.ipcRenderer) return;

    try {
      const response = await electron.ipcRenderer.invoke<{
        ok?: boolean;
        snapshot?: {
          canManage: boolean;
          origin: string;
          siteLabel: string;
          permissions: Array<{ id: string; label: string; decision: string }>;
        };
      }>('site-permissions-update', {
        origin,
        permissionId,
        decision,
      });

      if (!response?.ok || !response.snapshot) throw new Error('Update failed');
      setSitePermissionStatus('');
      if (response?.ok && response.snapshot) {
        setSitePermissions((current) =>
          current.map((site) =>
            site.origin === origin
              ? { ...site, permissions: response.snapshot!.permissions.filter(p => p.decision !== 'ask') }
              : site
          )
        );
      }
    } catch {
      setSitePermissionStatus('Failed to update permission.');
    }
  };

  useEffect(() => {
    if (!electron?.ipcRenderer) return;
    void electron.ipcRenderer
      .invoke('updates-configure-auto-mode', {
        mode: autoUpdateMode,
        includePrerelease: includePrereleaseUpdates,
      })
      .catch(() => undefined);
  }, [autoUpdateMode, includePrereleaseUpdates]);

  const handleThemeChange = (nextThemeId: string) => {
    setThemeId(nextThemeId);
    setSaveStatus('saving');
    applyTheme(getThemeById(nextThemeId));
  };

  const handleLayoutChange = (nextLayoutId: string) => {
    setLayoutId(nextLayoutId);
    setSaveStatus('saving');
    applyLayout(getLayoutById(nextLayoutId));
  };

  const handleDeleteTheme = (deleteThemeId: string) => {
    const deleted = deleteCustomTheme(deleteThemeId);
    if (!deleted) return;

    const updatedThemes = getAllThemes();
    setThemes(updatedThemes);
    setSaveStatus('saving');

    if (themeId === deleteThemeId) {
      const fallbackThemeId = updatedThemes[0]?.id ?? DEFAULT_BROWSER_SETTINGS.themeId;
      setThemeId(fallbackThemeId);
      applyTheme(getThemeById(fallbackThemeId));
    }

    setImportMessage('Theme deleted.');
  };

  const handleDeleteLayout = (deleteLayoutId: string) => {
    const deleted = deleteCustomLayout(deleteLayoutId);
    if (!deleted) return;

    const updatedLayouts = getAllLayouts();
    setLayouts(updatedLayouts);
    setSaveStatus('saving');

    if (layoutId === deleteLayoutId) {
      const fallbackLayoutId = updatedLayouts[0]?.id ?? DEFAULT_BROWSER_SETTINGS.layoutId;
      setLayoutId(fallbackLayoutId);
      applyLayout(getLayoutById(fallbackLayoutId));
    }

    setImportMessage('Layout deleted.');
  };

  const handleImportTheme = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const imported = importThemeFromJson(text);
      const updatedThemes = getAllThemes();

      setThemes(updatedThemes);
      setThemeId(imported.id);
      applyTheme(imported.theme);
      setSaveStatus('saving');
      setImportMessage(`Imported: ${imported.theme.name} by ${imported.theme.author}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import theme JSON.';
      setImportMessage(message);
    }
  };

  useEffect(() => {
    if (isFirstAutoSaveRef.current) {
      isFirstAutoSaveRef.current = false;
      return;
    }

    setSaveStatus('saving');
    const timer = setTimeout(() => {
      saveBrowserSettings({
        newTabPage,
        searchEngine,
        searchEngineShortcutsEnabled,
        searchEngineShortcutPrefix,
        searchEngineShortcutChars,
        themeId,
        rawFileDarkModeEnabled,
        animationsEnabled,
        nativeTextFieldContextMenu,
        layoutId,
        tabSleepValue,
        tabSleepUnit,
        tabSleepMode,
        devToolsOpenMode,
        adBlockEnabled,
        trackerBlockEnabled,
        quitOnLastWindowClose,
        showNewTabBranding,
        disableNewTabIntro,
        includePrereleaseUpdates,
        autoUpdateOnLaunch: autoUpdateMode,
        runOnStartup,
        startupRestoreBehavior,
        showPerfOverlay,
        tabStripPosition,
        verticalTabsAddressBarInTopBar,
        showBookmarkButton,
        showBookmarksBar,
      });
      setSaveStatus('saved');

      if (clearSavedTimerRef.current) {
        clearTimeout(clearSavedTimerRef.current);
      }
      clearSavedTimerRef.current = setTimeout(() => {
        setSaveStatus('idle');
      }, SAVED_BADGE_MS);
    }, AUTO_SAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [
    newTabPage,
    searchEngine,
    searchEngineShortcutsEnabled,
    searchEngineShortcutPrefix,
    searchEngineShortcutChars,
    themeId,
    rawFileDarkModeEnabled,
    animationsEnabled,
    nativeTextFieldContextMenu,
    layoutId,
    tabSleepValue,
    tabSleepUnit,
    tabSleepMode,
    devToolsOpenMode,
    adBlockEnabled,
    trackerBlockEnabled,
    quitOnLastWindowClose,
    showNewTabBranding,
    disableNewTabIntro,
    includePrereleaseUpdates,
    autoUpdateMode,
    runOnStartup,
    startupRestoreBehavior,
    showPerfOverlay,
    tabStripPosition,
    verticalTabsAddressBarInTopBar,
    showBookmarkButton,
    showBookmarksBar,
    cookiesEnabled,
  ]);

  useEffect(() => {
    return () => {
      if (clearSavedTimerRef.current) {
        clearTimeout(clearSavedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!layoutDropdownOpen && !themeDropdownOpen) return;

    const isInsideDropdown = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      return (
        !!layoutDropdownRef.current?.contains(target) ||
        !!themeDropdownRef.current?.contains(target)
      );
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!isInsideDropdown(event.target)) {
        setLayoutDropdownOpen(false);
        setThemeDropdownOpen(false);
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isInsideDropdown(event.target)) {
        setLayoutDropdownOpen(false);
        setThemeDropdownOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLayoutDropdownOpen(false);
        setThemeDropdownOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [layoutDropdownOpen, themeDropdownOpen]);

  const selectedTheme = themes.find((entry) => entry.id === themeId) ?? themes[0] ?? null;
  const selectedLayout = layouts.find((entry) => entry.id === layoutId) ?? layouts[0] ?? null;
  const formatThemeLabel = (entry: ThemeEntry) => {
    const modeLabel = entry.theme.mode === 'light' ? 'Light' : 'Dark';
    return `${entry.theme.name} - ${entry.theme.author} (${modeLabel})`;
  };

  const handleImportLayout = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const imported = importLayoutFromJson(text);
      const updatedLayouts = getAllLayouts();

      setLayouts(updatedLayouts);
      setLayoutId(imported.id);
      applyLayout(imported.layout);
      setSaveStatus('saving');
      setImportMessage(`Imported layout: ${imported.layout.name} by ${imported.layout.author}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import layout JSON.';
      setImportMessage(message);
    }
  };
  const formatLayoutLabel = (entry: LayoutEntry) => `${entry.layout.name} - ${entry.layout.author}`;
  const searchEngineShortcuts = getSearchEngineShortcuts(
    searchEngineShortcutPrefix,
    searchEngineShortcutChars,
  );
  const shortcutExample = searchEngineShortcuts[0]?.shortcut ?? '!g';
  const secondShortcutExample = searchEngineShortcuts[1]?.shortcut ?? '!d';

  const handleSearchShortcutPrefixChange = (value: string) => {
    const normalized = value.replace(/\s+/g, '');
    if (!normalized) return;
    setSearchEngineShortcutPrefix(normalized[normalized.length - 1]);
    setSaveStatus('saving');
  };

  const handleSearchShortcutCharChange = (engine: SearchEngine, value: string) => {
    const normalized = value.replace(/\s+/g, '').toLowerCase();
    if (!normalized) return;
    setSearchEngineShortcutChars((current) => ({
      ...current,
      [engine]: normalized[normalized.length - 1],
    }));
    setSaveStatus('saving');
  };

  const checkForUpdates = useCallback(async () => {
    if (!electron?.ipcRenderer) {
      setUpdateStatus('Update checks are only available in the desktop app.');
      return;
    }

    setIsCheckingUpdates(true);
    setUpdateStatus('');
    setUpdateCheckResult(null);
    try {
      const response = await electron.ipcRenderer.invoke<UpdateCheckResponse>('updates-check', {
        includePrerelease: includePrereleaseUpdates,
      });

      if (!response.ok) {
        setUpdateStatus(response.error);
        return;
      }

      const result = response.data;
      setUpdateCheckResult(result);

      if (!result.hasUpdate) {
        setUpdateStatus(`You are up to date (v${result.currentVersion}).`);
        return;
      }

      const prereleaseLabel = result.latestIsPrerelease ? ' (pre-release)' : '';
      setUpdateStatus(`Update available: v${result.latestVersion}${prereleaseLabel}.`);
    } catch {
      setUpdateStatus('Failed to check for updates.');
    } finally {
      setIsCheckingUpdates(false);
    }
  }, [includePrereleaseUpdates]);

  const runUpdateAction = async () => {
    if (!electron?.ipcRenderer || !updateCheckResult || !updateCheckResult.hasUpdate) return;

    setIsRunningUpdateAction(true);
    try {
      if (updateCheckResult.mode === 'portable') {
        const response = await electron.ipcRenderer.invoke<{
          ok: boolean;
          savedPath?: string;
          error?: string;
        }>('updates-download-asset', {
          downloadUrl: updateCheckResult.downloadUrl,
          assetName: updateCheckResult.assetName,
        });
        if (!response.ok) {
          setUpdateStatus(response.error || 'Failed to download update.');
          return;
        }

        setUpdateStatus(
          response.savedPath
            ? `Portable update downloaded: ${response.savedPath}`
            : 'Portable update downloaded to your Downloads folder.',
        );
        return;
      }

      const response = await electron.ipcRenderer.invoke<{ ok: boolean; error?: string }>(
        'updates-download-and-install',
        {
          downloadUrl: updateCheckResult.downloadUrl,
          assetName: updateCheckResult.assetName,
        },
      );
      if (!response.ok) {
        setUpdateStatus(response.error || 'Failed to download update.');
        return;
      }

      setUpdateStatus('Update downloaded. Installer launched.');
    } catch {
      setUpdateStatus('Failed to run update action.');
    } finally {
      setIsRunningUpdateAction(false);
    }
  };

  const resetOnboarding = async () => {
    if (!electron?.ipcRenderer) {
      setOnboardingResetStatus('Onboarding reset is only available in the desktop app.');
      return;
    }

    setIsResettingOnboarding(true);
    setOnboardingResetStatus('');
    try {
      const response =
        await electron.ipcRenderer.invoke<OnboardingResetResponse>('onboarding-reset');
      if (response !== true) {
        setOnboardingResetStatus('Failed to reset onboarding.');
        return;
      }
      setOnboardingResetStatus('Onboarding reset. It will show again on next app open.');
    } catch {
      setOnboardingResetStatus('Failed to reset onboarding.');
    } finally {
      setIsResettingOnboarding(false);
    }
  };

  const resetAppData = async () => {
    const confirmed = window.confirm(
      'This will clear history, session, downloads, and settings for this profile. Continue?',
    );
    if (!confirmed) return;

    setIsResettingAppData(true);
    setAppDataResetStatus('');
    try {
      clearDownloads();
      await clearHistoryEntries().catch(() => undefined);

      if (electron?.ipcRenderer) {
        await Promise.allSettled([
          electron.ipcRenderer.invoke('session-save-window', null),
          electron.ipcRenderer.invoke('session-discard-restore'),
        ]);
      }

      for (const storageKey of APP_DATA_STORAGE_KEYS) {
        localStorage.removeItem(storageKey);
      }

      setAppDataResetStatus('App data cleared. Reloading...');
      window.setTimeout(() => {
        window.location.reload();
      }, 250);
    } catch {
      setAppDataResetStatus('Failed to reset app data.');
    } finally {
      setIsResettingAppData(false);
    }
  };

  const refreshDefaultBrowserStatus = async () => {
    if (!electron?.ipcRenderer) {
      setDefaultBrowserStatus('Default browser controls are only available in the desktop app.');
      return;
    }

    setIsCheckingDefaultBrowser(true);
    setDefaultBrowserStatus('');
    try {
      const response =
        await electron.ipcRenderer.invoke<DefaultBrowserStatusResponse>('default-browser-status');
      setIsDefaultBrowser(response.isDefault);
      setCanAttemptDefaultBrowserRegistration(response.support?.canAttemptRegistration ?? true);
      setDefaultBrowserStatus(
        response.isDefault
          ? 'Mira is already your default browser.'
          : response.message || response.support?.message || '',
      );
    } catch {
      setDefaultBrowserStatus('Failed to check default browser status.');
    } finally {
      setIsCheckingDefaultBrowser(false);
    }
  };

  const setAsDefaultBrowser = async () => {
    if (!electron?.ipcRenderer) {
      setDefaultBrowserStatus('Default browser controls are only available in the desktop app.');
      return;
    }

    setIsSettingDefaultBrowser(true);
    setDefaultBrowserStatus('');
    try {
      const response =
        await electron.ipcRenderer.invoke<SetDefaultBrowserResponse>('default-browser-set');
      setIsDefaultBrowser(response.isDefault);
      setCanAttemptDefaultBrowserRegistration(response.support?.canAttemptRegistration ?? true);
      setDefaultBrowserStatus(
        response.message ||
          response.support?.message ||
          (response.ok
            ? response.requiresUserAction
              ? 'Mira was registered for web links and additional handlers. Confirm Mira in your OS default apps settings, then refresh status.'
              : 'Mira is now set as your default browser.'
            : 'Could not set Mira as default browser. Check your OS default apps settings.'),
      );
    } catch {
      setDefaultBrowserStatus('Failed to set default browser.');
    } finally {
      setIsSettingDefaultBrowser(false);
    }
  };

  useEffect(() => {
    if (!electron?.ipcRenderer) return;

    let isSubscribed = true;
    void electron.ipcRenderer
      .invoke<UpdateLaunchAutoSupportResponse>('updates-launch-auto-support')
      .then((response) => {
        if (!isSubscribed) return;
        setCanAutoInstallOnLaunch(response.canAutoInstall === true);
      })
      .catch(() => {
        if (!isSubscribed) return;
        setCanAutoInstallOnLaunch(false);
      });

    return () => {
      isSubscribed = false;
    };
  }, []);

  useEffect(() => {
    if (!electron?.ipcRenderer) return;

    let isSubscribed = true;
    void electron.ipcRenderer
      .invoke<RunOnStartupStatusResponse>('settings-run-on-startup-status')
      .then((response) => {
        if (!isSubscribed) return;
        setCanConfigureRunOnStartup(response.canConfigure === true);
        setRunOnStartupStatus(response.message || '');
        if (response.canConfigure) {
          setRunOnStartup(response.isEnabled === true);
        }
      })
      .catch(() => {
        if (!isSubscribed) return;
      });

    return () => {
      isSubscribed = false;
    };
  }, []);

  const canConfigureRunOnStartupSetting = electron?.isMacOS || electron?.platform === 'win32';
  const isWindowsPlatform = electron?.platform === 'win32';
  const isDevSettingsEnabled = initialSettings.dev;
  const settingsSectionTabs = useMemo<Array<{ id: SettingsSectionId; label: string }>>(
    () =>
      isDevSettingsEnabled
        ? [...SETTINGS_SECTION_TABS, { id: 'dev', label: 'Dev' }]
        : SETTINGS_SECTION_TABS,
    [isDevSettingsEnabled],
  );
  const settingsSectionIds = useMemo(
    () => settingsSectionTabs.map((section) => section.id),
    [settingsSectionTabs],
  );

  const activeTabUrl = useMemo(
    () => tabs.find((tab) => tab.id === activeId)?.url ?? '',
    [tabs, activeId],
  );
  const isSyncingFromUrlRef = useRef(false);

  const isSettingsTab = useMemo(() => {
    const trimmed = activeTabUrl.trim();
    return trimmed.toLowerCase().startsWith('mira://settings');
  }, [activeTabUrl]);
  const isBuiltInNewTabPage = useMemo(() => isBuiltInNewTabPageUrl(newTabPage), [newTabPage]);
  const hasTriggeredUpdateCheckRef = useRef(false);

  useEffect(() => {
    if (!isSettingsTab) return;
    const hash = activeTabUrl.includes('#') ? activeTabUrl.slice(activeTabUrl.indexOf('#')) : '';
    const params = parseHashParams(hash);
    const nextSection = resolveSectionFromParams(params, settingsSectionIds);
    if (nextSection) {
      setActiveSection((prev) => {
        if (prev === nextSection) return prev;
        isSyncingFromUrlRef.current = true;
        return nextSection;
      });
      return;
    }
    setActiveSection((prev) => {
      if (prev === 'general') return prev;
      return 'general';
    });
  }, [activeTabUrl, isSettingsTab, settingsSectionIds]);

  useEffect(() => {
    if (!isSettingsTab) return;
    const hash = activeTabUrl.includes('#') ? activeTabUrl.slice(activeTabUrl.indexOf('#')) : '';
    const params = parseHashParams(hash);
    const checkUpdatesParam = (params.checkupdates ?? '').toLowerCase();
    if (checkUpdatesParam === '1' || checkUpdatesParam === 'true' || checkUpdatesParam === 'yes') {
      hasTriggeredUpdateCheckRef.current = true;
      void checkForUpdates();
    }
  }, [activeTabUrl, checkForUpdates, isSettingsTab]);

  useEffect(() => {
    if (!isSettingsTab) return;
    const hash = activeTabUrl.includes('#') ? activeTabUrl.slice(activeTabUrl.indexOf('#')) : '';
    const params = parseHashParams(hash);
    const subsectionParam = params.subsection ?? '';
    if (subsectionParam === 'site-permissions' || subsectionParam === 'cookies') {
      setPrivacySecuritySubsection(subsectionParam as PrivacySecuritySubsection);
    } else {
      setPrivacySecuritySubsection(null);
    }
  }, [activeTabUrl, isSettingsTab]);

  useEffect(() => {
    if (activeSection !== 'privacy-security') return;
    if (privacySecuritySubsection === 'site-permissions') void loadSitePermissions();
    if (privacySecuritySubsection === 'cookies') void loadCookies();
  }, [activeSection, privacySecuritySubsection, loadSitePermissions, loadCookies]);

  useEffect(() => {
    if (!isSettingsTab || activeSection !== 'privacy-security' || privacySecuritySubsection !== 'site-permissions') return;
    const params = parseHashParams(activeTabUrl.split('#')[1] ?? '');
    setSelectedSiteOrigin(params.site || null);
  }, [activeSection, privacySecuritySubsection, activeTabUrl, isSettingsTab]);

  // Navigate to site permission detail
  const navigateToSitePermission = (site: string | null) => {
    const baseUrl = activeTabUrl ? activeTabUrl.split('#')[0] : 'mira://Settings';
    if (site) {
      navigate(`${baseUrl}#section=privacy-security&subsection=site-permissions&site=${encodeURIComponent(site)}`);
    } else {
      navigate(`${baseUrl}#section=privacy-security&subsection=site-permissions`);
    }
  };

  useEffect(() => {
    if (!isSettingsTab) return;
    if (isSyncingFromUrlRef.current) {
      isSyncingFromUrlRef.current = false;
      return;
    }
    
    const hash = activeTabUrl.includes('#') ? activeTabUrl.slice(activeTabUrl.indexOf('#')) : '';
    const params = parseHashParams(hash);
    const currentSection = params.section ?? '';
    
    // Don't navigate if section already matches
    if (currentSection === activeSection) return;
    
    const baseUrl = activeTabUrl ? activeTabUrl.split('#')[0] : 'mira://Settings';
    
    // Build URL - only sync section, don't add/remove site param
    const nextUrl = `${baseUrl}#section=${activeSection}`;
    
    if (activeTabUrl && activeTabUrl !== nextUrl && !activeTabUrl.includes('site=')) {
      isSyncingFromUrlRef.current = true;
      navigate(nextUrl);
    }
  }, [activeSection, activeTabUrl, isSettingsTab, navigate]);

  const openPrivacySubsection = (subsection: PrivacySecuritySubsection | null) => {
    const baseUrl = activeTabUrl.split('#')[0] || 'mira://Settings';
    setPrivacySecuritySubsection(subsection);
    setSelectedSiteOrigin(null);
    navigate(`${baseUrl}#section=privacy-security${subsection ? `&subsection=${subsection}` : ''}`);
  };
  const normalizedSelectedSite = selectedSiteOrigin?.replace(/^https?:\/\//, '');
  const selectedPermissionSite = sitePermissions.find((site) => site.origin.replace(/^https?:\/\//, '') === normalizedSelectedSite);
  const filteredPermissionSites = sitePermissions.filter((site) => `${site.siteLabel} ${site.origin}`.toLowerCase().includes(permissionsFilter.trim().toLowerCase()));
  const filteredCookieSites = cookiesData.filter((site) => `${site.siteLabel} ${site.origin}`.toLowerCase().includes(cookiesFilter.trim().toLowerCase()));

  return (
    <div
      className={`settings-page settings-redesign ${
        animationsEnabled ? 'settings-page-animations-enabled' : 'settings-page-animations-disabled'
      }`}
    >
      <header className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <span className="theme-text2 settings-save-indicator" role="status">
          {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : ''}
        </span>
      </header>

      <div className="settings-body">
        <div className="settings-sidebar">
          <div className="settings-tabs" role="tablist" aria-label="Settings sections">
            {settingsSectionTabs.map((section) => {
              const Icon = SETTINGS_SECTION_ICONS[section.id];
              return (
              <button
                key={section.id}
                id={`settings-tab-${section.id}`}
                type="button"
                role="tab"
                aria-selected={activeSection === section.id}
                aria-controls={`settings-panel-${section.id}`}
                onClick={() => {
                  setActiveSection(section.id);
                  setThemeDropdownOpen(false);
                  setLayoutDropdownOpen(false);
                }}
                className={`theme-btn theme-btn-nav settings-tab-btn ${
                  activeSection === section.id ? 'settings-tab-btn-active' : ''
                }`}
              >
                <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
                <span className="settings-tab-label">{section.label}</span>
              </button>
              );
            })}
          </div>

          <div className="settings-actions" role="group" aria-label="Settings actions">
            <a
              href="https://github.com/FatalMistake02/mira/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="theme-btn theme-btn-nav settings-tab-btn settings-action-btn"
            >
              <span className="settings-tab-label">Report Issue</span>
            </a>
          </div>
        </div>

        <div
          key={activeSection}
          id={`settings-panel-${activeSection}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeSection}`}
          className={`settings-section ${animationsEnabled ? 'settings-section-animated' : ''}`}
        >
          <h2 className="settings-section-heading">{settingsSectionTabs.find((section) => section.id === activeSection)?.label}</h2>
          {activeSection === 'general' && (
            <>
              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">New Tab</h3>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="new-tab-page" className="settings-setting-meta">
                    <span className="settings-setting-label">New Tab URL</span>
                  </label>
                  <div className="theme-input settings-input-with-action settings-setting-control settings-setting-control-grow settings-setting-control-right">
                    <input
                      id="new-tab-page"
                      type="text"
                      value={newTabPage}
                      onChange={(e) => {
                        setNewTabPage(e.target.value);
                        setSaveStatus('saving');
                      }}
                      placeholder={DEFAULT_BROWSER_SETTINGS.newTabPage}
                      className="settings-input-with-action-input"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setNewTabPage(DEFAULT_BROWSER_SETTINGS.newTabPage);
                        setSaveStatus('saving');
                      }}
                      className="theme-btn theme-btn-nav settings-btn-pad settings-input-with-action-button"
                      disabled={isBuiltInNewTabPage}
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <SettingsVisibility visible={isBuiltInNewTabPage} animated={animationsEnabled}>
                  <>
                    <label htmlFor="show-new-tab-branding" className="settings-setting-row">
                      <span className="settings-setting-meta">
                        <span className="settings-setting-label">Show New Tab branding</span>
                        <span className="settings-setting-description">
                          Display Mira logo and welcome message on new tabs.
                        </span>
                      </span>
                      <input
                        id="show-new-tab-branding"
                        type="checkbox"
                        className="settings-toggle settings-setting-control"
                        checked={showNewTabBranding}
                        onChange={(e) => {
                          setShowNewTabBranding(e.currentTarget.checked);
                          setSaveStatus('saving');
                        }}
                      />
                    </label>
                    <label htmlFor="disable-new-tab-intro" className="settings-setting-row">
                      <span className="settings-setting-meta">
                        <span className="settings-setting-label">Disable intro animation</span>
                        <span className="settings-setting-description">
                          Skip the new-tab intro animation at all times.
                        </span>
                      </span>
                      <input
                        id="disable-new-tab-intro"
                        type="checkbox"
                        className="settings-toggle settings-setting-control"
                        checked={disableNewTabIntro}
                        onChange={(e) => {
                          setDisableNewTabIntro(e.currentTarget.checked);
                          setSaveStatus('saving');
                        }}
                      />
                    </label>
                  </>
                </SettingsVisibility>
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Tab Sleep</h3>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="tab-sleep-value" className="settings-setting-meta">
                    <span className="settings-setting-label">Sleep timeout</span>
                  </label>
                  <div className="settings-inline-controls settings-setting-control settings-setting-control-grow settings-setting-control-right">
                    <input
                      id="tab-sleep-value"
                      type="number"
                      min={1}
                      step={1}
                      value={tabSleepValue}
                      onChange={(e) => {
                        const nextValue = e.currentTarget.valueAsNumber;
                        if (!Number.isFinite(nextValue)) return;
                        setTabSleepValue(Math.max(1, Math.floor(nextValue)));
                        setSaveStatus('saving');
                      }}
                      className="theme-input settings-number-input"
                    />
                    <select
                      id="tab-sleep-unit"
                      value={tabSleepUnit}
                      onChange={(e) => {
                        const nextUnit = e.currentTarget.value;
                        if (
                          nextUnit === 'seconds' ||
                          nextUnit === 'minutes' ||
                          nextUnit === 'hours'
                        ) {
                          setTabSleepUnit(nextUnit);
                        }
                        setSaveStatus('saving');
                      }}
                      className="theme-input settings-select-input"
                    >
                      <option value="seconds">Seconds</option>
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                    </select>
                  </div>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="tab-sleep-mode" className="settings-setting-meta">
                    <span className="settings-setting-label">Sleep behavior</span>
                  </label>
                  <select
                    id="tab-sleep-mode"
                    value={tabSleepMode}
                    onChange={(e) => {
                      const nextMode = e.currentTarget.value;
                      if (nextMode === 'freeze' || nextMode === 'discard') {
                        setTabSleepMode(nextMode as TabSleepMode);
                      }
                      setSaveStatus('saving');
                    }}
                    className="theme-input settings-select-input settings-select-limit settings-setting-control"
                  >
                    <option value="freeze">Freeze (keep page state)</option>
                    <option value="discard">Discard (save more memory)</option>
                  </select>
                </div>
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Browsing</h3>
                </div>
                <label htmlFor="ad-block-enabled" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Enable ad blocking</span>
                    <span className="settings-setting-description">
                      Block known ad and marketing hosts while browsing.
                    </span>
                  </span>
                  <input
                    id="ad-block-enabled"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={adBlockEnabled}
                    onChange={(e) => {
                      setAdBlockEnabled(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </label>

                <label htmlFor="tracker-block-enabled" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Enable tracker blocking</span>
                    <span className="settings-setting-description">
                      Blocks many analytics trackers, but may also block resources some sites need.
                    </span>
                  </span>
                  <input
                    id="tracker-block-enabled"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={trackerBlockEnabled}
                    onChange={(e) => {
                      setTrackerBlockEnabled(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </label>
              </SettingsGroup>
            </>
          )}

          {activeSection === 'search' && (
            <>
              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Search Engine</h3>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="search-engine" className="settings-setting-meta">
                    <span className="settings-setting-label">Default search engine</span>
                    <span className="settings-setting-description">
                      Used when you type non-URL text in the address bar or New Tab search.
                    </span>
                  </label>
                  <select
                    id="search-engine"
                    value={searchEngine}
                    onChange={(e) => {
                      const nextEngine = e.currentTarget.value;
                      if (SEARCH_ENGINE_OPTIONS.some((option) => option.value === nextEngine)) {
                        setSearchEngine(nextEngine as SearchEngine);
                        setSaveStatus('saving');
                      }
                    }}
                    className="theme-input settings-select-input settings-select-limit settings-setting-control"
                  >
                    {SEARCH_ENGINE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </SettingsGroup>
              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Engine shortcuts</h3>
                </div>
                <label htmlFor="search-engine-shortcuts-enabled" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Enable engine shortcuts</span>
                    <span className="settings-setting-description">
                      Allow prefixes like <code>{shortcutExample}</code> and{' '}
                      <code>{secondShortcutExample}</code> to override the selected engine for a
                      single search.
                    </span>
                  </span>
                  <input
                    id="search-engine-shortcuts-enabled"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={searchEngineShortcutsEnabled}
                    onChange={(e) => {
                      setSearchEngineShortcutsEnabled(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </label>
                <SettingsVisibility
                  visible={searchEngineShortcutsEnabled}
                  animated={animationsEnabled}
                >
                  <>
                    <div className="settings-setting-row">
                      <label htmlFor="search-shortcut-prefix" className="settings-setting-meta">
                        <span className="settings-setting-label">Shortcut prefix character</span>
                        <span className="settings-setting-description">
                          Character used before each engine shortcut.
                        </span>
                      </label>
                      <input
                        id="search-shortcut-prefix"
                        type="text"
                        inputMode="text"
                        autoComplete="off"
                        value={searchEngineShortcutPrefix}
                        onChange={(e) => handleSearchShortcutPrefixChange(e.currentTarget.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        className="theme-input settings-number-input settings-setting-control"
                      />
                    </div>
                    <div className="settings-setting-row">
                      <div className="settings-setting-meta">
                        <span className="settings-setting-label">Engine shortcuts</span>
                        <span className="settings-setting-description">
                          Type the shortcut first, then your query (example:{' '}
                          <code>{shortcutExample} cats</code>).
                        </span>
                        <div className="settings-shortcuts-list">
                          {searchEngineShortcuts.map((entry) => (
                            <div key={entry.engine} className="settings-shortcuts-item">
                              <span className="settings-shortcuts-engine">{entry.label}</span>
                              <span className="settings-shortcuts-current">
                                Current: <code>{entry.shortcut}</code>
                              </span>
                              <input
                                id={`search-shortcut-char-${entry.engine}`}
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                value={searchEngineShortcutChars[entry.engine]}
                                onChange={(e) =>
                                  handleSearchShortcutCharChange(
                                    entry.engine,
                                    e.currentTarget.value,
                                  )
                                }
                                onFocus={(e) => e.currentTarget.select()}
                                className="theme-input settings-shortcuts-input"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                </SettingsVisibility>
              </SettingsGroup>
            </>
          )}

          {activeSection === 'appearance' && (
            <>
              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Theme</h3>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="theme-dropdown-button" className="settings-setting-meta">
                    <span className="settings-setting-label">Active theme</span>
                    <span className="settings-setting-description">
                      Choose which color theme is applied across the app.
                    </span>
                  </label>
                  <div
                    ref={themeDropdownRef}
                    className="settings-dropdown-wrap settings-setting-control settings-select-limit"
                  >
                    <button
                      id="theme-dropdown-button"
                      type="button"
                      onClick={() =>
                        setThemeDropdownOpen((open) => {
                          const nextOpen = !open;
                          if (nextOpen) setLayoutDropdownOpen(false);
                          return nextOpen;
                        })
                      }
                      className={`theme-btn theme-btn-nav settings-dropdown-trigger ${
                        themeDropdownOpen ? 'settings-dropdown-trigger-open' : ''
                      }`}
                    >
                      <span className="settings-dropdown-value">
                        {selectedTheme ? formatThemeLabel(selectedTheme) : 'No themes available'}
                      </span>
                      {themeDropdownOpen ? (
                        <ChevronUp
                          size={14}
                          className="settings-dropdown-caret-icon"
                          aria-hidden="true"
                        />
                      ) : (
                        <ChevronDown
                          size={14}
                          className="settings-dropdown-caret-icon"
                          aria-hidden="true"
                        />
                      )}
                    </button>

                    {themeDropdownOpen && (
                      <div className="theme-panel settings-dropdown-menu">
                        {themes.map((entry) => (
                          <div key={entry.id} className="settings-dropdown-item">
                            <button
                              type="button"
                              onClick={() => {
                                handleThemeChange(entry.id);
                                setThemeDropdownOpen(false);
                              }}
                              className={`theme-btn settings-dropdown-choice ${
                                entry.id === themeId
                                  ? 'theme-btn-go settings-dropdown-choice-selected'
                                  : 'theme-btn-nav'
                              }`}
                            >
                              <span className="settings-dropdown-choice-label">
                                {formatThemeLabel(entry)}
                              </span>
                              {entry.id === themeId && (
                                <Check
                                  size={14}
                                  className="settings-dropdown-choice-check"
                                  aria-hidden="true"
                                />
                              )}
                            </button>

                            {entry.source === 'custom' && (
                              <button
                                type="button"
                                onClick={() => handleDeleteTheme(entry.id)}
                                className="theme-btn theme-btn-nav settings-btn-pad"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="settings-actions-row">
                  <button
                    onClick={() => themeFileInputRef.current?.click()}
                    type="button"
                    className="theme-btn theme-btn-nav settings-btn-pad"
                  >
                    Add Theme
                  </button>
                  <button
                    type="button"
                    onClick={() => window.open('https://mirabrowser.fatalmistake02.com/themes', '_blank')}
                    className="theme-btn theme-btn-nav settings-btn-pad"
                  >
                    Get More Themes
                  </button>
                  <input
                    ref={themeFileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleImportTheme}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    onClick={() => navigate('mira://ThemeCreator')}
                    className="theme-btn theme-btn-nav settings-btn-pad"
                  >
                    Open Theme Creator
                  </button>
                </div>
                <label htmlFor="raw-file-dark-mode-enabled" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Dark mode raw files</span>
                    <span className="settings-setting-description">
                      Show plain-text/raw files as white text on a black background when a dark
                      theme is active.
                    </span>
                  </span>
                  <input
                    id="raw-file-dark-mode-enabled"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={rawFileDarkModeEnabled}
                    onChange={(e) => {
                      setRawFileDarkModeEnabled(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </label>
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Animations</h3>
                </div>
                <label htmlFor="animations-enabled" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Animations</span>
                    <span className="settings-setting-description">Enable animations.</span>
                  </span>
                  <input
                    id="animations-enabled"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={animationsEnabled}
                    onChange={(e) => {
                      setAnimationsEnabled(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </label>
              </SettingsGroup>

              {!!importMessage && (
                <div className="theme-text2 settings-inline-message">{importMessage}</div>
              )}
            </>
          )}

          {activeSection === 'layout' && (
            <>
              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Layout profile</h3>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="layout-dropdown-button" className="settings-setting-meta">
                    <span className="settings-setting-label">Active layout</span>
                    <span className="settings-setting-description">
                      Choose which layout profile is used by the browser UI.
                    </span>
                  </label>
                  <div
                    ref={layoutDropdownRef}
                    className="settings-dropdown-wrap settings-setting-control settings-select-limit"
                  >
                    <button
                      id="layout-dropdown-button"
                      type="button"
                      onClick={() =>
                        setLayoutDropdownOpen((open) => {
                          const nextOpen = !open;
                          if (nextOpen) setThemeDropdownOpen(false);
                          return nextOpen;
                        })
                      }
                      className={`theme-btn theme-btn-nav settings-dropdown-trigger ${
                        layoutDropdownOpen ? 'settings-dropdown-trigger-open' : ''
                      }`}
                    >
                      <span className="settings-dropdown-value">
                        {selectedLayout
                          ? formatLayoutLabel(selectedLayout)
                          : 'No layouts available'}
                      </span>
                      {layoutDropdownOpen ? (
                        <ChevronUp
                          size={14}
                          className="settings-dropdown-caret-icon"
                          aria-hidden="true"
                        />
                      ) : (
                        <ChevronDown
                          size={14}
                          className="settings-dropdown-caret-icon"
                          aria-hidden="true"
                        />
                      )}
                    </button>

                    {layoutDropdownOpen && (
                      <div className="theme-panel settings-dropdown-menu">
                        {layouts.map((entry) => (
                          <div key={entry.id} className="settings-dropdown-item">
                            <button
                              type="button"
                              onClick={() => {
                                handleLayoutChange(entry.id);
                                setLayoutDropdownOpen(false);
                              }}
                              className={`theme-btn settings-dropdown-choice ${
                                entry.id === layoutId
                                  ? 'theme-btn-go settings-dropdown-choice-selected'
                                  : 'theme-btn-nav'
                              }`}
                            >
                              <span className="settings-dropdown-choice-label">
                                {formatLayoutLabel(entry)}
                              </span>
                              {entry.id === layoutId && (
                                <Check
                                  size={14}
                                  className="settings-dropdown-choice-check"
                                  aria-hidden="true"
                                />
                              )}
                            </button>

                            {entry.source === 'custom' && (
                              <button
                                type="button"
                                onClick={() => handleDeleteLayout(entry.id)}
                                className="theme-btn theme-btn-nav settings-btn-pad"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="settings-actions-row">
                  <button
                    onClick={() => layoutFileInputRef.current?.click()}
                    type="button"
                    className="theme-btn theme-btn-nav settings-btn-pad"
                  >
                    Add Layout
                  </button>
                  <input
                    ref={layoutFileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleImportLayout}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    onClick={() => navigate('mira://LayoutCreator')}
                    className="theme-btn theme-btn-nav settings-btn-pad"
                  >
                    Open Layout Creator
                  </button>
                </div>
              </SettingsGroup>
              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Tabs and toolbar</h3>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="tab-strip-position" className="settings-setting-meta">
                    <span className="settings-setting-label">Tab strip position</span>
                  </label>
                  <select
                    id="tab-strip-position"
                    value={tabStripPosition}
                    onChange={(e) => {
                      const next = e.currentTarget.value as TabStripPosition;
                      if (next === 'top' || next === 'left' || next === 'right') {
                        setTabStripPosition(next);
                        setSaveStatus('saving');
                      }
                    }}
                    className="theme-input settings-select-input settings-select-limit settings-setting-control"
                  >
                    <option value="top">Top</option>
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                  </select>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="vertical-tabs-address-bar-in-topbar" className="settings-setting-meta">
                    <span className="settings-setting-label">URL bar in top bar with vertical tabs</span>
                    <span className="settings-setting-description">
                      Move the URL bar and navigation controls into the top bar when tabs are on the left or right.
                    </span>
                  </label>
                  <input
                    id="vertical-tabs-address-bar-in-topbar"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={verticalTabsAddressBarInTopBar}
                    onChange={(e) => {
                      setVerticalTabsAddressBarInTopBar(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="show-bookmark-button" className="settings-setting-meta">
                    <span className="settings-setting-label">Show bookmark button</span>
                  </label>
                  <input
                    id="show-bookmark-button"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={showBookmarkButton}
                    onChange={(e) => {
                      setShowBookmarkButton(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="show-bookmarks-bar" className="settings-setting-meta">
                    <span className="settings-setting-label">Show bookmarks bar</span>
                  </label>
                  <input
                    id="show-bookmarks-bar"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={showBookmarksBar}
                    onChange={(e) => {
                      setShowBookmarksBar(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </div>
              </SettingsGroup>

              {!!importMessage && (
                <div className="theme-text2 settings-inline-message">{importMessage}</div>
              )}
            </>
          )}

          {activeSection === 'privacy-security' && (
            <div className="privacy-content">
              {!privacySecuritySubsection && (
                <SettingsGroup>
                  <div className="settings-card-header"><h3 className="settings-card-title">Sites</h3></div>
                  <div className="privacy-navigation">
                    <button type="button" className="privacy-navigation-row" onClick={() => openPrivacySubsection('site-permissions')}>
                      <Shield size={20} aria-hidden="true" />
                      <span><strong>Site permissions</strong><small>Control what websites can access.</small></span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                    <button type="button" className="privacy-navigation-row" onClick={() => openPrivacySubsection('cookies')}>
                      <Cookie size={20} aria-hidden="true" />
                      <span><strong>Cookies and site data</strong><small>Manage data stored by websites.</small></span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  </div>
                </SettingsGroup>
              )}

              {privacySecuritySubsection === 'cookies' && (
                <>
                  <button type="button" className="privacy-back" onClick={() => openPrivacySubsection(null)}><ChevronLeft size={16} aria-hidden="true" />Back</button>
                  <SettingsGroup>
                    <div className="settings-card-header"><h3 className="settings-card-title">Cookies</h3></div>
                    <label htmlFor="cookies-enabled" className="settings-setting-row">
                      <span className="settings-setting-meta"><span className="settings-setting-label">Allow cookies</span><span className="settings-setting-description">Let sites store cookies and site data.</span></span>
                      <input id="cookies-enabled" type="checkbox" className="settings-toggle settings-setting-control" checked={cookiesEnabled} onChange={(event) => { setCookiesEnabled(event.currentTarget.checked); setSaveStatus('saving'); }} />
                    </label>
                  </SettingsGroup>
                  <SettingsGroup>
                    <div className="settings-card-header privacy-group-heading">
                      <h3 className="settings-card-title">Stored cookies</h3>
                      <div className="privacy-toolbar">
                        <button type="button" className="theme-btn theme-btn-nav privacy-action" onClick={loadCookies} disabled={isLoadingCookies} title="Refresh site data" aria-label="Refresh site data"><RefreshCw size={15} /></button>
                        <button type="button" className="theme-btn theme-btn-nav privacy-action" onClick={() => { void deleteAllCookies(); }} disabled={isLoadingCookies || !cookiesData.length}>Clear all</button>
                      </div>
                    </div>
                    {(cookiesData.length > 0 || cookiesFilter) && <div className="privacy-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search stored site data" placeholder="Search sites" value={cookiesFilter} onChange={(event) => setCookiesFilter(event.target.value)} /></div>}
                    {isLoadingCookies && <p className="privacy-empty" role="status">Loading site data…</p>}
                    {!isLoadingCookies && filteredCookieSites.length === 0 && !cookiesStatus && <p className="privacy-empty">{cookiesFilter ? 'No matching sites.' : 'No stored cookies.'}</p>}
                    <div className="privacy-site-list">
                      {filteredCookieSites.map((site) => (
                        <div className="privacy-site-row" key={site.origin}>
                          <Cookie size={18} className="privacy-site-icon" aria-hidden="true" />
                          <span className="privacy-site-name">{site.siteLabel}</span>
                          <span className="privacy-site-count">{site.cookieCount} cookie{site.cookieCount === 1 ? '' : 's'}</span>
                          <button type="button" className="theme-btn theme-btn-nav privacy-action" aria-label={`Delete cookies for ${site.siteLabel}`} title={`Delete cookies for ${site.siteLabel}`} onClick={() => { void deleteSiteCookies(site.origin); }}><Trash2 size={15} /></button>
                        </div>
                      ))}
                    </div>
                    {cookiesStatus && <p className="privacy-notice" role="status">{cookiesStatus}</p>}
                  </SettingsGroup>
                </>
              )}

              {privacySecuritySubsection === 'site-permissions' && (
                <>
                  <button type="button" className="privacy-back" onClick={() => selectedSiteOrigin ? navigateToSitePermission(null) : openPrivacySubsection(null)}><ChevronLeft size={16} aria-hidden="true" />{selectedSiteOrigin ? 'All sites' : 'Back'}</button>
                  {selectedSiteOrigin ? (
                    <SettingsGroup>
                      <div className="settings-card-header privacy-group-heading">
                        <div className="privacy-site-heading"><Globe size={18} aria-hidden="true" /><h3 className="settings-card-title">{selectedPermissionSite?.siteLabel ?? normalizedSelectedSite}</h3></div>
                        <button type="button" className="theme-btn theme-btn-nav privacy-action" disabled={!selectedPermissionSite || isLoadingSitePermissions} onClick={() => { if (selectedPermissionSite) void deleteSitePermission(selectedPermissionSite.origin); }}>Reset permissions</button>
                      </div>
                      {isLoadingSitePermissions ? <p className="privacy-empty" role="status">Loading permissions…</p> : !selectedPermissionSite ? <p className="privacy-empty">No saved permissions for this site.</p> : (
                        <div className="privacy-permission-list">
                          {ALL_SITE_PERMISSIONS.map((permission) => {
                            const value = selectedPermissionSite.permissions.find((item) => item.id === permission.id)?.decision ?? 'ask';
                            return <div className="privacy-permission-row" key={permission.id}>
                              <span className="settings-setting-label">{permission.label}</span>
                              <div className="privacy-decision-group" role="group" aria-label={`${permission.label} permission`}>
                                {(['allow', 'ask', 'block'] as const).map((decision) => <button key={decision} type="button" className="privacy-decision" aria-pressed={value === decision} onClick={() => { void updateSitePermission(selectedPermissionSite.origin, permission.id, decision); }}>{decision === 'allow' ? 'Allow' : decision === 'block' ? 'Block' : 'Ask'}</button>)}
                              </div>
                            </div>;
                          })}
                        </div>
                      )}
                      {sitePermissionStatus && <p className="privacy-notice" role="status">{sitePermissionStatus}</p>}
                    </SettingsGroup>
                  ) : (
                    <SettingsGroup>
                      <div className="settings-card-header privacy-group-heading">
                        <h3 className="settings-card-title">Site permissions</h3>
                        <div className="privacy-toolbar">
                          <button type="button" className="theme-btn theme-btn-nav privacy-action" onClick={loadSitePermissions} disabled={isLoadingSitePermissions} title="Refresh site permissions" aria-label="Refresh site permissions"><RefreshCw size={15} /></button>
                          <button type="button" className="theme-btn theme-btn-nav privacy-action" onClick={() => { void deleteAllSitePermissions(); }} disabled={!sitePermissions.length || isLoadingSitePermissions}>Reset all</button>
                        </div>
                      </div>
                      {(sitePermissions.length > 0 || permissionsFilter) && <div className="privacy-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search site permissions" placeholder="Search sites" value={permissionsFilter} onChange={(event) => setPermissionsFilter(event.target.value)} /></div>}
                      {isLoadingSitePermissions && <p className="privacy-empty" role="status">Loading permissions…</p>}
                      {!isLoadingSitePermissions && !filteredPermissionSites.length && !sitePermissionStatus && <p className="privacy-empty">{permissionsFilter ? 'No matching sites.' : 'No saved site permissions.'}</p>}
                      <div className="privacy-site-list">
                        {filteredPermissionSites.map((site) => <button type="button" key={site.origin} className="privacy-site-row privacy-site-link" onClick={() => navigateToSitePermission(site.origin.replace(/^https?:\/\//, ''))}>
                          <Globe size={18} className="privacy-site-icon" aria-hidden="true" />
                          <span className="privacy-site-name">{site.siteLabel}</span>
                          <span className="privacy-site-count">{site.permissions.length} saved</span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>)}
                      </div>
                      {sitePermissionStatus && <p className="privacy-notice" role="status">{sitePermissionStatus}</p>}
                    </SettingsGroup>
                  )}
                </>
              )}
            </div>
          )}

          {activeSection === 'app' && (
            <>
              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Dev Tools</h3>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="devtools-open-mode" className="settings-setting-meta">
                    <span className="settings-setting-label">Developer Tools mode</span>
                    <span className="settings-setting-description">
                      Open DevTools docked to the side or in a separate window.
                    </span>
                  </label>
                  <select
                    id="devtools-open-mode"
                    value={devToolsOpenMode}
                    onChange={(e) => {
                      const nextMode = e.currentTarget.value;
                      if (nextMode === 'side' || nextMode === 'window') {
                        setDevToolsOpenMode(nextMode as DevToolsOpenMode);
                      }
                      setSaveStatus('saving');
                    }}
                    className="theme-input settings-select-input settings-select-limit settings-setting-control"
                  >
                    <option value="side">Docked to side</option>
                    <option value="window">Separate window</option>
                  </select>
                </div>
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Context Menu</h3>
                </div>
                <label htmlFor="native-text-field-context-menu" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Use native context menus</span>
                    <span className="settings-setting-description">
                      Show your OS context menu. Turn off to use Mira&apos;s custom menus. (not
                      recomended)
                    </span>
                  </span>
                  <input
                    id="native-text-field-context-menu"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={nativeTextFieldContextMenu}
                    onChange={(e) => {
                      setNativeTextFieldContextMenu(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </label>
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Startup</h3>
                </div>
                <div className="settings-setting-row">
                  <label htmlFor="startup-restore-behavior" className="settings-setting-meta">
                    <span className="settings-setting-label">Restore behavior</span>
                    <span className="settings-setting-description">
                      Choose how Mira handles your previous session on startup.
                    </span>
                  </label>
                  <select
                    id="startup-restore-behavior"
                    value={startupRestoreBehavior}
                    onChange={(e) => {
                      const nextMode = e.currentTarget.value;
                      if (
                        nextMode === 'ask' ||
                        nextMode === 'windows' ||
                        nextMode === 'tabs' ||
                        nextMode === 'fresh'
                      ) {
                        setStartupRestoreBehavior(nextMode as StartupRestoreBehavior);
                        setSaveStatus('saving');
                      }
                    }}
                    className="theme-input settings-select-input settings-select-limit settings-setting-control"
                  >
                    <option value="ask">Always Ask</option>
                    <option value="windows">Auto Restore All Windows</option>
                    <option value="tabs">Auto Restore Tabs</option>
                    <option value="fresh">Auto Start Fresh</option>
                  </select>
                </div>
                {canConfigureRunOnStartupSetting && (
                  <>
                    <label htmlFor="run-on-startup" className="settings-setting-row">
                      <span className="settings-setting-meta">
                        <span className="settings-setting-label">Run on startup</span>
                        <span className="settings-setting-description">
                          Launch Mira automatically when you sign in to your computer.
                        </span>
                      </span>
                      <input
                        id="run-on-startup"
                        type="checkbox"
                        className="settings-toggle settings-setting-control"
                        checked={runOnStartup}
                        disabled={!canConfigureRunOnStartup}
                        onChange={(e) => {
                          setRunOnStartup(e.currentTarget.checked);
                          setSaveStatus('saving');
                        }}
                      />
                    </label>
                    {!!runOnStartupStatus && (
                      <div className="theme-text2 settings-status">{runOnStartupStatus}</div>
                    )}
                  </>
                )}
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Default Browser</h3>
                </div>
                <div className="settings-setting-row">
                  <div className="settings-setting-meta">
                    <span className="settings-setting-label">System default app for links</span>
                    <span className="settings-setting-description">
                      Register Mira to open <code>http</code> and <code>https</code> links by
                      default.
                    </span>
                  </div>
                  <div className="settings-actions-row settings-setting-control settings-setting-control-grow settings-setting-control-right">
                    <button
                      type="button"
                      onClick={refreshDefaultBrowserStatus}
                      className="theme-btn theme-btn-nav settings-btn-pad"
                      disabled={isCheckingDefaultBrowser}
                    >
                      {isCheckingDefaultBrowser ? 'Checking...' : 'Refresh Status'}
                    </button>
                    <button
                      type="button"
                      onClick={setAsDefaultBrowser}
                      className="theme-btn theme-btn-go settings-btn-pad"
                      disabled={
                        isSettingDefaultBrowser ||
                        (!isWindowsPlatform && isDefaultBrowser === true) ||
                        !canAttemptDefaultBrowserRegistration
                      }
                    >
                      {isSettingDefaultBrowser
                        ? 'Setting...'
                        : !canAttemptDefaultBrowserRegistration
                          ? 'Unavailable'
                          : isDefaultBrowser
                            ? 'Already Default'
                            : 'Make Default'}
                    </button>
                  </div>
                </div>
                {!!defaultBrowserStatus && (
                  <div className="theme-text2 settings-status">{defaultBrowserStatus}</div>
                )}
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Updates</h3>
                </div>
                <label htmlFor="include-prerelease-updates" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Include pre-release updates</span>
                    <span className="settings-setting-description">
                      Also check beta/preview builds when searching for updates.
                    </span>
                  </span>
                  <input
                    id="include-prerelease-updates"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={includePrereleaseUpdates}
                    onChange={(e) => {
                      setIncludePrereleaseUpdates(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </label>
                <label htmlFor="auto-update-mode" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Automatic Updates</span>
                  </span>
                  <select
                    id="auto-update-mode"
                    value={autoUpdateMode}
                    onChange={(e) => {
                      const nextMode = e.currentTarget.value as AutoUpdateMode;
                      if (
                        nextMode === 'off'
                        || nextMode === 'ask-on-launch'
                        || nextMode === 'ask-on-close'
                        || nextMode === 'auto-on-launch'
                        || nextMode === 'auto-on-close'
                      ) {
                        setAutoUpdateMode(nextMode);
                        setSaveStatus('saving');
                      }
                    }}
                    className="theme-input settings-select-input settings-select-limit settings-setting-control"
                  >
                    <option value="off">Off (only manual checks)</option>
                    <option value="ask-on-launch">Ask when Mira starts</option>
                    <option value="ask-on-close">Ask when Mira closes</option>
                    <option value="auto-on-launch" disabled={!canAutoInstallOnLaunch}>
                      Auto update on launch
                    </option>
                    <option value="auto-on-close" disabled={!canAutoInstallOnLaunch}>
                      Auto update on close
                    </option>
                  </select>
                </label>
                <div className="settings-setting-row">
                  <div className="settings-setting-meta">
                    <span className="settings-setting-label">Check for Updates</span>
                  </div>
                  <div className="settings-actions-row settings-setting-control settings-setting-control-grow settings-setting-control-right">
                    <button
                      type="button"
                      onClick={checkForUpdates}
                      className="theme-btn theme-btn-nav settings-btn-pad"
                      disabled={isCheckingUpdates}
                    >
                      {isCheckingUpdates ? 'Checking...' : 'Check for Updates'}
                    </button>
                    {updateCheckResult?.hasUpdate && (
                      <button
                        type="button"
                        onClick={runUpdateAction}
                        className="theme-btn theme-btn-go settings-btn-pad"
                        disabled={isRunningUpdateAction}
                      >
                        {isRunningUpdateAction
                          ? 'Working...'
                          : updateCheckResult.mode === 'portable'
                            ? 'Download'
                            : 'Download and Install'}
                      </button>
                    )}
                  </div>
                </div>
                {!!updateStatus && (
                  <div className="theme-text2 settings-status">{updateStatus}</div>
                )}
              </SettingsGroup>
            </>
          )}

          {isDevSettingsEnabled && activeSection === 'dev' && (
            <>
              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Diagnostics</h3>
                </div>
                <label htmlFor="show-perf-overlay" className="settings-setting-row">
                  <span className="settings-setting-meta">
                    <span className="settings-setting-label">Performance overlay (WIP)</span>
                    <span className="settings-setting-description">
                      Show a performance overlay. May be inaccurate.
                    </span>
                  </span>
                  <input
                    id="show-perf-overlay"
                    type="checkbox"
                    className="settings-toggle settings-setting-control"
                    checked={showPerfOverlay}
                    onChange={(e) => {
                      setShowPerfOverlay(e.currentTarget.checked);
                      setSaveStatus('saving');
                    }}
                  />
                </label>
                <div className="settings-setting-row">
                  <div className="settings-setting-meta">
                    <span className="settings-setting-label">Open App Console</span>
                    <span className="settings-setting-description">
                      Open the browser's developer console for debugging and inspection.
                    </span>
                  </div>
                  <div className="settings-actions-row settings-setting-control settings-setting-control-grow settings-setting-control-right">
                    <button
                      type="button"
                      onClick={() => {
                        // Open main browser developer tools
                        if (electron?.ipcRenderer) {
                          electron.ipcRenderer.invoke('window-toggle-devtools').catch(() => {
                            console.log('Failed to open main window dev tools. Use Ctrl+Alt+Shift+J');
                          });
                        }
                      }}
                      className="theme-btn theme-btn-nav settings-btn-pad"
                    >
                      Open Main Console
                    </button>
                  </div>
                </div>
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">App Data</h3>
                </div>
                <div className="settings-setting-row">
                  <div className="settings-setting-meta">
                    <span className="settings-setting-label">Reset app data</span>
                    <span className="settings-setting-description">
                      Clear history, session, downloads list, and settings in one action.
                    </span>
                  </div>
                  <div className="settings-actions-row settings-setting-control settings-setting-control-grow settings-setting-control-right">
                    <button
                      type="button"
                      onClick={resetAppData}
                      className="theme-btn theme-btn-nav settings-btn-pad"
                      disabled={isResettingAppData}
                    >
                      {isResettingAppData ? 'Resetting...' : 'Reset App Data'}
                    </button>
                  </div>
                </div>
                {!!appDataResetStatus && (
                  <div className="theme-text2 settings-status">{appDataResetStatus}</div>
                )}
              </SettingsGroup>

              <SettingsGroup>
                <div className="settings-card-header">
                  <h3 className="settings-card-title">Onboarding</h3>
                </div>
                <div className="settings-setting-row">
                  <div className="settings-setting-meta">
                    <span className="settings-setting-label">Show onboarding again</span>
                    <span className="settings-setting-description">
                      Reset first-run onboarding so it appears the next time you open Mira.
                    </span>
                  </div>
                  <div className="settings-actions-row settings-setting-control settings-setting-control-grow settings-setting-control-right">
                    <button
                      type="button"
                      onClick={resetOnboarding}
                      className="theme-btn theme-btn-nav settings-btn-pad"
                      disabled={isResettingOnboarding}
                    >
                      {isResettingOnboarding ? 'Resetting...' : 'Reset Onboarding'}
                    </button>
                  </div>
                </div>
                {!!onboardingResetStatus && (
                  <div className="theme-text2 settings-status">{onboardingResetStatus}</div>
                )}
              </SettingsGroup>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
