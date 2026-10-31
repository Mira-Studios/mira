import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  screen,
  shell,
  session,
  webContents as electronWebContents,
} from 'electron';
import { execFileSync, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type {
  DownloadItem,
  MenuItemConstructorOptions,
  MessageBoxSyncOptions,
  WebContents,
} from 'electron';
import { appendFileSync, promises as fs, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import os from 'node:os';
import { isExplicitPopupRequest } from './popupPolicy.ts';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Isolate development before sessions or the single-instance lock use these paths.
const isDevelopment = !app.isPackaged;
if (isDevelopment) {
  const developmentDataPath = path.join(app.getPath('appData'), 'Mira Dev');
  app.setName('Mira Dev');
  app.setPath('userData', developmentDataPath);
  app.setPath('sessionData', developmentDataPath);
}

// Store active downloads by ID
const downloadMap = new Map<string, DownloadItem>();
const downloadWindowById = new Map<string, number>();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const isMacOS = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const ENABLE_APP_DEBUG_LOGS = true; // Set to false for shipping builds.
const incomingBrowserUrlQueue: string[] = [];
const APP_STATE_FILE = 'app-state.json';
const SITE_PERMISSIONS_FILE = 'site-permissions.json';

interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
}

interface TabSessionSnapshot {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  history: string[];
  historyIndex: number;
  reloadToken: number;
  isSleeping: boolean;
  lastActiveAt: number;
}

interface WindowSessionSnapshot {
  tabs: TabSessionSnapshot[];
  activeId: string;
  savedAt: number;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isMaximized?: boolean;
  isFullScreen?: boolean;
}

interface PersistedSessionSnapshot {
  windows: WindowSessionSnapshot[];
  savedAt: number;
}

interface DetachedTabTransferPayload {
  transferId: string;
  sourceWindowId: number;
  targetWindowId: number;
  tab: TabSessionSnapshot;
  guestInstance?: string;
  webContentsId?: number;
  attached?: boolean;
  deferSourceFinalize?: boolean;
  releaseRequested?: boolean;
}

interface DetachedWindowDragSession {
  transferId: string;
  sourceWindowId: number;
  targetWindowId: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  timer: NodeJS.Timeout;
}

interface PersistedAppState {
  onboardingCompleted?: boolean;
}

type SitePermissionSetting = 'allow' | 'ask' | 'block';

type SitePermissionId =
  | 'camera'
  | 'microphone'
  | 'location'
  | 'notifications'
  | 'fullscreen'
  | 'clipboard'
  | 'pointer-lock'
  | 'screen-capture'
  | 'midi'
  | 'storage-access'
  | 'window-management'
  | 'idle-detection'
  | 'speaker-selection'
  | 'keyboard-lock'
  | 'external-apps'
  | 'file-system'
  | 'unknown';

interface PersistedSitePermissions {
  origins?: Record<string, Partial<Record<SitePermissionId, SitePermissionSetting>>>;
}

interface PendingSitePermissionRequest {
  callback: (permissionGranted: boolean) => void;
  origin: string;
  permissionIds: SitePermissionId[];
  hostWindowId: number | null;
}

interface PendingWebviewCloseRequest {
  type: 'tab' | 'window';
  tabId?: string;
  hostWindowId: number | null;
}

type SessionRestoreMode = 'tabs' | 'windows';

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets?: GitHubReleaseAsset[];
}

interface UpdateCheckResult {
  mode: 'portable' | 'installer';
  currentVersion: string;
  latestVersion: string;
  latestIsPrerelease: boolean;
  hasUpdate: boolean;
  releaseName: string;
  assetName: string;
  downloadUrl: string;
}

type KnownWebmailProviderId = 'gmail' | 'outlook' | 'proton';

interface MailtoNavigationTarget {
  kind: 'browser-tab' | 'internal-tab' | 'external-os';
  url: string;
  title: string;
}

let historyCache: HistoryEntry[] = [];
const OPEN_TAB_DEDUPE_WINDOW_MS = 500;
const recentOpenTabByHost = new Map<number, { url: string; openedAt: number }>();
const NEW_WINDOW_SHORTCUT_DEDUPE_MS = 250;
const recentNewWindowShortcutByWindow = new Map<number, number>();
const RENDERER_RECOVERY_COOLDOWN_MS = 3000;
const recentRendererRecoveryByWindow = new Map<number, number>();
const pendingInitialUrlByWindowId = new Map<number, string>();
const pendingDetachedTabTransferByWindowId = new Map<number, DetachedTabTransferPayload>();
const detachedTabTransferById = new Map<string, DetachedTabTransferPayload>();
const activeDetachedWindowDragBySourceWindowId = new Map<number, DetachedWindowDragSession>();
const SHORTCUT_DEVTOOLS_SUPPRESS_MS = 500;
const activeWebContentsByWindow = new Map<number, WebContents>();
const suppressHostDevToolsUntilByWindowId = new Map<number, number>();
const pendingSitePermissionRequests = new Map<string, PendingSitePermissionRequest>();
const pendingWebviewCloseRequestsByWebContentsId = new Map<number, PendingWebviewCloseRequest>();
const windowSessionCache = new Map<number, WindowSessionSnapshot>();
const bootRestoreByWindowId = new Map<number, WindowSessionSnapshot>();
let pendingRestoreSession: PersistedSessionSnapshot | null = null;
let sessionPersistTimer: NodeJS.Timeout | null = null;
const pendingClosedWindowCleanupTimers = new Map<number, NodeJS.Timeout>();
const onboardingWindowIds = new Set<number>();
let isQuitting = false;
let adBlockEnabled = true;
let trackerBlockEnabled = false;
let quitOnLastWindowClose = false;
let hasAttemptedLaunchAutoUpdate = false;
let hasAttemptedCloseAutoUpdate = false;
let persistedSitePermissions: Record<string, Partial<Record<SitePermissionId, SitePermissionSetting>>> = {};

const SITE_SETTINGS_PERMISSION_ORDER: SitePermissionId[] = [
  'camera',
  'microphone',
  'location',
  'notifications',
  'fullscreen',
  'clipboard',
  'pointer-lock',
  'screen-capture',
  'midi',
  'storage-access',
  'window-management',
  'idle-detection',
  'speaker-selection',
  'keyboard-lock',
  'external-apps',
  'file-system',
  'unknown',
];

const SITE_PERMISSION_LABELS: Record<SitePermissionId, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  location: 'Location',
  notifications: 'Notifications',
  fullscreen: 'Fullscreen',
  clipboard: 'Clipboard',
  'pointer-lock': 'Pointer lock',
  'screen-capture': 'Screen capture',
  midi: 'MIDI devices',
  'storage-access': 'Cross-site cookies and site data',
  'window-management': 'Window management',
  'idle-detection': 'Idle detection',
  'speaker-selection': 'Speaker selection',
  'keyboard-lock': 'Keyboard lock',
  'external-apps': 'External apps',
  'file-system': 'File system',
  unknown: 'Other permission',
};

type AutoUpdateMode =
  | 'off'
  | 'ask-on-launch'
  | 'ask-on-close'
  | 'auto-on-launch'
  | 'auto-on-close';

let configuredAutoUpdateMode: AutoUpdateMode = 'off';
let configuredAutoUpdateIncludePrerelease = false;
let onboardingCompleted = false;
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/FatalMistake02/mira/releases?per_page=40';
const isPortableBuild = process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
const AD_BLOCK_CACHE_FILE = 'adblock-hosts-v1.txt';
const AD_BLOCK_FETCH_TIMEOUT_MS = 15000;
const AD_BLOCK_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TRACKER_BLOCK_LOCAL_FILE = path.join('src', 'assets', 'trackers.txt');
const YOUTUBE_AD_CPN_TTL_MS = 30 * 60 * 1000;
const MAX_TRACKED_YOUTUBE_AD_CPNS = 512;

const DEFAULT_BLOCKED_AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adnxs.com',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'adsrvr.org',
  'scorecardresearch.com',
  'zedo.com',
  'adform.net',
  "googleads.g.doubleclick.net",
  "adservice.google.com",
  "pagead2.googlesyndication.com",
  "ads.google.com",
  "ads.youtube.com",
  "ads.mopub.com",
  "youtube.com/pagead",
  "youtube.com/api/stats/ads",
];
const DEFAULT_BLOCKED_TRACKER_HOSTS = [
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'googletagservices.com',
  'cdn.segment.com',
  'api.segment.io',
  'mixpanel.com',
  'amplitude.com',
  'hotjar.com',
  'clarity.ms',
  'app-measurement.com',
  'connect.facebook.net',
  'fullstory.com',
  'js-agent.newrelic.com',
  'bam.nr-data.net',
  'datadoghq-browser-agent.com',
  'bat.bing.com',
  'snap.licdn.com',
  'ads-twitter.com',
  'static.ads-twitter.com',
  'branch.io',
  'app.adjust.com',
];
let blockedTrackerRules = new Set<string>(DEFAULT_BLOCKED_TRACKER_HOSTS);
const AD_BLOCK_LIST_URLS = [
  'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
  'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/hosts/light.txt',
];
let blockedAdRules = new Set<string>(DEFAULT_BLOCKED_AD_HOSTS);

interface BlockRuleIndex {
  hosts: Set<string>;
  hostPaths: Map<string, string[]>;
}

/**
 * Splits blocking rules into host-only and host+path indexes for fast matching.
 */
function buildBlockRuleIndex(rules: Set<string>): BlockRuleIndex {
  const hosts = new Set<string>();
  const hostPaths = new Map<string, string[]>();

  for (const rule of rules) {
    const slashIndex = rule.indexOf('/');
    if (slashIndex === -1) {
      hosts.add(rule);
      continue;
    }

    const host = rule.slice(0, slashIndex);
    const rulePath = rule.slice(slashIndex);
    if (!host || !rulePath || rulePath === '/') {
      if (host) hosts.add(host);
      continue;
    }

    const existing = hostPaths.get(host);
    if (existing) {
      existing.push(rulePath);
    } else {
      hostPaths.set(host, [rulePath]);
    }
  }

  return { hosts, hostPaths };
}

let blockedTrackerRuleIndex = buildBlockRuleIndex(blockedTrackerRules);
let blockedAdRuleIndex = buildBlockRuleIndex(blockedAdRules);
const trackedYoutubeAdCpns = new Map<string, number>();

/**
 * Returns whether a hostname is a YouTube domain.
 */
function isYoutubeHost(hostname: string): boolean {
  return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
}

/**
 * Returns whether a hostname is a Google Video CDN domain.
 */
function isGoogleVideoHost(hostname: string): boolean {
  return hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com');
}

/**
 * Normalizes and validates ad CPN tokens extracted from requests.
 */
function normalizeCpnToken(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) return null;
  return normalized;
}

function pruneTrackedYoutubeAdCpns(now: number): void {
  for (const [cpn, expiresAt] of trackedYoutubeAdCpns) {
    if (expiresAt <= now) trackedYoutubeAdCpns.delete(cpn);
  }
}

function rememberYoutubeAdCpn(cpn: string, now: number): void {
  pruneTrackedYoutubeAdCpns(now);
  trackedYoutubeAdCpns.set(cpn, now + YOUTUBE_AD_CPN_TTL_MS);

  if (trackedYoutubeAdCpns.size <= MAX_TRACKED_YOUTUBE_AD_CPNS) return;
  const oldest = Array.from(trackedYoutubeAdCpns.entries()).sort((a, b) => a[1] - b[1]);
  const overflow = trackedYoutubeAdCpns.size - MAX_TRACKED_YOUTUBE_AD_CPNS;
  for (let i = 0; i < overflow; i += 1) {
    const entry = oldest[i];
    if (!entry) break;
    trackedYoutubeAdCpns.delete(entry[0]);
  }
}

function rememberYoutubeAdCpnFromUrl(parsed: URL): void {
  const host = parsed.hostname.toLowerCase();
  if (!isYoutubeHost(host)) return;

  const pathname = parsed.pathname.toLowerCase();
  const isAdSignalPath =
    pathname.startsWith('/api/stats/ads') ||
    pathname.startsWith('/pcs/activeview') ||
    pathname.startsWith('/pagead/interaction') ||
    pathname.startsWith('/pagead/adview');
  if (!isAdSignalPath) return;

  const adCpn = normalizeCpnToken(parsed.searchParams.get('ad_cpn'));
  if (!adCpn) return;
  rememberYoutubeAdCpn(adCpn, Date.now());
}

function shouldBlockYouTubeAdPlaybackByCpn(parsed: URL): boolean {
  if (!adBlockEnabled) return false;

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (!isGoogleVideoHost(host) || pathname !== '/videoplayback') return false;

  const cpn = normalizeCpnToken(parsed.searchParams.get('cpn'));
  if (!cpn) return false;

  const now = Date.now();
  pruneTrackedYoutubeAdCpns(now);
  const expiresAt = trackedYoutubeAdCpns.get(cpn);
  if (!expiresAt || expiresAt <= now) {
    if (expiresAt) trackedYoutubeAdCpns.delete(cpn);
    return false;
  }
  return true;
}

interface WindowTitleBarOverlayState {
  color: string;
  symbolColor: string;
  height: number;
  preferNativeOverlay: boolean;
  suppressForDockedDevToolsCount: number;
}

const DEFAULT_TITLEBAR_OVERLAY_COLOR = '#00000000';
const DEFAULT_TITLEBAR_SYMBOL_COLOR = '#e8edf5';
const DEFAULT_TITLEBAR_OVERLAY_HEIGHT = 38;
const windowTitleBarOverlayState = new Map<number, WindowTitleBarOverlayState>();

function getOrCreateTitleBarOverlayState(win: BrowserWindow): WindowTitleBarOverlayState {
  const existing = windowTitleBarOverlayState.get(win.id);
  if (existing) return existing;

  const created: WindowTitleBarOverlayState = {
    color: DEFAULT_TITLEBAR_OVERLAY_COLOR,
    symbolColor: DEFAULT_TITLEBAR_SYMBOL_COLOR,
    height: DEFAULT_TITLEBAR_OVERLAY_HEIGHT,
    preferNativeOverlay: isWindows,
    suppressForDockedDevToolsCount: 0,
  };
  windowTitleBarOverlayState.set(win.id, created);
  return created;
}

function isTitleBarOverlayActive(win: BrowserWindow): boolean {
  if (!isWindows || win.isDestroyed()) return false;
  const overlayState = getOrCreateTitleBarOverlayState(win);
  return overlayState.preferNativeOverlay && overlayState.suppressForDockedDevToolsCount === 0;
}

function applyWindowTitleBarOverlay(win: BrowserWindow): boolean {
  if (!isWindows || win.isDestroyed()) return false;

  const overlayState = getOrCreateTitleBarOverlayState(win);
  const shouldEnable = overlayState.preferNativeOverlay && overlayState.suppressForDockedDevToolsCount === 0;

  if (shouldEnable) {
    win.setTitleBarOverlay({
      color: overlayState.color,
      symbolColor: overlayState.symbolColor,
      height: overlayState.height,
    });
  } else {
    win.setTitleBarOverlay(false);
  }

  if (!win.webContents.isDestroyed()) {
    win.webContents.send('window-titlebar-overlay-changed', shouldEnable);
  }
  return shouldEnable;
}

function suppressTitleBarOverlayForDockedDevTools(win: BrowserWindow): () => void {
  const overlayState = getOrCreateTitleBarOverlayState(win);
  overlayState.suppressForDockedDevToolsCount += 1;
  applyWindowTitleBarOverlay(win);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const latest = windowTitleBarOverlayState.get(win.id);
    if (!latest) return;

    latest.suppressForDockedDevToolsCount = Math.max(0, latest.suppressForDockedDevToolsCount - 1);
    if (!win.isDestroyed()) {
      applyWindowTitleBarOverlay(win);
    }
  };
}

function isRestorableSessionTabUrl(url: string): boolean {
  return url.trim().toLowerCase() !== 'mira://newtab';
}

function sanitizeUserAgent(userAgent: string): string {
  const withoutElectron = userAgent.replace(/\sElectron\/[^\s)]+/g, '').trim();
  return withoutElectron.replace(/\sMira\/[^\s)]+/g, '').trim();
}

function buildMiraUserAgent(userAgent: string): string {
  const base = sanitizeUserAgent(userAgent);
  const version = app.getVersion();
  const token = `Mira/${version}`;
  if (!base) return token;
  if (base.includes(token)) return base;
  return `${base} ${token}`.trim();
}

function getMiraVersion(): string {
  return app.getVersion();
}

function getChromeVersion(): string {
  return process.versions.chrome ?? '0';
}

function getChromeMajorVersion(): string {
  const [major] = getChromeVersion().split('.');
  return major || '0';
}

function getChPlatform(): string {
  if (isMacOS) return 'macOS';
  if (isWindows) return 'Windows';
  if (process.platform === 'linux') return 'Linux';
  return process.platform;
}

function getChPlatformVersion(): string {
  return os.release();
}

function getSecChUaHeader(miraVersion: string): string {
  const chromeMajor = getChromeMajorVersion();
  return `"Mira";v="${miraVersion}", "Chromium";v="${chromeMajor}", "Not;A=Brand";v="99"`;
}

function getSecChUaFullVersionListHeader(miraVersion: string): string {
  const chromeVersion = getChromeVersion();
  return `"Mira";v="${miraVersion}", "Chromium";v="${chromeVersion}", "Not;A=Brand";v="99.0.0.0"`;
}

function sanitizeFileNameFragment(value: string): string {
  const withoutReservedChars = value.replace(/[<>:"/\\|?*]+/g, ' ');
  const withoutControlChars = Array.from(withoutReservedChars)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('');
  return withoutControlChars.replace(/\s+/g, ' ').trim();
}

function getPageSaveDefaultFileName(target: WebContents): string {
  const titleCandidate = sanitizeFileNameFragment(target.getTitle?.() ?? '');
  if (titleCandidate) {
    return `${titleCandidate}.html`;
  }

  const urlCandidate = (target.getURL?.() ?? '').trim();
  if (!urlCandidate) return 'page.html';

  try {
    const parsed = new URL(urlCandidate);
    const hostname = sanitizeFileNameFragment(parsed.hostname || '');
    const pathname = sanitizeFileNameFragment(parsed.pathname.split('/').filter(Boolean).join('-'));
    if (hostname && pathname) return `${hostname}-${pathname}.html`;
    if (hostname) return `${hostname}.html`;
  } catch {
    const fallback = sanitizeFileNameFragment(urlCandidate);
    if (fallback) return `${fallback}.html`;
  }

  return 'page.html';
}

function getAdBlockCachePath(): string {
  return path.join(app.getPath('userData'), AD_BLOCK_CACHE_FILE);
}

function getBundledTrackerListPath(): string {
  return path.join(app.getAppPath(), TRACKER_BLOCK_LOCAL_FILE);
}

function isValidHostnameToken(token: string): boolean {
  if (!token.includes('.')) return false;
  if (!/^[a-z0-9.-]+$/.test(token)) return false;
  if (token.startsWith('.') || token.endsWith('.')) return false;
  if (token.includes('..')) return false;
  return true;
}

function normalizeBlockedHostToken(token: string): string | null {
  const normalized = token.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return null;
  if (normalized === 'localhost' || normalized === 'local') return null;
  if (!isValidHostnameToken(normalized)) return null;
  return normalized;
}

function normalizeBlockedRuleToken(token: string): string | null {
  const trimmedToken = token.trim();
  if (!trimmedToken) return null;

  if (/^https?:\/\//i.test(trimmedToken)) {
    try {
      const parsed = new URL(trimmedToken);
      const host = normalizeBlockedHostToken(parsed.hostname);
      if (!host) return null;
      const rulePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.toLowerCase() : '';
      return rulePath ? `${host}${rulePath}` : host;
    } catch {
      return null;
    }
  }

  const normalizedToken = trimmedToken.toLowerCase();

  const slashIndex = normalizedToken.indexOf('/');
  const rawHost = slashIndex === -1 ? normalizedToken : normalizedToken.slice(0, slashIndex);
  const normalizedHost = normalizeBlockedHostToken(rawHost);
  if (!normalizedHost) return null;

  if (slashIndex === -1) return normalizedHost;

  const rawPath = normalizedToken.slice(slashIndex);
  const normalizedPath = `/${rawPath.replace(/^\/+/, '')}`;
  if (normalizedPath === '/') return normalizedHost;
  return `${normalizedHost}${normalizedPath}`;
}

function extractRuleFromBlocklistLine(line: string): string | null {
  const withoutComment = line.split('#', 1)[0]?.trim() ?? '';
  if (!withoutComment) return null;
  if (withoutComment.startsWith('!')) return null;

  const parts = withoutComment.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;

  const first = parts[0].toLowerCase();
  const hostToken =
    first === '0.0.0.0' ||
    first === '127.0.0.1' ||
    first === '::' ||
    first === '::1' ||
    first === '0:0:0:0:0:0:0:1'
      ? parts[1]
      : parts[0];
  if (!hostToken) return null;

  return normalizeBlockedRuleToken(hostToken);
}

function parseRulesFromBlocklist(raw: string): Set<string> {
  const parsed = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const rule = extractRuleFromBlocklistLine(line);
    if (rule) parsed.add(rule);
  }

  return parsed;
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadCachedAdBlockHosts(): Promise<void> {
  try {
    const raw = await fs.readFile(getAdBlockCachePath(), 'utf-8');
    const cachedHosts = parseRulesFromBlocklist(raw);
    if (!cachedHosts.size) return;

    blockedAdRules = new Set([...DEFAULT_BLOCKED_AD_HOSTS, ...cachedHosts]);
    blockedAdRuleIndex = buildBlockRuleIndex(blockedAdRules);
  } catch {
    // No cache yet.
  }
}

async function loadBundledTrackerBlockHosts(): Promise<void> {
  try {
    const raw = await fs.readFile(getBundledTrackerListPath(), 'utf-8');
    const parsedHosts = parseRulesFromBlocklist(raw);
    if (!parsedHosts.size) return;

    blockedTrackerRules = new Set([...DEFAULT_BLOCKED_TRACKER_HOSTS, ...parsedHosts]);
    blockedTrackerRuleIndex = buildBlockRuleIndex(blockedTrackerRules);
  } catch {
    // Missing local tracker list should not disable default tracker blocking.
  }
}

async function refreshAdBlockHostsFromLists(): Promise<void> {
  const downloadedHosts = new Set<string>();

  for (const listUrl of AD_BLOCK_LIST_URLS) {
    try {
      const listText = await fetchTextWithTimeout(listUrl, AD_BLOCK_FETCH_TIMEOUT_MS);
      const parsedHosts = parseRulesFromBlocklist(listText);
      for (const host of parsedHosts) {
        downloadedHosts.add(host);
      }
    } catch {
      // Ignore single-list failures and continue with remaining lists.
    }
  }

  if (!downloadedHosts.size) return;

  blockedAdRules = new Set([...DEFAULT_BLOCKED_AD_HOSTS, ...downloadedHosts]);
  blockedAdRuleIndex = buildBlockRuleIndex(blockedAdRules);
  try {
    await fs.writeFile(getAdBlockCachePath(), Array.from(downloadedHosts).join('\n'), 'utf-8');
  } catch {
    // Cache write failures should not disable blocking.
  }
}

function scheduleAdBlockListRefresh(): void {
  void refreshAdBlockHostsFromLists();
  const interval = setInterval(() => {
    void refreshAdBlockHostsFromLists();
  }, AD_BLOCK_REFRESH_INTERVAL_MS);
  interval.unref();
}

function isBlockedByRules(hostname: string, pathname: string, index: BlockRuleIndex): boolean {
  const normalizedPathname = pathname.toLowerCase() || '/';
  let candidate = hostname;
  while (candidate) {
    if (index.hosts.has(candidate)) return true;

    const pathRules = index.hostPaths.get(candidate);
    if (pathRules) {
      for (const pathRule of pathRules) {
        if (
          normalizedPathname === pathRule ||
          normalizedPathname.startsWith(pathRule + '/') ||
          normalizedPathname.startsWith(pathRule + '?') ||
          normalizedPathname.startsWith(pathRule + '#')
        ) return true;
      }
    }

    const nextDot = candidate.indexOf('.');
    if (nextDot === -1) return false;
    candidate = candidate.slice(nextDot + 1);
  }
  return false;
}

function shouldBlockRequest(url: string, resourceType: string): boolean {
  if (resourceType === 'mainFrame') return false;

  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return false;

    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (adBlockEnabled) {
      rememberYoutubeAdCpnFromUrl(parsed);
      if (shouldBlockYouTubeAdPlaybackByCpn(parsed)) return true;
    }
    const adBlocked = adBlockEnabled && isBlockedByRules(host, pathname, blockedAdRuleIndex);
    const trackerBlocked = trackerBlockEnabled && isBlockedByRules(host, pathname, blockedTrackerRuleIndex);
    return adBlocked || trackerBlocked;
  } catch {
    return false;
  }
}

function getHistoryFilePath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function normalizeIncomingBrowserArgValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeIncomingBrowserFilePath(rawValue: string): string | null {
  const trimmed = normalizeIncomingBrowserArgValue(rawValue);
  if (!trimmed || !path.isAbsolute(trimmed)) return null;

  try {
    const stats = statSync(trimmed);
    if (!stats.isFile()) return null;
    return pathToFileURL(trimmed).toString();
  } catch {
    return null;
  }
}

function normalizeMailtoUrl(rawUrl: string): string | null {
  const trimmed = normalizeIncomingBrowserArgValue(rawUrl);
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol.toLowerCase() !== 'mailto:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function toInternalMailtoUrl(rawUrl: string): string | null {
  const normalizedMailtoUrl = normalizeMailtoUrl(rawUrl);
  if (!normalizedMailtoUrl) return null;
  return `mira://mailto?url=${encodeURIComponent(normalizedMailtoUrl)}`;
}

function resolveMailtoProviderTarget(
  mailtoUrl: string,
  candidateUrl: string,
): { id: KnownWebmailProviderId; title: string; url: string } | null {
  try {
    const parsedCandidate = new URL(candidateUrl.trim());
    if (parsedCandidate.protocol.toLowerCase() !== 'https:') return null;

    const host = parsedCandidate.hostname.toLowerCase();
    if (host === 'mail.google.com') {
      return {
        id: 'gmail',
        title: 'Compose Email',
        url: `https://mail.google.com/mail/?extsrc=mailto&url=${encodeURIComponent(mailtoUrl)}`,
      };
    }

    if (
      host === 'outlook.live.com'
      || host === 'outlook.office.com'
      || host === 'outlook.office365.com'
    ) {
      return {
        id: 'outlook',
        title: 'Compose Email',
        url: `${parsedCandidate.origin}/mail/deeplink/compose?mailtouri=${encodeURIComponent(mailtoUrl)}`,
      };
    }

    if (host === 'mail.proton.me' || host === 'mail.protonmail.com') {
      return {
        id: 'proton',
        title: 'Compose Email',
        url: `https://mail.proton.me/inbox/#mailto=${encodeURIComponent(mailtoUrl)}`,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function getRecentMailProviderCandidates(): Array<{ url: string; timestamp: number }> {
  const latestTimestampByUrl = new Map<string, number>();

  for (const snapshot of windowSessionCache.values()) {
    const savedAt = Number.isFinite(snapshot.savedAt) ? snapshot.savedAt : 0;
    for (const tab of snapshot.tabs) {
      const url = typeof tab.url === 'string' ? tab.url.trim() : '';
      if (!url) continue;
      const lastActiveAt = Number.isFinite(tab.lastActiveAt) ? tab.lastActiveAt : 0;
      const activeBoost = tab.id === snapshot.activeId ? 1 : 0;
      const timestamp = Math.max(savedAt, lastActiveAt) + activeBoost;
      const previous = latestTimestampByUrl.get(url) ?? 0;
      if (timestamp > previous) {
        latestTimestampByUrl.set(url, timestamp);
      }
    }
  }

  for (const entry of historyCache) {
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!url) continue;
    const visitedAt = Number.isFinite(entry.visitedAt) ? entry.visitedAt : 0;
    const previous = latestTimestampByUrl.get(url) ?? 0;
    if (visitedAt > previous) {
      latestTimestampByUrl.set(url, visitedAt);
    }
  }

  return Array.from(latestTimestampByUrl.entries())
    .map(([url, timestamp]) => ({ url, timestamp }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

function resolveMailtoNavigationTarget(
  rawUrl: string,
  options?: { allowExternalFallback?: boolean },
): MailtoNavigationTarget | null {
  const normalizedMailtoUrl = normalizeMailtoUrl(rawUrl);
  if (!normalizedMailtoUrl) return null;

  for (const candidate of getRecentMailProviderCandidates()) {
    const target = resolveMailtoProviderTarget(normalizedMailtoUrl, candidate.url);
    if (target) {
      return {
        kind: 'browser-tab',
        url: target.url,
        title: target.title,
      };
    }
  }

  const allowExternalFallback = options?.allowExternalFallback !== false;
  if (allowExternalFallback && !isDefaultForProtocol('mailto')) {
    return {
      kind: 'external-os',
      url: normalizedMailtoUrl,
      title: 'Compose Email',
    };
  }

  const fallbackUrl = toInternalMailtoUrl(normalizedMailtoUrl);
  if (!fallbackUrl) return null;

  return {
    kind: 'internal-tab',
    url: fallbackUrl,
    title: 'Compose Email',
  };
}

function normalizeIncomingBrowserUrl(rawUrl: string): string | null {
  const fileUrl = normalizeIncomingBrowserFilePath(rawUrl);
  if (fileUrl) return fileUrl;

  const trimmed = normalizeIncomingBrowserArgValue(rawUrl);
  if (!trimmed) return null;

  const normalizedMailtoUrl = normalizeMailtoUrl(trimmed);
  if (normalizedMailtoUrl) return normalizedMailtoUrl;

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (
      protocol !== 'http:' &&
      protocol !== 'https:' &&
      protocol !== 'file:' &&
      protocol !== 'mailto:' &&
      protocol !== 'about:' &&
      protocol !== 'mira:'
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractIncomingBrowserUrlFromArgv(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    if (i === 0 || (process.defaultApp && i === 1)) continue;
    const candidate = normalizeIncomingBrowserUrl(argv[i] ?? '');
    if (candidate) return candidate;
  }
  return null;
}

function enqueueIncomingBrowserUrl(rawUrl: string): void {
  const normalized = normalizeIncomingBrowserUrl(rawUrl);
  if (!normalized) return;
  incomingBrowserUrlQueue.push(normalized);
}

function takeQueuedIncomingBrowserUrls(): string[] {
  if (!incomingBrowserUrlQueue.length) return [];
  return incomingBrowserUrlQueue.splice(0, incomingBrowserUrlQueue.length);
}

function getDefaultProtocolRegistrationContext():
  | {
      executable: string;
      args: string[];
    }
  | null {
  if (!process.defaultApp) return null;
  const appEntrypoint = process.argv[1];
  if (!appEntrypoint) return null;

  return {
    executable: process.execPath,
    args: [path.resolve(appEntrypoint)],
  };
}

function logDebug(scope: string, message: string, details?: Record<string, unknown>): void {
  if (!ENABLE_APP_DEBUG_LOGS) return;
  const payload = details ? `${message} ${JSON.stringify(details)}` : message;
  const line = `[${scope}-debug] ${payload}`;
  console.info(line);

  try {
    appendFileSync(
      path.join(app.getPath('userData'), 'app-debug.log'),
      `${new Date().toISOString()} ${line}\n`,
      'utf8',
    );
  } catch (error) {
    console.error('[debug-log-write-failed]', error);
  }
}

function logDefaultBrowserDebug(message: string, details?: Record<string, unknown>): void {
  logDebug('default-browser', message, details);
}

function navigationLogUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function getSafeUserDataPath(): string {
  try {
    return app.getPath('userData');
  } catch {
    return '(userData unavailable)';
  }
}

function isDefaultForProtocol(protocol: string): boolean {
  try {
    const registrationContext = getDefaultProtocolRegistrationContext();
    const hasRegistrationContext = !!registrationContext;
    if (!registrationContext) {
      const result = app.isDefaultProtocolClient(protocol);
      logDefaultBrowserDebug('isDefaultForProtocol', {
        protocol,
        result,
        hasRegistrationContext,
      });
      return result;
    }

    const result = app.isDefaultProtocolClient(
      protocol,
      registrationContext.executable,
      registrationContext.args,
    );
    logDefaultBrowserDebug('isDefaultForProtocol', {
      protocol,
      result,
      hasRegistrationContext,
      executable: registrationContext.executable,
      args: registrationContext.args,
    });
    return result;
  } catch (error) {
    logDefaultBrowserDebug('isDefaultForProtocol-error', {
      protocol,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function setAsDefaultForProtocol(protocol: string): boolean {
  if (isDevelopment) return false;
  try {
    const registrationContext = getDefaultProtocolRegistrationContext();
    const hasRegistrationContext = !!registrationContext;
    if (!registrationContext) {
      const result = app.setAsDefaultProtocolClient(protocol);
      logDefaultBrowserDebug('setAsDefaultForProtocol', {
        protocol,
        result,
        hasRegistrationContext,
      });
      return result;
    }

    const result = app.setAsDefaultProtocolClient(
      protocol,
      registrationContext.executable,
      registrationContext.args,
    );
    logDefaultBrowserDebug('setAsDefaultForProtocol', {
      protocol,
      result,
      hasRegistrationContext,
      executable: registrationContext.executable,
      args: registrationContext.args,
    });
    return result;
  } catch (error) {
    logDefaultBrowserDebug('setAsDefaultForProtocol-error', {
      protocol,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function isDefaultBrowser(): boolean {
  if (isWindows) {
    const windowsResult = isDefaultBrowserWindows();
    if (windowsResult !== null) {
      return windowsResult;
    }
    return false;
  }

  return isDefaultForProtocol('http') && isDefaultForProtocol('https');
}

let cachedBuildAppId: string | null | undefined;
let cachedBuildProductName: string | null | undefined;

function getBuildAppId(): string | null {
  if (cachedBuildAppId !== undefined) return cachedBuildAppId;
  try {
    const raw = readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { build?: { appId?: unknown } };
    const appId = typeof parsed?.build?.appId === 'string' ? parsed.build.appId : null;
    cachedBuildAppId = appId;
    return appId;
  } catch {
    cachedBuildAppId = null;
    return null;
  }
}

function readRegistryValue(key: string, valueName: string): string | null {
  if (!isWindows) return null;
  try {
    const output = execFileSync('reg', ['query', key, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.toLowerCase().startsWith(valueName.toLowerCase())) continue;

      const parts = trimmed.split(/\s{2,}/);
      if (parts.length >= 3) {
        return parts.slice(2).join(' ').trim();
      }

      const match = trimmed.match(new RegExp(`^${valueName}\\s+REG_\\w+\\s+(.*)$`, 'i'));
      if (match?.[1]) return match[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

function getWindowsUserChoiceProgId(protocol: 'http' | 'https'): string | null {
  const key = `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${protocol}\\UserChoice`;
  return readRegistryValue(key, 'ProgId');
}

function getWindowsRegisteredProtocolProgId(protocol: 'http' | 'https'): string | null {
  const candidates: string[] = [];
  const buildProductName = getBuildProductName();
  if (buildProductName) candidates.push(buildProductName);

  const appName = app.getName();
  if (appName && !candidates.includes(appName)) candidates.push(appName);
  try {
    const exeName = path.basename(app.getPath('exe'), path.extname(app.getPath('exe')));
    if (exeName && !candidates.includes(exeName)) candidates.push(exeName);
  } catch {
    // ignore
  }

  for (const name of candidates) {
    const keyUser = `HKCU\\Software\\Clients\\StartMenuInternet\\${name}\\Capabilities\\URLAssociations`;
    const userValue = readRegistryValue(keyUser, protocol);
    if (userValue) return userValue;

    const keyMachine = `HKLM\\Software\\Clients\\StartMenuInternet\\${name}\\Capabilities\\URLAssociations`;
    const machineValue = readRegistryValue(keyMachine, protocol);
    if (machineValue) return machineValue;
  }

  const appId = getBuildAppId();
  return appId ? `${appId}.URL` : null;
}

function isDefaultBrowserWindows(): boolean | null {
  const httpChoice = getWindowsUserChoiceProgId('http');
  const httpsChoice = getWindowsUserChoiceProgId('https');
  if (!httpChoice || !httpsChoice) {
    logDefaultBrowserDebug('windows-default-browser-userchoice-missing', {
      httpChoice,
      httpsChoice,
    });
    return null;
  }

  const expectedHttp = getWindowsRegisteredProtocolProgId('http');
  const expectedHttps = getWindowsRegisteredProtocolProgId('https') ?? expectedHttp;
  if (!expectedHttp || !expectedHttps) {
    logDefaultBrowserDebug('windows-default-browser-expected-missing', {
      expectedHttp,
      expectedHttps,
    });
    return null;
  }

  const isDefault = httpChoice === expectedHttp && httpsChoice === expectedHttps;
  logDefaultBrowserDebug('windows-default-browser-check', {
    httpChoice,
    httpsChoice,
    expectedHttp,
    expectedHttps,
    isDefault,
  });
  return isDefault;
}

function getWindowsDefaultAppsSettingsUri(): string {
  if (!isWindows) return 'ms-settings:defaultapps';

  let registeredAppName = '';
  try {
    const exePath = app.getPath('exe');
    const exeName = path.basename(exePath, path.extname(exePath));
    registeredAppName = exeName || app.getName();
    const isPerMachineInstall = exePath.toLowerCase().includes('\\program files\\');
    if (!registeredAppName) return 'ms-settings:defaultapps';

    const param = isPerMachineInstall ? 'registeredAppMachine' : 'registeredAppUser';
    return `ms-settings:defaultapps?${param}=${encodeURIComponent(registeredAppName)}`;
  } catch {
    return 'ms-settings:defaultapps';
  }
}

function openWindowsDefaultAppsSettings(): void {
  if (!isWindows) return;

  const uri = getWindowsDefaultAppsSettingsUri();

  void shell.openExternal(uri).catch(() => {
    void shell.openExternal('ms-settings:defaultapps');
  });
}

type DefaultBrowserSupportCode =
  | 'ok'
  | 'dev-build'
  | 'windows-portable'
  | 'manual-confirmation-required'
  | 'registration-failed';

type DefaultBrowserSupportInfo = {
  code: DefaultBrowserSupportCode;
  canAttemptRegistration: boolean;
  requiresUserAction: boolean;
  message: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isPortableBuild: boolean;
  processDefaultApp: boolean;
};

type RunOnStartupSupportCode = 'ok' | 'unsupported-platform' | 'dev-build' | 'read-failed';

type RunOnStartupSupportInfo = {
  code: RunOnStartupSupportCode;
  canConfigure: boolean;
  message: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  processDefaultApp: boolean;
  isEnabled: boolean;
};

function getDefaultBrowserSupportInfo(): DefaultBrowserSupportInfo {
  if (!app.isPackaged || process.defaultApp) {
    return {
      code: 'dev-build',
      canAttemptRegistration: false,
      requiresUserAction: true,
      message:
        'Default browser registration is unavailable in development mode. Use an installed packaged build and set Mira in your OS default apps settings.',
      platform: process.platform,
      isPackaged: app.isPackaged,
      isPortableBuild,
      processDefaultApp: !!process.defaultApp,
    };
  }

  if (isWindows && isPortableBuild) {
    return {
      code: 'windows-portable',
      canAttemptRegistration: false,
      requiresUserAction: true,
      message:
        'Portable builds cannot reliably own HTTP/HTTPS defaults on Windows. Install the NSIS build, then select Mira in Default apps.',
      platform: process.platform,
      isPackaged: app.isPackaged,
      isPortableBuild,
      processDefaultApp: !!process.defaultApp,
    };
  }

  return {
    code: 'ok',
    canAttemptRegistration: true,
    requiresUserAction: false,
    message: '',
    platform: process.platform,
    isPackaged: app.isPackaged,
    isPortableBuild,
    processDefaultApp: !!process.defaultApp,
  };
}

function getRunOnStartupSupportInfo(): RunOnStartupSupportInfo {
  if (!isWindows && !isMacOS) {
    return {
      code: 'unsupported-platform',
      canConfigure: false,
      message: 'Run on startup is only supported on Windows and macOS.',
      platform: process.platform,
      isPackaged: app.isPackaged,
      processDefaultApp: !!process.defaultApp,
      isEnabled: false,
    };
  }

  if (!app.isPackaged || process.defaultApp) {
    return {
      code: 'dev-build',
      canConfigure: false,
      message: 'Run on startup is unavailable in development mode. Use an installed packaged build.',
      platform: process.platform,
      isPackaged: app.isPackaged,
      processDefaultApp: !!process.defaultApp,
      isEnabled: false,
    };
  }

  try {
    const loginItemSettings = app.getLoginItemSettings();
    return {
      code: 'ok',
      canConfigure: true,
      message: '',
      platform: process.platform,
      isPackaged: app.isPackaged,
      processDefaultApp: !!process.defaultApp,
      isEnabled: loginItemSettings.openAtLogin === true,
    };
  } catch (error) {
    return {
      code: 'read-failed',
      canConfigure: false,
      message: error instanceof Error ? error.message : 'Failed to read startup settings.',
      platform: process.platform,
      isPackaged: app.isPackaged,
      processDefaultApp: !!process.defaultApp,
      isEnabled: false,
    };
  }
}

function getSessionFilePath() {
  return path.join(app.getPath('userData'), 'session.json');
}

function getAppStateFilePath() {
  return path.join(app.getPath('userData'), APP_STATE_FILE);
}

function getSitePermissionsFilePath() {
  return path.join(app.getPath('userData'), SITE_PERMISSIONS_FILE);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSitePermissionId(value: unknown): value is SitePermissionId {
  return typeof value === 'string' && SITE_SETTINGS_PERMISSION_ORDER.includes(value as SitePermissionId);
}

function normalizeSitePermissionSetting(value: unknown): SitePermissionSetting {
  if (value === 'allow' || value === 'ask' || value === 'block') {
    return value;
  }
  return 'ask';
}

function normalizeSitePermissionOrigin(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') {
      // Return just the hostname (no protocol) - includes subdomains
      return parsed.hostname.toLowerCase();
    }
  } catch {
    // If URL parsing fails, try to extract hostname directly
    const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
    const hostnameMatch = withoutProtocol.match(/^([^/\s:]+)/);
    if (hostnameMatch) {
      return hostnameMatch[1].toLowerCase();
    }
  }

  return null;
}

function getSiteDisplayLabel(rawValue: string): string {
  const normalizedOrigin = normalizeSitePermissionOrigin(rawValue);
  if (normalizedOrigin) return normalizedOrigin;

  const trimmed = rawValue.trim();
  if (!trimmed) return 'This site';

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname) return parsed.hostname.toLowerCase();
  } catch {
    // Fall through to default label below.
  }

  return 'This site';
}

function normalizePersistedSitePermissions(
  value: unknown,
): Record<string, Partial<Record<SitePermissionId, SitePermissionSetting>>> {
  if (!isObjectRecord(value)) return {};

  const source =
    isObjectRecord(value.origins)
      ? value.origins
      : value;
  const normalized: Record<string, Partial<Record<SitePermissionId, SitePermissionSetting>>> = {};

  for (const [rawOrigin, rawPermissions] of Object.entries(source)) {
    const origin = normalizeSitePermissionOrigin(rawOrigin);
    if (!origin || !isObjectRecord(rawPermissions)) continue;

    const nextPermissions: Partial<Record<SitePermissionId, SitePermissionSetting>> = {};
    for (const [rawPermissionId, rawSetting] of Object.entries(rawPermissions)) {
      if (!isSitePermissionId(rawPermissionId)) continue;

      const normalizedSetting = normalizeSitePermissionSetting(rawSetting);
      if (normalizedSetting === 'ask') continue;
      nextPermissions[rawPermissionId] = normalizedSetting;
    }

    if (Object.keys(nextPermissions).length > 0) {
      normalized[origin] = nextPermissions;
    }
  }

  return normalized;
}

function readSitePermissionSetting(
  origin: string,
  permissionId: SitePermissionId,
): SitePermissionSetting {
  const normalizedOrigin = normalizeSitePermissionOrigin(origin);
  if (!normalizedOrigin) return 'ask';
  return persistedSitePermissions[normalizedOrigin]?.[permissionId] ?? 'ask';
}

function writeSitePermissionSetting(
  origin: string,
  permissionId: SitePermissionId,
  setting: SitePermissionSetting,
): void {
  const normalizedOrigin = normalizeSitePermissionOrigin(origin);
  if (!normalizedOrigin) return;

  const existing = persistedSitePermissions[normalizedOrigin] ?? {};
  const next = { ...existing };

  if (setting === 'ask') {
    delete next[permissionId];
  } else {
    next[permissionId] = setting;
  }

  if (Object.keys(next).length === 0) {
    delete persistedSitePermissions[normalizedOrigin];
    return;
  }

  persistedSitePermissions[normalizedOrigin] = next;
}

function summarizeSitePermissionDecision(
  origin: string,
  permissionIds: SitePermissionId[],
): SitePermissionSetting {
  if (!permissionIds.length) return 'ask';

  let allAllowed = true;
  for (const permissionId of permissionIds) {
    const decision = readSitePermissionSetting(origin, permissionId);
    if (decision === 'block') return 'block';
    if (decision !== 'allow') {
      allAllowed = false;
    }
  }

  return allAllowed ? 'allow' : 'ask';
}

function buildSitePermissionsSnapshot(origin: string) {
  const normalizedOrigin = normalizeSitePermissionOrigin(origin);
  if (!normalizedOrigin) {
    return {
      canManage: false,
      origin: '',
      siteLabel: '',
      permissions: [],
    };
  }

  return {
    canManage: true,
    origin: normalizedOrigin,
    siteLabel: getSiteDisplayLabel(normalizedOrigin),
    permissions: SITE_SETTINGS_PERMISSION_ORDER.map((permissionId) => ({
      id: permissionId,
      label: SITE_PERMISSION_LABELS[permissionId],
      decision: readSitePermissionSetting(normalizedOrigin, permissionId),
    })),
  };
}

function extractPermissionOrigin(
  webContents: WebContents | null | undefined,
  details: {
    requestingUrl?: string;
    securityOrigin?: string;
    externalURL?: string;
  },
): string | null {
  const candidates = [
    details.securityOrigin,
    details.requestingUrl,
    details.externalURL,
    webContents?.getURL?.(),
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeSitePermissionOrigin(candidate);
    if (normalized) return normalized;
  }

  return null;
}

function mapPermissionIdsFromDetails(
  permission: string,
  details: {
    mediaType?: 'video' | 'audio' | 'unknown';
    mediaTypes?: Array<'video' | 'audio'>;
  },
): SitePermissionId[] {
  if (permission === 'media') {
    const requestedMediaTypes = Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0
      ? details.mediaTypes
      : details.mediaType && details.mediaType !== 'unknown'
        ? [details.mediaType]
        : [];

    const permissionIds = new Set<SitePermissionId>();
    for (const mediaType of requestedMediaTypes) {
      if (mediaType === 'video') permissionIds.add('camera');
      if (mediaType === 'audio') permissionIds.add('microphone');
    }
    if (permissionIds.size === 0) {
      permissionIds.add('camera');
      permissionIds.add('microphone');
    }
    return Array.from(permissionIds);
  }

  switch (permission) {
    case 'geolocation':
      return ['location'];
    case 'notifications':
      return ['notifications'];
    case 'fullscreen':
      return ['fullscreen'];
    case 'clipboard-read':
    case 'clipboard-sanitized-write':
      return ['clipboard'];
    case 'pointerLock':
      return ['pointer-lock'];
    case 'display-capture':
      return ['screen-capture'];
    case 'midi':
    case 'midiSysex':
    case 'mediaKeySystem':
      return ['midi'];
    case 'storage-access':
    case 'top-level-storage-access':
      return ['storage-access'];
    case 'window-management':
      return ['window-management'];
    case 'idle-detection':
      return ['idle-detection'];
    case 'speaker-selection':
      return ['speaker-selection'];
    case 'keyboardLock':
      return ['keyboard-lock'];
    case 'openExternal':
      return ['external-apps'];
    case 'fileSystem':
      return ['file-system'];
    default:
      return ['unknown'];
  }
}

function describeSitePermissionRequest(permissionIds: SitePermissionId[]): string {
  const filtered = permissionIds.filter((permissionId) => permissionId !== 'unknown');
  if (filtered.length === 2 && filtered.includes('camera') && filtered.includes('microphone')) {
    return 'Use your camera and microphone';
  }

  const firstPermissionId = filtered[0] ?? permissionIds[0] ?? 'unknown';
  switch (firstPermissionId) {
    case 'camera':
      return 'Use your camera';
    case 'microphone':
      return 'Use your microphone';
    case 'location':
      return 'Know your location';
    case 'notifications':
      return 'Show notifications';
    case 'fullscreen':
      return 'Enter fullscreen';
    case 'clipboard':
      return 'Access your clipboard';
    case 'pointer-lock':
      return 'Lock your pointer';
    case 'screen-capture':
      return 'Capture your screen';
    case 'midi':
      return 'Use MIDI devices';
    case 'storage-access':
      return 'Use cross-site cookies and site data';
    case 'window-management':
      return 'Manage your windows';
    case 'idle-detection':
      return 'Detect when you are idle';
    case 'speaker-selection':
      return 'Choose your speaker';
    case 'keyboard-lock':
      return 'Capture keyboard shortcuts';
    case 'external-apps':
      return 'Open external apps';
    case 'file-system':
      return 'Access files on this device';
    case 'unknown':
    default:
      return 'Use a restricted browser permission';
  }
}

function normalizeDialogMessage(value: unknown): string {
  const normalized = typeof value === 'string'
    ? value
    : value == null
      ? ''
      : String(value);
  return normalized.trim().slice(0, 4000);
}

function showMessageBoxSyncForWindow(
  targetWindow: BrowserWindow | null,
  options: MessageBoxSyncOptions,
): number {
  if (targetWindow && !targetWindow.isDestroyed()) {
    return dialog.showMessageBoxSync(targetWindow, options);
  }
  return dialog.showMessageBoxSync(options);
}

async function loadPersistedSitePermissions(): Promise<void> {
  try {
    const raw = await fs.readFile(getSitePermissionsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    persistedSitePermissions = normalizePersistedSitePermissions(parsed);
  } catch {
    persistedSitePermissions = {};
  }
}

async function persistSitePermissions(): Promise<void> {
  const payload: PersistedSitePermissions = {
    origins: persistedSitePermissions,
  };
  await fs.writeFile(getSitePermissionsFilePath(), JSON.stringify(payload, null, 2), 'utf-8');
}

function normalizeAppState(value: unknown): PersistedAppState {
  if (typeof value !== 'object' || value === null) return {};
  const candidate = value as PersistedAppState;
  return {
    onboardingCompleted: candidate.onboardingCompleted === true,
  };
}

async function loadPersistedAppState(): Promise<void> {
  try {
    const raw = await fs.readFile(getAppStateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeAppState(parsed);
    onboardingCompleted = normalized.onboardingCompleted === true;
  } catch {
    onboardingCompleted = false;
  }
}

async function persistAppState(): Promise<void> {
  const payload: PersistedAppState = {
    onboardingCompleted,
  };
  await fs.writeFile(getAppStateFilePath(), JSON.stringify(payload), 'utf-8');
}

function shouldShowOnboarding(): boolean {
  if (!app.isPackaged || process.defaultApp) return false;
  return onboardingCompleted !== true;
}

function pruneHistory(entries: HistoryEntry[]): HistoryEntry[] {
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  return entries
    .filter((entry) => entry.visitedAt >= cutoff)
    .sort((a, b) => b.visitedAt - a.visitedAt);
}

async function persistHistory() {
  await fs.writeFile(getHistoryFilePath(), JSON.stringify(historyCache, null, 0), 'utf-8');
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(getHistoryFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as HistoryEntry[];
    historyCache = pruneHistory(Array.isArray(parsed) ? parsed : []);
    await persistHistory();
  } catch {
    historyCache = [];
  }
}

async function addHistoryEntry(payload: { url?: string; title?: string }) {
  const url = payload.url?.trim();
  if (!url || url.startsWith('mira://')) return;

  const now = Date.now();
  const title = payload.title?.trim() || url;
  const latest = historyCache[0];

  if (latest && latest.url === url && now - latest.visitedAt < 1500) {
    return;
  }

  historyCache = pruneHistory([
    {
      id: uuidv4(),
      url,
      title,
      visitedAt: now,
    },
    ...historyCache,
  ]);

  await persistHistory();
}

async function updateHistoryEntryTitle(payload: { url?: string; title?: string }): Promise<boolean> {
  const url = payload.url?.trim();
  const title = payload.title?.trim();
  if (!url || !title || title === url) return false;

  const match = historyCache.find((entry) => entry.url === url);
  if (match) {
    if (match.title === title) return false;
    match.title = title;
  } else {
    historyCache = pruneHistory([
      {
        id: uuidv4(),
        url,
        title,
        visitedAt: Date.now(),
      },
      ...historyCache,
    ]);
  }

  await persistHistory();
  return true;
}

async function deleteHistoryEntry(id: string): Promise<boolean> {
  const normalizedId = id.trim();
  if (!normalizedId) return false;

  const next = historyCache.filter((entry) => entry.id !== normalizedId);
  if (next.length === historyCache.length) return false;

  historyCache = next;
  await persistHistory();
  return true;
}

async function clearHistory(): Promise<boolean> {
  if (!historyCache.length) return false;
  historyCache = [];
  await persistHistory();
  return true;
}

function normalizeTabSessionSnapshot(value: unknown): TabSessionSnapshot | null {
  if (typeof value !== 'object' || !value) return null;
  const candidate = value as Record<string, unknown>;

  const id = typeof candidate.id === 'string' ? candidate.id : '';
  const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : url;
  const historyRaw = Array.isArray(candidate.history) ? candidate.history : [];
  const history = historyRaw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!id || !url || !history.length) return null;
  if (!isRestorableSessionTabUrl(url)) return null;

  const historyIndexRaw =
    typeof candidate.historyIndex === 'number' && Number.isFinite(candidate.historyIndex)
      ? Math.floor(candidate.historyIndex)
      : history.length - 1;
  const historyIndex = Math.min(Math.max(historyIndexRaw, 0), history.length - 1);

  return {
    id,
    url,
    title: title || url,
    favicon:
      typeof candidate.favicon === 'string' && candidate.favicon.trim()
        ? candidate.favicon.trim()
        : undefined,
    history,
    historyIndex,
    reloadToken:
      typeof candidate.reloadToken === 'number' && Number.isFinite(candidate.reloadToken)
        ? candidate.reloadToken
        : 0,
    isSleeping: candidate.isSleeping === true,
    lastActiveAt:
      typeof candidate.lastActiveAt === 'number' && Number.isFinite(candidate.lastActiveAt)
        ? candidate.lastActiveAt
        : Date.now(),
  };
}

function normalizeWindowSessionSnapshot(value: unknown): WindowSessionSnapshot | null {
  if (typeof value !== 'object' || !value) return null;
  const candidate = value as Record<string, unknown>;
  const tabsRaw = Array.isArray(candidate.tabs) ? candidate.tabs : [];
  const tabs = tabsRaw
    .map((tab) => normalizeTabSessionSnapshot(tab))
    .filter((tab): tab is TabSessionSnapshot => tab !== null);
  if (!tabs.length) return null;

  const activeIdRaw = typeof candidate.activeId === 'string' ? candidate.activeId : tabs[0].id;
  const activeId = tabs.some((tab) => tab.id === activeIdRaw) ? activeIdRaw : tabs[0].id;

  const boundsCandidate =
    typeof candidate.bounds === 'object' && candidate.bounds
      ? (candidate.bounds as Record<string, unknown>)
      : null;
  const x = typeof boundsCandidate?.x === 'number' ? boundsCandidate.x : NaN;
  const y = typeof boundsCandidate?.y === 'number' ? boundsCandidate.y : NaN;
  const width = typeof boundsCandidate?.width === 'number' ? boundsCandidate.width : NaN;
  const height = typeof boundsCandidate?.height === 'number' ? boundsCandidate.height : NaN;
  const hasValidBounds =
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= 320 &&
    height >= 240;

  return {
    tabs,
    activeId,
    savedAt:
      typeof candidate.savedAt === 'number' && Number.isFinite(candidate.savedAt)
        ? candidate.savedAt
        : Date.now(),
    bounds: hasValidBounds ? { x, y, width, height } : undefined,
    isMaximized: candidate.isMaximized === true,
    isFullScreen: candidate.isFullScreen === true,
  };
}

function normalizeDetachedTabTransferRequest(
  value: unknown,
): {
  tab: TabSessionSnapshot;
  guestInstance?: string;
  webContentsId?: number;
  dragMode?: boolean;
  pointerOffsetX?: number;
  pointerOffsetY?: number;
  x?: number;
  y?: number;
} | null {
  if (typeof value !== 'object' || !value) return null;
  const candidate = value as Record<string, unknown>;
  const tab = normalizeTabSessionSnapshot(candidate.tab);
  if (!tab) return null;

  const guestInstance =
    typeof candidate.guestInstance === 'string' && candidate.guestInstance.trim()
      ? candidate.guestInstance.trim()
      : undefined;
  const webContentsId =
    typeof candidate.webContentsId === 'number' && Number.isFinite(candidate.webContentsId)
      ? Math.floor(candidate.webContentsId)
      : undefined;
  const dragMode = candidate.dragMode === true;
  const pointerOffsetX =
    typeof candidate.pointerOffsetX === 'number' && Number.isFinite(candidate.pointerOffsetX)
      ? Math.max(0, Math.round(candidate.pointerOffsetX))
      : undefined;
  const pointerOffsetY =
    typeof candidate.pointerOffsetY === 'number' && Number.isFinite(candidate.pointerOffsetY)
      ? Math.max(0, Math.round(candidate.pointerOffsetY))
      : undefined;

  const positionCandidate =
    typeof candidate.position === 'object' && candidate.position
      ? (candidate.position as Record<string, unknown>)
      : null;
  const screenX =
    typeof positionCandidate?.screenX === 'number' && Number.isFinite(positionCandidate.screenX)
      ? Math.round(positionCandidate.screenX)
      : undefined;
  const screenY =
    typeof positionCandidate?.screenY === 'number' && Number.isFinite(positionCandidate.screenY)
      ? Math.round(positionCandidate.screenY)
      : undefined;

  return {
    tab,
    guestInstance,
    webContentsId,
    dragMode,
    pointerOffsetX,
    pointerOffsetY,
    x: screenX,
    y: screenY,
  };
}

function mergeRestoreWindowsIntoSingleSnapshot(
  windows: WindowSessionSnapshot[],
): WindowSessionSnapshot | null {
  if (!windows.length) return null;

  const mergedTabs: TabSessionSnapshot[] = [];
  const usedIds = new Set<string>();

  for (const windowSnapshot of windows) {
    for (const tab of windowSnapshot.tabs) {
      const nextId = usedIds.has(tab.id) ? uuidv4() : tab.id;
      usedIds.add(nextId);
      mergedTabs.push({ ...tab, id: nextId });
    }
  }

  if (!mergedTabs.length) return null;

  const preferredActiveId = windows[0]?.activeId ?? mergedTabs[0].id;
  const activeId = mergedTabs.some((tab) => tab.id === preferredActiveId)
    ? preferredActiveId
    : mergedTabs[0].id;

  return {
    tabs: mergedTabs,
    activeId,
    savedAt: Date.now(),
  };
}

function sendDetachedTabBootstrapToWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const pending = pendingDetachedTabTransferByWindowId.get(win.id);
  if (!pending) return;

  try {
    win.webContents.send('window-detached-tab-bootstrap', pending);
  } catch {
    // Ignore send failures during window bootstrap/teardown.
  }
}

function getBuildProductName(): string | null {
  if (cachedBuildProductName !== undefined) return cachedBuildProductName;
  try {
    const raw = readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { build?: { productName?: unknown } };
    const productName =
      typeof parsed?.build?.productName === 'string' ? parsed.build.productName.trim() : '';
    cachedBuildProductName = productName || null;
    return cachedBuildProductName;
  } catch {
    cachedBuildProductName = null;
    return null;
  }
}

function scheduleDetachedTabBootstrapDelivery(win: BrowserWindow): void {
  const scheduleDelivery = () => {
    [60, 180, 420].forEach((delayMs) => {
      const timer = setTimeout(() => {
        sendDetachedTabBootstrapToWindow(win);
      }, delayMs);
      timer.unref();
    });
  };

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', scheduleDelivery);
    return;
  }

  scheduleDelivery();
}

function finalizeDetachedTransferIfReady(transferId: string): boolean {
  const transfer = detachedTabTransferById.get(transferId);
  if (!transfer) return false;
  if (!transfer.attached) return false;
  if (transfer.deferSourceFinalize && !transfer.releaseRequested) return false;

  detachedTabTransferById.delete(transferId);
  pendingDetachedTabTransferByWindowId.delete(transfer.targetWindowId);

  const sourceWindow = BrowserWindow.fromId(transfer.sourceWindowId);
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    sourceWindow.webContents.send('detached-tab-transfer-complete', {
      transferId,
      tabId: transfer.tab.id,
    });
  }
  return true;
}

function stopDetachedWindowDragSession(
  sourceWindowId: number,
  options?: { requestFinalize?: boolean; focusTarget?: boolean },
): boolean {
  const session = activeDetachedWindowDragBySourceWindowId.get(sourceWindowId);
  if (!session) return false;

  clearInterval(session.timer);
  activeDetachedWindowDragBySourceWindowId.delete(sourceWindowId);

  const transfer = detachedTabTransferById.get(session.transferId);
  if (transfer && options?.requestFinalize) {
    transfer.releaseRequested = true;
    finalizeDetachedTransferIfReady(transfer.transferId);
  }

  if (options?.focusTarget) {
    const targetWindow = BrowserWindow.fromId(session.targetWindowId);
    if (targetWindow && !targetWindow.isDestroyed()) {
      if (targetWindow.isMinimized()) targetWindow.restore();
      targetWindow.focus();
    }
  }

  return true;
}

function startDetachedWindowDragSession(
  transfer: DetachedTabTransferPayload,
  pointerOffsetX: number,
  pointerOffsetY: number,
): void {
  stopDetachedWindowDragSession(transfer.sourceWindowId);

  const targetWindow = BrowserWindow.fromId(transfer.targetWindowId);
  if (!targetWindow || targetWindow.isDestroyed()) return;

  const updatePosition = () => {
    if (targetWindow.isDestroyed()) {
      stopDetachedWindowDragSession(transfer.sourceWindowId);
      return;
    }

    const cursorPoint = screen.getCursorScreenPoint();
    const bounds = targetWindow.getBounds();
    const nextX = cursorPoint.x - pointerOffsetX;
    const nextY = cursorPoint.y - pointerOffsetY;
    if (bounds.x === nextX && bounds.y === nextY) return;

    targetWindow.setBounds({
      x: nextX,
      y: nextY,
      width: bounds.width,
      height: bounds.height,
    });
  };

  updatePosition();
  const timer = setInterval(updatePosition, 16);
  timer.unref();

  activeDetachedWindowDragBySourceWindowId.set(transfer.sourceWindowId, {
    transferId: transfer.transferId,
    sourceWindowId: transfer.sourceWindowId,
    targetWindowId: transfer.targetWindowId,
    pointerOffsetX,
    pointerOffsetY,
    timer,
  });
}

function collectPersistedSessionSnapshot(): PersistedSessionSnapshot | null {
  const windows = Array.from(windowSessionCache.values())
    .filter((entry) => entry.tabs.length > 0)
    .sort((a, b) => b.savedAt - a.savedAt);
  if (!windows.length) return null;
  return { windows, savedAt: Date.now() };
}

async function persistSessionSnapshot(): Promise<void> {
  const snapshot = collectPersistedSessionSnapshot();
  if (!snapshot) {
    await clearPersistedSessionSnapshot();
    return;
  }
  await fs.writeFile(getSessionFilePath(), JSON.stringify(snapshot, null, 2), 'utf-8');
}

function persistSessionSnapshotSync(): void {
  const snapshot = collectPersistedSessionSnapshot();
  if (!snapshot) {
    try {
      unlinkSync(getSessionFilePath());
    } catch {
      // Ignore missing session snapshot file.
    }
    return;
  }

  try {
    writeFileSync(getSessionFilePath(), JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch {
    // Ignore sync persistence failures during shutdown.
  }
}

function scheduleSessionPersist(): void {
  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer);
  }
  sessionPersistTimer = setTimeout(() => {
    void persistSessionSnapshot();
    sessionPersistTimer = null;
  }, 300);
  sessionPersistTimer.unref();
}

async function loadPersistedSessionSnapshot(): Promise<void> {
  try {
    const raw = await fs.readFile(getSessionFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || !parsed) return;
    const candidate = parsed as Record<string, unknown>;
    const windowsRaw = Array.isArray(candidate.windows) ? candidate.windows : [];
    const windows = windowsRaw
      .map((entry) => normalizeWindowSessionSnapshot(entry))
      .filter((entry): entry is WindowSessionSnapshot => entry !== null);
    if (!windows.length) return;
    pendingRestoreSession = {
      windows,
      savedAt:
        typeof candidate.savedAt === 'number' && Number.isFinite(candidate.savedAt)
          ? candidate.savedAt
          : Date.now(),
    };
  } catch {
    pendingRestoreSession = null;
  }
}

async function clearPersistedSessionSnapshot(): Promise<void> {
  try {
    await fs.unlink(getSessionFilePath());
  } catch {
    // Ignore missing session snapshot file.
  }
}

function normalizeSemver(rawVersion: string): string {
  return rawVersion.trim().replace(/^[vV]/, '');
}

function parseSemverParts(rawVersion: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
} | null {
  const normalized = normalizeSemver(rawVersion);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemverParts(left);
  const b = parseSemverParts(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease > b.prerelease ? 1 : -1;
}

function pickInstallerAsset(release: GitHubRelease): GitHubReleaseAsset | null {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  if (!assets.length) return null;

  if (process.platform === 'win32') {
    const setup = assets.find(
      (asset) =>
        typeof asset.name === 'string' &&
        asset.name.toLowerCase().includes('-win-setup.') &&
        asset.name.toLowerCase().endsWith('.exe'),
    );
    return setup ?? null;
  }

  if (process.platform === 'darwin') {
    const archToken = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : '';
    const hasMacArchToken = (assetName: string): boolean => {
      if (!archToken) return false;
      const normalized = assetName.toLowerCase();
      return normalized.includes(`-mac-${archToken}.`);
    };

    const macArchDmg = assets.find(
      (asset) =>
        typeof asset.name === 'string' &&
        asset.name.toLowerCase().endsWith('.dmg') &&
        hasMacArchToken(asset.name),
    );
    if (macArchDmg) return macArchDmg;

    const macArchZip = assets.find(
      (asset) =>
        typeof asset.name === 'string' &&
        asset.name.toLowerCase().endsWith('.zip') &&
        hasMacArchToken(asset.name),
    );
    if (macArchZip) return macArchZip;

    // Fallback for older/renamed assets that do not include explicit arch tokens.
    const dmg = assets.find(
      (asset) => typeof asset.name === 'string' && asset.name.toLowerCase().endsWith('.dmg'),
    );
    if (dmg) return dmg;
    const zip = assets.find(
      (asset) => typeof asset.name === 'string' && asset.name.toLowerCase().endsWith('.zip'),
    );
    return zip ?? null;
  }

  if (process.platform === 'linux') {
    const archTokens =
      process.arch === 'arm64'
        ? ['arm64', 'aarch64']
        : process.arch === 'x64'
          ? ['x86_64', 'amd64', 'x64']
          : [];

    const hasArchToken = (assetName: string): boolean => {
      if (!archTokens.length) return false;
      const normalized = assetName.toLowerCase();
      return archTokens.some((token) => normalized.includes(token));
    };

    const pickByExtension = (extension: string): GitHubReleaseAsset | null => {
      const archMatch = assets.find(
        (asset) =>
          typeof asset.name === 'string' &&
          asset.name.toLowerCase().endsWith(extension) &&
          hasArchToken(asset.name),
      );
      if (archMatch) return archMatch;

      const genericMatch = assets.find(
        (asset) => typeof asset.name === 'string' && asset.name.toLowerCase().endsWith(extension),
      );
      return genericMatch ?? null;
    };

    return pickByExtension('.appimage') ?? pickByExtension('.deb') ?? pickByExtension('.rpm');
  }

  return null;
}

function pickPortableAsset(release: GitHubRelease): GitHubReleaseAsset | null {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  if (!assets.length) return null;

  if (process.platform === 'win32') {
    const portable = assets.find(
      (asset) =>
        typeof asset.name === 'string' &&
        asset.name.toLowerCase().includes('-win.') &&
        !asset.name.toLowerCase().includes('-win-setup.') &&
        asset.name.toLowerCase().endsWith('.exe'),
    );
    return portable ?? null;
  }

  return null;
}

async function fetchReleases(includePrerelease: boolean): Promise<GitHubRelease[]> {
  const response = await fetch(GITHUB_RELEASES_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mira-updater',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to check updates (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) return [];

  const releases = payload.filter((entry): entry is GitHubRelease => typeof entry === 'object' && !!entry);
  return releases
    .filter((release) => !release.draft)
    .filter((release) => includePrerelease || !release.prerelease);
}

function pickLatestRelease(releases: GitHubRelease[]): GitHubRelease | null {
  if (!releases.length) return null;

  const sorted = [...releases].sort((left, right) => {
    const leftTag = typeof left.tag_name === 'string' ? left.tag_name : '';
    const rightTag = typeof right.tag_name === 'string' ? right.tag_name : '';
    const semverComparison = compareSemver(leftTag, rightTag);
    if (semverComparison !== 0) return -semverComparison;

    const leftPublished = Date.parse(left.published_at ?? '');
    const rightPublished = Date.parse(right.published_at ?? '');
    return Number.isFinite(rightPublished) && Number.isFinite(leftPublished)
      ? rightPublished - leftPublished
      : 0;
  });
  return sorted[0] ?? null;
}

function canAutoInstallUpdatesOnLaunch(): boolean {
  const isSupportedPlatform =
    process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
  if (!isSupportedPlatform) return false;
  if (!app.isPackaged || process.defaultApp) return false;
  if (isPortableBuild) return false;
  return true;
}

async function checkForUpdates(includePrerelease: boolean): Promise<UpdateCheckResult | null> {
  const releases = await fetchReleases(includePrerelease);
  const latestRelease = pickLatestRelease(releases);
  if (!latestRelease) return null;

  const latestTag = typeof latestRelease.tag_name === 'string' ? latestRelease.tag_name : '';
  const latestVersion = normalizeSemver(latestTag);
  const currentVersion = normalizeSemver(app.getVersion());
  const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;

  const mode: 'portable' | 'installer' = isPortableBuild ? 'portable' : 'installer';
  const asset = mode === 'portable' ? pickPortableAsset(latestRelease) : pickInstallerAsset(latestRelease);
  if (!asset?.name || !asset.browser_download_url) {
    return null;
  }

  return {
    mode,
    currentVersion,
    latestVersion,
    latestIsPrerelease: latestRelease.prerelease === true,
    hasUpdate,
    releaseName: latestRelease.name?.trim() || latestTag || latestVersion,
    assetName: asset.name,
    downloadUrl: asset.browser_download_url,
  };
}

async function downloadAssetToDownloads(downloadUrl: string, assetName: string): Promise<string> {
  const response = await fetch(downloadUrl, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'mira-updater',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Failed to download update (HTTP ${response.status}).`);
  }

  const fileBuffer = Buffer.from(await response.arrayBuffer());
  const targetPath = path.join(app.getPath('downloads'), assetName);
  await fs.writeFile(targetPath, fileBuffer);
  return targetPath;
}

function normalizeKilobytes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function getComparableProcessMemoryKb(memory: Record<string, unknown>): number | null {
  const workingSetKb = normalizeKilobytes(memory.workingSetSize ?? memory.residentSet);
  const sharedKb = normalizeKilobytes(memory.sharedBytes);
  if (workingSetKb !== null && sharedKb !== null) {
    return Math.max(workingSetKb - sharedKb, 0);
  }

  // Fallback for platforms/versions that expose only private-style metrics.
  const privateKb = normalizeKilobytes(memory.privateBytes ?? memory.private);
  if (privateKb !== null) return privateKb;

  return workingSetKb;
}

function setupPerformanceHandlers() {
  ipcMain.handle('perf-memory-snapshot', async () => {
    try {
      const metrics = app.getAppMetrics();
      let totalComparableKb = 0;

      for (const metric of metrics) {
        if (typeof metric.memory !== 'object' || metric.memory === null) continue;
        const memory = metric.memory as Record<string, unknown>;
        const comparableKb = getComparableProcessMemoryKb(memory);
        if (comparableKb !== null) {
          totalComparableKb += comparableKb;
        }
      }

      return {
        totalMemoryMb: totalComparableKb > 0 ? totalComparableKb / 1024 : null,
      };
    } catch {
      return {
        totalMemoryMb: null,
      };
    }
  });
}

function setupHistoryHandlers() {
  ipcMain.handle('history-add', async (_, payload: { url?: string; title?: string }) => {
    await addHistoryEntry(payload ?? {});
    return true;
  });

  ipcMain.handle('history-list', async () => {
    historyCache = pruneHistory(historyCache);
    await persistHistory();
    return historyCache;
  });

  ipcMain.handle('history-update-title', async (_, payload: { url?: string; title?: string }) => {
    return updateHistoryEntryTitle(payload ?? {});
  });

  ipcMain.handle('history-delete', async (_, id: string) => {
    return deleteHistoryEntry(typeof id === 'string' ? id : '');
  });

  ipcMain.handle('history-clear', async () => {
    return clearHistory();
  });
}

function setupDownloadHandlers() {
  const ses = session.defaultSession;

  const pickTargetWindow = (downloadId: string, sourceContents?: WebContents | null): BrowserWindow | null => {
    const sourceWindowId = downloadWindowById.get(downloadId);
    const sourceWindow = sourceWindowId ? BrowserWindow.fromId(sourceWindowId) : null;
    if (sourceWindow && !sourceWindow.isDestroyed()) return sourceWindow;

    const sourceFromContents = sourceContents ? BrowserWindow.fromWebContents(sourceContents) : null;
    if (sourceFromContents && !sourceFromContents.isDestroyed()) return sourceFromContents;

    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && !focusedWindow.isDestroyed()) return focusedWindow;

    const firstAliveWindow = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
    return firstAliveWindow;
  };

  const sendDownloadEvent = (
    downloadId: string,
    channel: string,
    payload: Record<string, unknown>,
    sourceContents?: WebContents | null,
  ) => {
    const targetWindow = pickTargetWindow(downloadId, sourceContents);
    if (!targetWindow) return;
    targetWindow.webContents.send(channel, payload);
  };

  // Every download gets a UUID so the renderer can track it
  ses.on('will-download', (event, item, webContents) => {
    const downloadId = uuidv4(); // unique id for this download
    const filename = item.getFilename();
    const sourceWindow = BrowserWindow.fromWebContents(webContents ?? event.sender);

    // Store the download item so we can cancel it later
    downloadMap.set(downloadId, item);
    if (sourceWindow && !sourceWindow.isDestroyed()) {
      downloadWindowById.set(downloadId, sourceWindow.id);
    }

    // Tell the renderer a new download started
    sendDownloadEvent(
      downloadId,
      'download-start',
      {
      id: downloadId,
      url: item.getURL(),
      filename,
      totalBytes: item.getTotalBytes(),
      },
      webContents ?? event.sender,
    );

    // Progress updates
    item.on('updated', (_, state) => {
      if (state === 'interrupted') {
        sendDownloadEvent(downloadId, 'download-error', {
          id: downloadId,
          error: 'interrupted',
        });
        return;
      }
      sendDownloadEvent(downloadId, 'download-progress', {
        id: downloadId,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      });
    });

    // Finished
    item.once('done', (e, state) => {
      // Clean up the map
      downloadMap.delete(downloadId);
      downloadWindowById.delete(downloadId);

      if (state === 'completed') {
        sendDownloadEvent(downloadId, 'download-done', {
          id: downloadId,
          savePath: item.getSavePath(),
        });
      } else {
        sendDownloadEvent(downloadId, 'download-error', {
          id: downloadId,
          error: state,
        });
      }
    });

    // Make the save dialog appear (optional)
    // item.setSaveDialogOptions({ title: 'Save file' });
  });

  // Renderer wants to cancel a download
  ipcMain.handle('download-cancel', async (_, id: string) => {
    const item = downloadMap.get(id);
    if (item && item.getState() === 'progressing') {
      item.cancel();
      downloadMap.delete(id);
      downloadWindowById.delete(id);
      return true;
    }
    return false;
  });

  // Open file/folder from renderer
  ipcMain.handle('download-open', async (_, savePath: string) => {
    await shell.showItemInFolder(savePath);
  });

  // Open file directly from renderer
  ipcMain.handle('download-open-file', async (_, savePath: string) => {
    await shell.openPath(savePath);
  });
}

function setupVersionExposure() {
  const miraVersion = getMiraVersion();
  process.env.MIRA_VERSION = miraVersion;

  const ses = session.defaultSession;
  const baseUserAgent = ses.getUserAgent();
  const miraUserAgent = buildMiraUserAgent(baseUserAgent);
  if (miraUserAgent !== baseUserAgent) {
    ses.setUserAgent(miraUserAgent);
  }
  app.userAgentFallback = miraUserAgent;

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url || '';
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    const headers = { ...details.requestHeaders };
    headers['X-Mira-Version'] = miraVersion;
    headers['Sec-CH-UA'] = getSecChUaHeader(miraVersion);
    headers['Sec-CH-UA-Full-Version-List'] = getSecChUaFullVersionListHeader(miraVersion);
    headers['Sec-CH-UA-Platform'] = `"${getChPlatform()}"`;
    headers['Sec-CH-UA-Platform-Version'] = `"${getChPlatformVersion()}"`;
    headers['Sec-CH-UA-Mobile'] = '?0';

    callback({ requestHeaders: headers });
  });
}

function setupVersionHandlers() {
  ipcMain.handle('app-get-version', () => getMiraVersion());
}

function prepareWebviewHistoryRestore(params: { src?: string }): void {
  // History must be imported before even an about:blank page is committed.
  if (params.src === 'about:blank#mira-restore-history') params.src = '';
}

function setupWebviewTabOpenHandler() {
  app.on('web-contents-created', (_, contents) => {
    if (contents.getType() === 'webview') {
      let pendingUrl = '';
      let startedAt = 0;
      contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return;
        pendingUrl = url;
        startedAt = Date.now();
      });
      contents.on('did-redirect-navigation', (_event, url, _isInPlace, isMainFrame) => {
        if (isMainFrame) pendingUrl = url;
      });
      contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId) => {
        if (!isMainFrame || errorCode === 0 || errorCode === -3) return;
        logDebug('navigation', 'main-frame-failed-load', {
          webContentsId: contents.id,
          frameProcessId,
          frameRoutingId,
          errorCode,
          errorDescription,
          failedUrl: navigationLogUrl(validatedURL),
          pendingUrl: navigationLogUrl(pendingUrl),
          committedUrl: navigationLogUrl(contents.getURL()),
          elapsedMs: startedAt ? Date.now() - startedAt : null,
          isLoading: contents.isLoadingMainFrame(),
        });
      });
    }
    if (contents.getType() !== 'devtools') {
      const currentUserAgent = contents.getUserAgent();
      const sanitized = buildMiraUserAgent(currentUserAgent);
      if (sanitized && sanitized !== currentUserAgent) {
        contents.setUserAgent(sanitized);
      }
    }

    if (contents.getType() === 'window') {
      contents.on('will-attach-webview', (_event, webPreferences, params) => {
        prepareWebviewHistoryRestore(params);
        // Lock guest pages to our trusted preload and current sandbox defaults.
        webPreferences.preload = path.join(__dirname, 'webview-preload.js');
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
      });
    }

    contents.once('destroyed', () => {
      const pendingCloseRequest = pendingWebviewCloseRequestsByWebContentsId.get(contents.id);
      if (!pendingCloseRequest) return;
      pendingWebviewCloseRequestsByWebContentsId.delete(contents.id);

      const hostWindow = pendingCloseRequest.hostWindowId !== null
        ? BrowserWindow.fromId(pendingCloseRequest.hostWindowId)
        : null;
      if (!hostWindow || hostWindow.isDestroyed()) return;

      if (pendingCloseRequest.type === 'tab') {
        hostWindow.webContents.send('webview-close-result', {
          tabId: pendingCloseRequest.tabId,
          closed: true,
        });
        return;
      }

      windowSessionCache.delete(hostWindow.id);
      scheduleSessionPersist();
      hostWindow.close();
    });

    contents.on('will-prevent-unload', (event) => {
      const hostWindow = getHostWindowForContents(contents);
      const siteLabel = getSiteDisplayLabel(contents.getURL());
      const response = showMessageBoxSyncForWindow(hostWindow, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Leave Site?',
        message: 'Leave this site?',
        detail: `${siteLabel} says changes you made may not be saved.`,
      });
      const allowUnload = response === 0;
      if (allowUnload) {
        event.preventDefault();
      }

      const pendingCloseRequest = pendingWebviewCloseRequestsByWebContentsId.get(contents.id);
      if (pendingCloseRequest && !allowUnload) {
        pendingWebviewCloseRequestsByWebContentsId.delete(contents.id);
        if (hostWindow && !hostWindow.isDestroyed() && pendingCloseRequest.type === 'tab') {
          hostWindow.webContents.send('webview-close-result', {
            tabId: pendingCloseRequest.tabId,
            closed: false,
          });
        }
      }
    });

    contents.on('will-navigate', (event, url) => {
      const normalizedMailtoUrl = normalizeMailtoUrl(url);
      if (!normalizedMailtoUrl) return;

      event.preventDefault();
      const host = getHostWebContents(contents);
      if (!host || host.isDestroyed()) return;
      host.send('open-url-in-new-tab', {
        url: normalizedMailtoUrl,
        sourceWebContentsId: contents.id,
      });
    });

    contents.on('before-input-event', (event, input) => {
      const host = contents.hostWebContents;
      if (!host) return;
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      const key = input.key.toLowerCase();
      const hasPrimaryModifier = input.control || input.meta;
      const isPrimaryChord = hasPrimaryModifier && !input.shift;
      const historyKey = isMacOS ? 'y' : 'h';
      const isNewTabChord = isPrimaryChord && key === 't';
      const isNewWindowChord = isPrimaryChord && key === 'n';
      const isFindChord = isPrimaryChord && key === 'f';
      const isFindNextChord = isPrimaryChord && key === 'g';
      const isFindPreviousChord = hasPrimaryModifier && input.shift && key === 'g';
      const isNextTabChord = isPrimaryChord && key === 'tab';
      const isPreviousTabChord = hasPrimaryModifier && input.shift && key === 'tab';
      const tabNumberShortcut = isPrimaryChord && /^[1-9]$/.test(key)
        ? Number.parseInt(key, 10)
        : null;
      const isHistoryChord = isPrimaryChord && key === historyKey;
      const isOpenBookmarksChord = hasPrimaryModifier && input.shift && key === 'o';
      const isBookmarkPageChord = isPrimaryChord && key === 'd';
      const isBookmarkAllTabsChord = hasPrimaryModifier && input.shift && key === 'd';
      const isToggleBookmarksBarChord = hasPrimaryModifier && input.shift && key === 'b';
      const isDownloadsChord = isPrimaryChord && key === 'j';
      const isPrintChord = isPrimaryChord && key === 'p';
      const isReopenClosedTabChord = hasPrimaryModifier && input.shift && key === 't';
      const isCloseTabChord = isPrimaryChord && key === 'w';
      const isCloseWindowChord = hasPrimaryModifier && input.shift && key === 'w';
      const isMoveTabLeftChord = hasPrimaryModifier && input.shift && key === 'pageup';
      const isMoveTabRightChord = hasPrimaryModifier && input.shift && key === 'pagedown';
      const isBackChord = !hasPrimaryModifier && input.alt && !input.shift && key === 'arrowleft';
      const isForwardChord = !hasPrimaryModifier && input.alt && !input.shift && key === 'arrowright';
      const isNewTabPageChord = !hasPrimaryModifier && input.alt && !input.shift && key === 'home';
      const isFocusAddressBarChord =
        (isPrimaryChord && key === 'l')
        || (!hasPrimaryModifier && input.alt && !input.shift && key === 'd')
        || (!hasPrimaryModifier && !input.alt && !input.shift && key === 'f6');
      const isReloadChord = isPrimaryChord && key === 'r';
      const isReloadFunctionChord = !hasPrimaryModifier && !input.alt && !input.shift && key === 'f5';
      const isHardReloadChord = hasPrimaryModifier && input.shift && key === 'r';
      const isHardReloadFunctionChord = hasPrimaryModifier && key === 'f5';
      const isStopLoadingKey = !hasPrimaryModifier && !input.alt && !input.shift && key === 'escape';
      const isSavePageChord = isPrimaryChord && key === 's';
      const isOpenFileChord = isPrimaryChord && key === 'o';
      const isViewSourceChord = isPrimaryChord && key === 'u';
      const isZoomInChord = hasPrimaryModifier && !input.alt && (key === '+' || key === '=');
      const isZoomOutChord = isPrimaryChord && key === '-';
      const isZoomResetChord = isPrimaryChord && key === '0';
      const isToggleFullScreenKey = !hasPrimaryModifier && !input.alt && !input.shift && key === 'f11';
      const isAppDevToolsChord = hasPrimaryModifier && input.alt && input.shift && key === 'j';
      const isBrowserConsoleChord = isMacOS
        ? input.meta && input.alt && key === 'j'
        : hasPrimaryModifier && input.shift && key === 'j';
      const isDevToolsChord = key === 'f12' || isBrowserConsoleChord || (isMacOS
        ? input.meta && input.alt && key === 'i'
        : (input.meta && input.shift && key === 'i') || (input.control && input.shift && key === 'i'));

      const hostWindow = BrowserWindow.fromWebContents(host);
      if (!hostWindow || hostWindow.isDestroyed()) return;

      if (
        !isNewTabChord
        && !isNewWindowChord
        && !isFindChord
        && !isFindNextChord
        && !isFindPreviousChord
        && !isNextTabChord
        && !isPreviousTabChord
        && tabNumberShortcut === null
        && !isHistoryChord
        && !isOpenBookmarksChord
        && !isBookmarkPageChord
        && !isBookmarkAllTabsChord
        && !isToggleBookmarksBarChord
        && !isDownloadsChord
        && !isPrintChord
        && !isReopenClosedTabChord
        && !isCloseTabChord
        && !isCloseWindowChord
        && !isMoveTabLeftChord
        && !isMoveTabRightChord
        && !isBackChord
        && !isForwardChord
        && !isNewTabPageChord
        && !isFocusAddressBarChord
        && !isReloadChord
        && !isReloadFunctionChord
        && !isHardReloadChord
        && !isHardReloadFunctionChord
        && !isStopLoadingKey
        && !isSavePageChord
        && !isOpenFileChord
        && !isViewSourceChord
        && !isZoomInChord
        && !isZoomOutChord
        && !isZoomResetChord
        && !isToggleFullScreenKey
        && !isDevToolsChord
        && !isAppDevToolsChord
      ) return;

      event.preventDefault();

      if (isNewTabChord) {
        hostWindow.webContents.send('app-shortcut', 'new-tab');
        return;
      }

      if (isAppDevToolsChord) {
        logDebug('shortcut', 'app-devtools-shortcut-from-webview', {
          windowId: hostWindow.id,
          key,
          control: input.control,
          meta: input.meta,
          alt: input.alt,
          shift: input.shift,
        });
        toggleWindowDevTools(hostWindow);
        return;
      }

      if (isDevToolsChord) {
        if (toggleFocusedBrowserDevTools()) return;
        markHostDevToolsSuppressedForShortcut(hostWindow);
        hostWindow.webContents.send('app-shortcut', 'toggle-devtools');
        return;
      }

      if (isFindChord) {
        hostWindow.webContents.send('app-shortcut', 'find-in-page');
        return;
      }

      if (isFindNextChord) {
        hostWindow.webContents.send('app-shortcut', 'find-next');
        return;
      }

      if (isFindPreviousChord) {
        hostWindow.webContents.send('app-shortcut', 'find-previous');
        return;
      }

      if (isNextTabChord) {
        hostWindow.webContents.send('app-shortcut', 'activate-next-tab');
        return;
      }

      if (isPreviousTabChord) {
        hostWindow.webContents.send('app-shortcut', 'activate-previous-tab');
        return;
      }

      if (tabNumberShortcut !== null) {
        hostWindow.webContents.send('app-shortcut', 'activate-tab-index', tabNumberShortcut);
        return;
      }

      if (isHistoryChord) {
        hostWindow.webContents.send('app-shortcut', 'open-history');
        return;
      }

      if (isOpenBookmarksChord) {
        hostWindow.webContents.send('app-shortcut', 'open-bookmarks');
        return;
      }

      if (isBookmarkPageChord) {
        hostWindow.webContents.send('app-shortcut', 'bookmark-current-page');
        return;
      }

      if (isBookmarkAllTabsChord) {
        hostWindow.webContents.send('app-shortcut', 'bookmark-all-tabs');
        return;
      }

      if (isToggleBookmarksBarChord) {
        hostWindow.webContents.send('app-shortcut', 'toggle-bookmarks-bar');
        return;
      }

      if (isDownloadsChord) {
        hostWindow.webContents.send('app-shortcut', 'open-downloads');
        return;
      }

      if (isPrintChord) {
        hostWindow.webContents.send('app-shortcut', 'print-page');
        return;
      }

      if (isReopenClosedTabChord) {
        hostWindow.webContents.send('app-shortcut', 'reopen-closed-tab');
        return;
      }

      if (isCloseTabChord) {
        hostWindow.webContents.send('app-shortcut', 'close-tab');
        return;
      }

      if (isCloseWindowChord) {
        hostWindow.webContents.send('app-shortcut', 'close-window');
        return;
      }

      if (isMoveTabLeftChord) {
        hostWindow.webContents.send('app-shortcut', 'move-active-tab-left');
        return;
      }

      if (isMoveTabRightChord) {
        hostWindow.webContents.send('app-shortcut', 'move-active-tab-right');
        return;
      }

      if (isBackChord) {
        hostWindow.webContents.send('app-shortcut', 'go-back');
        return;
      }

      if (isForwardChord) {
        hostWindow.webContents.send('app-shortcut', 'go-forward');
        return;
      }

      if (isNewTabPageChord) {
        hostWindow.webContents.send('app-shortcut', 'navigate-new-tab-page');
        return;
      }

      if (isFocusAddressBarChord) {
        hostWindow.webContents.send('app-shortcut', 'focus-address-bar');
        return;
      }

      if (isHardReloadChord || isHardReloadFunctionChord) {
        hostWindow.webContents.send('app-shortcut', 'reload-tab-ignore-cache');
        return;
      }

      if (isReloadChord || isReloadFunctionChord) {
        hostWindow.webContents.send('app-shortcut', 'reload-tab');
        return;
      }

      if (isStopLoadingKey) {
        hostWindow.webContents.send('app-shortcut', 'stop-loading');
        return;
      }

      if (isSavePageChord) {
        hostWindow.webContents.send('app-shortcut', 'save-page');
        return;
      }

      if (isOpenFileChord) {
        hostWindow.webContents.send('app-shortcut', 'open-file');
        return;
      }

      if (isViewSourceChord) {
        hostWindow.webContents.send('app-shortcut', 'view-source');
        return;
      }

      if (isZoomInChord) {
        hostWindow.webContents.send('app-shortcut', 'zoom-in');
        return;
      }

      if (isZoomOutChord) {
        hostWindow.webContents.send('app-shortcut', 'zoom-out');
        return;
      }

      if (isZoomResetChord) {
        hostWindow.webContents.send('app-shortcut', 'zoom-reset');
        return;
      }

      if (isToggleFullScreenKey) {
        hostWindow.webContents.send('app-shortcut', 'toggle-fullscreen');
        return;
      }

      triggerNewWindowFromShortcut(hostWindow);
    });

    contents.setWindowOpenHandler(({ url, disposition, features }) => {
      const host = getHostWebContents(contents);
      if (!host) return { action: 'deny' };
      const normalized = (url ?? '').trim();
      const normalizedFeatures = typeof features === 'string' ? features.trim() : '';
      const hostWindow = BrowserWindow.fromWebContents(host);
      if (!normalized) {
        return { action: 'deny' };
      }

      const normalizedMailtoUrl = normalizeMailtoUrl(normalized);
      if (normalizedMailtoUrl) {
        host.send('open-url-in-new-tab', {
          url: normalizedMailtoUrl,
          sourceWebContentsId: contents.id,
          disposition,
        });
        return { action: 'deny' };
      }

      if (
        isExplicitPopupRequest({
          disposition,
          features: normalizedFeatures,
        })
      ) {
        return {
          action: 'allow',
          createWindow: (options) => {
            const popupWindow = new BrowserWindow({
              ...options,
              parent:
                hostWindow && !hostWindow.isDestroyed()
                  ? hostWindow
                  : options.parent,
              modal: false,
              autoHideMenuBar: true,
              backgroundColor: '#12161d',
              show: true,
            });

            popupWindow.setMenuBarVisibility(false);
            popupWindow.on('closed', () => {
              if (hostWindow && !hostWindow.isDestroyed()) {
                hostWindow.focus();
              }
            });

            return popupWindow.webContents;
          },
        };
      }

      if (normalized === 'about:blank') {
        return { action: 'deny' };
      }

      const now = Date.now();
      const last = recentOpenTabByHost.get(host.id);
      const isDuplicate =
        !!last && last.url === normalized && now - last.openedAt < OPEN_TAB_DEDUPE_WINDOW_MS;

      if (host && !host.isDestroyed() && !isDuplicate) {
        recentOpenTabByHost.set(host.id, { url: normalized, openedAt: now });
        host.send('open-url-in-new-tab', {
          url: normalized,
          sourceWebContentsId: contents.id,
          disposition,
        });
      }
      return { action: 'deny' };
    });
  });
}

function isFirstPartyStorageAccess(permission: string, requestingUrl: string, topLevelUrl: string): boolean {
  if (permission !== 'storage-access') return false;
  try {
    const requester = new URL(requestingUrl);
    const topLevel = new URL(topLevelUrl);
    return (requester.protocol === 'https:' || requester.protocol === 'http:')
      && requester.origin === topLevel.origin;
  } catch {
    return false;
  }
}

function setupSitePermissionHandlers() {
  const ses = session.defaultSession;

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const origin = extractPermissionOrigin(webContents, {
      requestingUrl: details.requestingUrl,
      securityOrigin: details.securityOrigin || requestingOrigin,
    });
    if (!origin) return false;

    const permissionIds = mapPermissionIdsFromDetails(permission, {
      mediaType: details.mediaType,
    });
    const decision = summarizeSitePermissionDecision(origin, permissionIds);
    if (decision !== 'ask') return decision === 'allow';
    return isFirstPartyStorageAccess(
      permission,
      details.requestingUrl || requestingOrigin,
      webContents?.getURL() ?? '',
    );
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = extractPermissionOrigin(webContents, {
      requestingUrl: details.requestingUrl,
      securityOrigin: 'securityOrigin' in details ? details.securityOrigin : undefined,
      externalURL: 'externalURL' in details ? details.externalURL : undefined,
    });
    if (!origin) {
      callback(false);
      return;
    }

    const permissionIds = mapPermissionIdsFromDetails(permission, {
      mediaType: 'mediaType' in details ? details.mediaType : undefined,
      mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
    });
    if (!permissionIds.length) {
      callback(false);
      return;
    }

    const storedDecision = summarizeSitePermissionDecision(origin, permissionIds);
    if (storedDecision === 'allow') {
      callback(true);
      return;
    }
    if (storedDecision === 'block') {
      callback(false);
      return;
    }

    const topLevelUrl = webContents.getURL();
    const topLevelOrigin = normalizeSitePermissionOrigin(topLevelUrl);
    if (permissionIds.includes('storage-access')) {
      // Resolve cookie access silently without changing an unset permission.
      callback(isFirstPartyStorageAccess(permission, details.requestingUrl, topLevelUrl));
      return;
    }

    const hostWindow = getHostWindowForContents(webContents);
    if (!hostWindow || hostWindow.isDestroyed()) {
      callback(false);
      return;
    }

    const requestId = uuidv4();
    pendingSitePermissionRequests.set(requestId, {
      callback,
      origin,
      permissionIds,
      hostWindowId: hostWindow.id,
    });

    hostWindow.webContents.send('site-permission-request', {
      requestId,
      webContentsId: webContents.id,
      origin,
      topLevelOrigin,
      siteLabel: getSiteDisplayLabel(origin),
      label: describeSitePermissionRequest(permissionIds),
      permissionIds,
      url: typeof details.requestingUrl === 'string' ? details.requestingUrl : webContents.getURL(),
    });
  });

  ipcMain.handle('site-permissions-get', (_event, rawValue: unknown) => {
    const target = typeof rawValue === 'string' ? rawValue.trim() : '';
    const origin = normalizeSitePermissionOrigin(target);
    return origin ? buildSitePermissionsSnapshot(origin) : {
      canManage: false,
      origin: '',
      siteLabel: '',
      permissions: [],
    };
  });

  ipcMain.handle('site-permissions-update', async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) {
      return {
        ok: false,
        snapshot: {
          canManage: false,
          origin: '',
          siteLabel: '',
          permissions: [],
        },
      };
    }

    const origin = typeof payload.origin === 'string' ? payload.origin.trim() : '';
    const permissionId = payload.permissionId;
    const decision = normalizeSitePermissionSetting(payload.decision);
    const normalizedOrigin = normalizeSitePermissionOrigin(origin);
    if (!normalizedOrigin || !isSitePermissionId(permissionId)) {
      return {
        ok: false,
        snapshot: {
          canManage: false,
          origin: '',
          siteLabel: '',
          permissions: [],
        },
      };
    }

    writeSitePermissionSetting(normalizedOrigin, permissionId, decision);
    await persistSitePermissions().catch(() => undefined);
    return {
      ok: true,
      snapshot: buildSitePermissionsSnapshot(normalizedOrigin),
    };
  });

  ipcMain.handle('site-permission-request-respond', async (event, payload: unknown) => {
    if (!isObjectRecord(payload)) return { ok: false };

    const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
    const decision = payload.decision;
    if (decision !== 'allow' && decision !== 'block' && decision !== 'dismiss') return { ok: false };
    if (!requestId) return { ok: false };

    const pendingRequest = pendingSitePermissionRequests.get(requestId);
    if (!pendingRequest) return { ok: false };
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.id !== pendingRequest.hostWindowId) return { ok: false };

    pendingSitePermissionRequests.delete(requestId);
    if (decision === 'dismiss') {
      pendingRequest.callback(false);
      return { ok: true, snapshot: buildSitePermissionsSnapshot(pendingRequest.origin) };
    }
    for (const permissionId of pendingRequest.permissionIds) {
      writeSitePermissionSetting(pendingRequest.origin, permissionId, decision);
    }
    await persistSitePermissions().catch(() => undefined);
    pendingRequest.callback(decision === 'allow');

    return {
      ok: true,
      snapshot: buildSitePermissionsSnapshot(pendingRequest.origin),
    };
  });

  // Global site permissions management handlers
  ipcMain.handle('site-permissions-get-all', () => {
    const origins = Object.keys(persistedSitePermissions).sort();
    return {
      ok: true,
      origins: origins.map((origin) => ({
        origin,
        siteLabel: getSiteDisplayLabel(origin),
        permissions: SITE_SETTINGS_PERMISSION_ORDER.map((permissionId) => ({
          id: permissionId,
          label: SITE_PERMISSION_LABELS[permissionId],
          decision: readSitePermissionSetting(origin, permissionId),
        })).filter((p) => p.decision !== 'ask'),
      })).filter((site) => site.permissions.length > 0),
    };
  });

  ipcMain.handle('site-permissions-delete', async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) return { ok: false };

    const origin = typeof payload.origin === 'string' ? payload.origin.trim() : '';
    const normalizedOrigin = normalizeSitePermissionOrigin(origin);
    if (!normalizedOrigin) return { ok: false };

    delete persistedSitePermissions[normalizedOrigin];
    await persistSitePermissions().catch(() => undefined);
    return { ok: true };
  });

  ipcMain.handle('site-permissions-delete-all', async () => {
    persistedSitePermissions = {};
    await persistSitePermissions().catch(() => undefined);
    return { ok: true };
  });

  // Cookie management handlers
  ipcMain.handle('cookies-get-all', async () => {
    try {
      const ses = session.defaultSession;
      const cookies = await ses.cookies.get({});
      
      // Group cookies by origin
      const originsMap = new Map<string, { origin: string; siteLabel: string; cookieCount: number }>();
      
      for (const cookie of cookies) {
        const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        const origin = domain.toLowerCase();
        
        if (!originsMap.has(origin)) {
          originsMap.set(origin, {
            origin,
            siteLabel: getSiteDisplayLabel(origin),
            cookieCount: 0,
          });
        }
        
        const entry = originsMap.get(origin)!;
        entry.cookieCount++;
      }
      
      return {
        ok: true,
        origins: Array.from(originsMap.values()).sort((a, b) => a.origin.localeCompare(b.origin)),
      };
    } catch {
      return { ok: false, origins: [] };
    }
  });

  ipcMain.handle('cookies-delete', async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) return { ok: false };

    const origin = typeof payload.origin === 'string' ? payload.origin.trim() : '';
    if (!origin) return { ok: false };

    try {
      const ses = session.defaultSession;
      const cookies = await ses.cookies.get({});
      
      // Delete cookies matching the origin
      for (const cookie of cookies) {
        const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        if (domain.toLowerCase() === origin.toLowerCase()) {
          const url = `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`;
          await ses.cookies.remove(url, cookie.name);
        }
      }
      
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('cookies-delete-all', async () => {
    try {
      const ses = session.defaultSession;
      const cookies = await ses.cookies.get({});
      
      // Delete all cookies
      for (const cookie of cookies) {
        const url = `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`;
        await ses.cookies.remove(url, cookie.name);
      }
      
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  // Track actively-used permissions (camera/microphone currently in use)
  const activeMediaStreamsByWebContents = new Map<number, Set<string>>();

  ipcMain.handle('site-permissions-get-active', (_event, webContentsId: unknown) => {
    const id = typeof webContentsId === 'number' && Number.isFinite(webContentsId)
      ? Math.floor(webContentsId)
      : -1;
    if (id <= 0) return { permissions: [] };

    const activePermissions = activeMediaStreamsByWebContents.get(id);
    return {
      permissions: activePermissions ? Array.from(activePermissions) : [],
    };
  });

  ipcMain.on('webview-media-started', (event, payload: unknown) => {
    const sourceContents = event.sender;
    const candidate = isObjectRecord(payload) ? payload : {};
    const permissionId = typeof candidate.permissionId === 'string' ? candidate.permissionId.trim() : '';

    if (!permissionId || !['camera', 'microphone', 'screen-capture'].includes(permissionId)) return;

    const existing = activeMediaStreamsByWebContents.get(sourceContents.id);
    if (existing) {
      existing.add(permissionId);
    } else {
      activeMediaStreamsByWebContents.set(sourceContents.id, new Set([permissionId]));
    }

    // Notify host window about active permission change
    const hostWindow = getHostWindowForContents(sourceContents);
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.webContents.send('site-permissions-active-changed', {
        webContentsId: sourceContents.id,
        permissions: Array.from(activeMediaStreamsByWebContents.get(sourceContents.id) || []),
      });
    }
  });

  ipcMain.on('webview-media-stopped', (event, payload: unknown) => {
    const sourceContents = event.sender;
    const candidate = isObjectRecord(payload) ? payload : {};
    const permissionId = typeof candidate.permissionId === 'string' ? candidate.permissionId.trim() : '';

    if (!permissionId) return;

    const existing = activeMediaStreamsByWebContents.get(sourceContents.id);
    if (existing) {
      existing.delete(permissionId);
      if (existing.size === 0) {
        activeMediaStreamsByWebContents.delete(sourceContents.id);
      }
    }

    // Notify host window about active permission change
    const hostWindow = getHostWindowForContents(sourceContents);
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.webContents.send('site-permissions-active-changed', {
        webContentsId: sourceContents.id,
        permissions: Array.from(existing || []),
      });
    }
  });

  // Cleanup when webview is destroyed
  ipcMain.on('webview-destroyed', (event) => {
    const sourceContents = event.sender;
    activeMediaStreamsByWebContents.delete(sourceContents.id);
  });

  ipcMain.on('webview-site-dialog-sync', (event, payload: unknown) => {
    const sourceContents = event.sender;
    const hostWindow = getHostWindowForContents(sourceContents);
    const siteLabel = getSiteDisplayLabel(sourceContents.getURL());

    const candidate = isObjectRecord(payload) ? payload : {};
    const dialogType = candidate.type === 'confirm' ? 'confirm' : 'alert';
    const dialogMessage = normalizeDialogMessage(candidate.message);
    const options: MessageBoxSyncOptions = dialogType === 'confirm'
      ? {
          type: 'question',
          buttons: ['OK', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: 'Confirm',
          message: `${siteLabel} says`,
          detail: dialogMessage || ' ',
        }
      : {
          type: 'info',
          buttons: ['OK'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Alert',
          message: `${siteLabel} says`,
          detail: dialogMessage || ' ',
        };

    const response = showMessageBoxSyncForWindow(hostWindow, options);
    event.returnValue = dialogType === 'confirm' ? response === 0 : true;
  });

  ipcMain.handle('webview-request-close-tab', (event, payload: unknown) => {
    if (!isObjectRecord(payload)) return false;

    const tabId = typeof payload.tabId === 'string' ? payload.tabId.trim() : '';
    const webContentsId =
      typeof payload.webContentsId === 'number' && Number.isFinite(payload.webContentsId)
        ? Math.floor(payload.webContentsId)
        : -1;
    if (!tabId || webContentsId <= 0) return false;

    const target = electronWebContents.fromId(webContentsId);
    if (!target || target.isDestroyed()) return false;

    const host = target.hostWebContents;
    if (!host || host.isDestroyed() || host.id !== event.sender.id) return false;

    const hostWindow = BrowserWindow.fromWebContents(host);
    pendingWebviewCloseRequestsByWebContentsId.set(webContentsId, {
      type: 'tab',
      tabId,
      hostWindowId: hostWindow && !hostWindow.isDestroyed() ? hostWindow.id : null,
    });
    target.close({ waitForBeforeUnload: true });
    return true;
  });

  ipcMain.handle('webview-request-close-window', (event, payload: unknown) => {
    if (!isObjectRecord(payload)) return false;

    const webContentsId =
      typeof payload.webContentsId === 'number' && Number.isFinite(payload.webContentsId)
        ? Math.floor(payload.webContentsId)
        : -1;
    if (webContentsId <= 0) return false;

    const target = electronWebContents.fromId(webContentsId);
    if (!target || target.isDestroyed()) return false;

    const host = target.hostWebContents;
    if (!host || host.isDestroyed() || host.id !== event.sender.id) return false;

    const hostWindow = BrowserWindow.fromWebContents(host);
    pendingWebviewCloseRequestsByWebContentsId.set(webContentsId, {
      type: 'window',
      hostWindowId: hostWindow && !hostWindow.isDestroyed() ? hostWindow.id : null,
    });
    target.close({ waitForBeforeUnload: true });
    return true;
  });
}

function setupSessionHandlers() {
  ipcMain.handle('session-save-window', async (event, payload: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return false;

    if (payload === null) {
      windowSessionCache.delete(sourceWindow.id);
      scheduleSessionPersist();
      return true;
    }

    const normalized = normalizeWindowSessionSnapshot(payload);
    if (!normalized) return false;

    const bounds = sourceWindow.getBounds();
    windowSessionCache.set(sourceWindow.id, {
      ...normalized,
      bounds,
      isMaximized: sourceWindow.isMaximized(),
      isFullScreen: sourceWindow.isFullScreen(),
    });
    scheduleSessionPersist();
    return true;
  });

  ipcMain.handle('session-get-restore-state', () => {
    if (!pendingRestoreSession) {
      return {
        hasPendingRestore: false,
        tabCount: 0,
        windowCount: 0,
      };
    }

    const tabCount = pendingRestoreSession.windows.reduce((sum, item) => sum + item.tabs.length, 0);
    return {
      hasPendingRestore: tabCount > 0,
      tabCount,
      windowCount: pendingRestoreSession.windows.length,
    };
  });

  ipcMain.handle('session-accept-restore', (event, mode: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return null;
    if (!pendingRestoreSession?.windows.length) return null;

    const restoreMode: SessionRestoreMode = mode === 'tabs' ? 'tabs' : 'windows';
    const [primaryWindow, ...otherWindows] = pendingRestoreSession.windows;
    pendingRestoreSession = null;

    if (restoreMode === 'tabs') {
      return mergeRestoreWindowsIntoSingleSnapshot([primaryWindow, ...otherWindows]) ?? primaryWindow;
    }

    applyWindowStateFromSnapshot(sourceWindow, primaryWindow);
    for (const snapshot of otherWindows) {
      createWindow(undefined, undefined, snapshot);
    }

    return primaryWindow;
  });

  ipcMain.handle('session-discard-restore', async () => {
    pendingRestoreSession = null;
    await clearPersistedSessionSnapshot();
    return true;
  });

  ipcMain.handle('session-take-window-restore', (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return null;
    const snapshot = bootRestoreByWindowId.get(sourceWindow.id) ?? null;
    bootRestoreByWindowId.delete(sourceWindow.id);
    return snapshot;
  });
}

function applyWindowStateFromSnapshot(
  win: BrowserWindow,
  snapshot: WindowSessionSnapshot | undefined,
): void {
  if (!snapshot || win.isDestroyed()) return;

  if (snapshot.bounds) {
    win.setBounds(snapshot.bounds);
  }
  if (snapshot.isMaximized) {
    win.maximize();
  }
  if (snapshot.isFullScreen) {
    win.setFullScreen(true);
  }
}

function setupUpdateHandlers() {
  ipcMain.handle('updates-launch-auto-support', () => {
    return {
      canAutoInstall: canAutoInstallUpdatesOnLaunch(),
    };
  });

  ipcMain.handle(
    'updates-run-launch-auto',
    async (_event, options: { includePrerelease?: boolean } | undefined) => {
      if (hasAttemptedLaunchAutoUpdate) {
        return {
          ok: true,
          skipped: true,
          reason: 'already-attempted',
        };
      }
      hasAttemptedLaunchAutoUpdate = true;

      if (!canAutoInstallUpdatesOnLaunch()) {
        return {
          ok: true,
          skipped: true,
          reason: 'unsupported-build',
        };
      }

      try {
        const result = await checkForUpdates(options?.includePrerelease === true);
        if (!result) {
          return {
            ok: true,
            skipped: true,
            reason: 'no-compatible-asset',
          };
        }

        if (!result.hasUpdate) {
          return {
            ok: true,
            skipped: true,
            reason: 'up-to-date',
          };
        }

        if (result.mode !== 'installer') {
          return {
            ok: true,
            skipped: true,
            reason: 'non-installer-build',
          };
        }

        const downloadedPath = await downloadAssetToDownloads(result.downloadUrl, result.assetName);
        // Launch installer in silent mode for auto-updates (shows only progress bar)
        const child = spawn(downloadedPath, ['/S'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        if (process.platform === 'win32') {
          setTimeout(() => app.quit(), 1000).unref();
        }

        return {
          ok: true,
          skipped: false,
          launchedInstaller: true,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to run launch update check.',
        };
      }
    },
  );

  ipcMain.handle('updates-check', async (_event, options: { includePrerelease?: boolean } | undefined) => {
    try {
      const result = await checkForUpdates(options?.includePrerelease === true);
      if (!result) {
        return {
          ok: false,
          error: 'No compatible update asset was found for this operating system.',
        };
      }

      return {
        ok: true,
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates.',
      };
    }
  });

  ipcMain.handle(
    'updates-download-asset',
    async (_event, payload: { downloadUrl?: unknown; assetName?: unknown } | undefined) => {
      const downloadUrl = typeof payload?.downloadUrl === 'string' ? payload.downloadUrl.trim() : '';
      const assetName = typeof payload?.assetName === 'string' ? payload.assetName.trim() : '';
      if (!downloadUrl || !assetName) {
        return {
          ok: false,
          error: 'Invalid update payload.',
        };
      }

      try {
        const savedPath = await downloadAssetToDownloads(downloadUrl, assetName);
        return {
          ok: true,
          savedPath,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to download update.',
        };
      }
    },
  );

  ipcMain.handle(
    'updates-download-and-install',
    async (_event, payload: { downloadUrl?: unknown; assetName?: unknown } | undefined) => {
      const downloadUrl = typeof payload?.downloadUrl === 'string' ? payload.downloadUrl.trim() : '';
      const assetName = typeof payload?.assetName === 'string' ? payload.assetName.trim() : '';
      if (!downloadUrl || !assetName) {
        return {
          ok: false,
          error: 'Invalid update payload.',
        };
      }

      try {
        const downloadedPath = await downloadAssetToDownloads(downloadUrl, assetName);
        // Launch installer in silent mode (shows only progress bar)
        const child = spawn(downloadedPath, ['/S'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        if (process.platform === 'win32') {
          setTimeout(() => app.quit(), 1000).unref();
        }

        return {
          ok: true,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to download and launch update.',
        };
      }
    },
  );

  ipcMain.handle(
    'updates-configure-auto-mode',
    (_event, payload: { mode?: unknown; includePrerelease?: unknown } | undefined) => {
      const mode = payload?.mode;
      if (
        mode === 'off'
        || mode === 'ask-on-launch'
        || mode === 'ask-on-close'
        || mode === 'auto-on-launch'
        || mode === 'auto-on-close'
      ) {
        configuredAutoUpdateMode = mode;
      } else {
        configuredAutoUpdateMode = 'off';
      }

      configuredAutoUpdateIncludePrerelease = payload?.includePrerelease === true;
      return { ok: true };
    },
  );

  app.on('before-quit', async () => {
    if (hasAttemptedCloseAutoUpdate) return;
    if (
      configuredAutoUpdateMode !== 'ask-on-close'
      && configuredAutoUpdateMode !== 'auto-on-close'
    ) {
      return;
    }

    hasAttemptedCloseAutoUpdate = true;

    try {
      const result = await checkForUpdates(configuredAutoUpdateIncludePrerelease);
      if (!result || !result.hasUpdate) return;

      if (configuredAutoUpdateMode === 'ask-on-close') {
        const { dialog } = await import('electron');
        const response = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Install update', 'Skip'],
          defaultId: 0,
          cancelId: 1,
          title: 'Mira Update Available',
          message: `Mira v${result.latestVersion} is available. Install now?`,
          detail: `You are currently on v${result.currentVersion}.`,
        });
        if (response.response !== 0) return;
      }

      if (result.mode !== 'installer') return;

      const downloadedPath = await downloadAssetToDownloads(result.downloadUrl, result.assetName);
      const openError = await shell.openPath(downloadedPath);
      if (openError) return;
    } catch {
      // Swallow close-time update errors to avoid blocking shutdown.
    }
  });
}

function triggerNewWindowFromShortcut(sourceWindow: BrowserWindow): void {
  if (sourceWindow.isDestroyed()) return;

  const now = Date.now();
  const windowId = sourceWindow.id;
  const lastTriggeredAt = recentNewWindowShortcutByWindow.get(windowId) ?? 0;
  if (now - lastTriggeredAt < NEW_WINDOW_SHORTCUT_DEDUPE_MS) return;

  recentNewWindowShortcutByWindow.set(windowId, now);
  createWindow(sourceWindow);
}

function getHostWebContents(target: WebContents): WebContents | null {
  return target.hostWebContents ?? (target.getType() === 'window' ? target : null);
}

function getHostWindowForContents(target: WebContents): BrowserWindow | null {
  const host = getHostWebContents(target);
  if (!host) return null;
  const hostWindow = BrowserWindow.fromWebContents(host);
  return hostWindow && !hostWindow.isDestroyed() ? hostWindow : null;
}

function markHostDevToolsSuppressedForShortcut(win: BrowserWindow): void {
  suppressHostDevToolsUntilByWindowId.set(win.id, Date.now() + SHORTCUT_DEVTOOLS_SUPPRESS_MS);
}

function shouldSuppressHostDevTools(win: BrowserWindow): boolean {
  const suppressUntil = suppressHostDevToolsUntilByWindowId.get(win.id) ?? 0;
  if (Date.now() > suppressUntil) {
    suppressHostDevToolsUntilByWindowId.delete(win.id);
    return false;
  }
  return true;
}

function toggleFocusedBrowserDevTools(): boolean {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow || focusedWindow.isDestroyed()) return false;

  // Get the active webContents for this window from our tracking
  const activeWebContents = activeWebContentsByWindow.get(focusedWindow.id);
  if (activeWebContents && !activeWebContents.isDestroyed()) {
    if (activeWebContents.isDevToolsOpened()) {
      activeWebContents.closeDevTools();
    } else {
      activeWebContents.openDevTools();
    }
    return true;
  }

  // Fallback to getFocusedWebContents if no tracked active webview
  const focused = electronWebContents.getFocusedWebContents();
  if (!focused || focused.isDestroyed()) return false;
  if (!focused.hostWebContents) return false;

  if (focused.isDevToolsOpened()) {
    focused.closeDevTools();
  } else {
    focused.openDevTools();
  }
  return true;
}

function toggleWindowDevTools(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;
  try {
    const wasOpen = win.webContents.isDevToolsOpened();
    if (wasOpen) {
      win.webContents.closeDevTools();
    } else {
      win.webContents.openDevTools({ mode: 'detach' });
    }
    logDebug('shortcut', 'toggleWindowDevTools', {
      windowId: win.id,
      wasOpen,
      nowOpen: !wasOpen,
    });
    return true;
  } catch (error) {
    logDebug('shortcut', 'toggleWindowDevTools-error', {
      windowId: win.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function setupAdBlocker() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: shouldBlockRequest(details.url, details.resourceType) });
  });

  ipcMain.handle('settings-set-ad-block-enabled', async (_, enabled: unknown) => {
    adBlockEnabled = enabled !== false;
    if (!adBlockEnabled) trackedYoutubeAdCpns.clear();
    return adBlockEnabled;
  });

  ipcMain.handle('settings-set-tracker-block-enabled', async (_, enabled: unknown) => {
    trackerBlockEnabled = enabled !== false;
    return trackerBlockEnabled;
  });

  ipcMain.handle('settings-set-quit-on-last-window-close', async (_, enabled: unknown) => {
    quitOnLastWindowClose = isMacOS && enabled === true;
    return quitOnLastWindowClose;
  });

  ipcMain.handle('settings-run-on-startup-status', async () => {
    const support = getRunOnStartupSupportInfo();
    return {
      ok: support.code === 'ok',
      canConfigure: support.canConfigure,
      isEnabled: support.isEnabled,
      message: support.message,
      support,
    };
  });

  ipcMain.handle('settings-set-run-on-startup', async (_, enabled: unknown) => {
    const supportBefore = getRunOnStartupSupportInfo();
    if (!supportBefore.canConfigure) {
      return {
        ok: false,
        canConfigure: false,
        isEnabled: supportBefore.isEnabled,
        message: supportBefore.message,
        support: supportBefore,
      };
    }

    const shouldEnable = enabled === true;
    try {
      if (isMacOS) {
        app.setLoginItemSettings({
          openAtLogin: shouldEnable,
          openAsHidden: false,
        });
      } else {
        app.setLoginItemSettings({
          openAtLogin: shouldEnable,
        });
      }
    } catch (error) {
      const supportFailed = getRunOnStartupSupportInfo();
      return {
        ok: false,
        canConfigure: supportFailed.canConfigure,
        isEnabled: supportFailed.isEnabled,
        message: error instanceof Error ? error.message : 'Failed to update startup setting.',
        support: supportFailed,
      };
    }

    const supportAfter = getRunOnStartupSupportInfo();
    const didApply = supportAfter.canConfigure && supportAfter.isEnabled === shouldEnable;
    return {
      ok: didApply,
      canConfigure: supportAfter.canConfigure,
      isEnabled: supportAfter.isEnabled,
      message: didApply ? '' : 'Startup setting may require additional OS permissions.',
      support: supportAfter,
    };
  });
}

function setupMainFrameHttpErrorReporter() {
  const ses = session.defaultSession;
  ses.webRequest.onCompleted((details) => {
    if (details.resourceType !== 'mainFrame') return;

    if (adBlockEnabled) {
      try {
        const parsed = new URL(details.url);
        const protocol = parsed.protocol.toLowerCase();
        if (protocol === 'http:' || protocol === 'https:') {
          rememberYoutubeAdCpnFromUrl(parsed);
        }
      } catch {
        // Ignore invalid URLs from request details.
      }
    }

    if (typeof details.webContentsId !== 'number' || details.webContentsId <= 0) return;
    // Preserve server-provided authentication, verification, and error pages.
    // Only a missing page receives Mira's HTTP error overlay.
    if (details.statusCode !== 404) return;

    const target = electronWebContents.fromId(details.webContentsId);
    if (!target || target.isDestroyed()) return;
    const host = target.hostWebContents;
    if (!host || host.isDestroyed()) return;

    host.send('webview-main-frame-http-error', {
      webContentsId: details.webContentsId,
      url: details.url,
      statusCode: details.statusCode,
    });
  });
}

function setupWindowControlsHandlers() {
  ipcMain.handle('window-new', (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    createWindow(sourceWindow && !sourceWindow.isDestroyed() ? sourceWindow : undefined);
    return true;
  });

  ipcMain.handle('window-new-with-url', (event, url: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    const normalizedUrl = typeof url === 'string' ? url.trim() : '';
    createWindow(
      sourceWindow && !sourceWindow.isDestroyed() ? sourceWindow : undefined,
      normalizedUrl || undefined,
    );
    return true;
  });

  ipcMain.handle('window-detach-tab-to-new-window', (event, payload: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return null;

    const normalized = normalizeDetachedTabTransferRequest(payload);
    if (!normalized) return null;

    const detachedWindow = createWindow(
      sourceWindow,
      undefined,
      undefined,
      {
        initialBounds:
          typeof normalized.x === 'number' && typeof normalized.y === 'number'
            ? {
                x: normalized.x - 140,
                y: normalized.y - 18,
                width: 1200,
                height: 800,
              }
            : undefined,
        maximize: false,
        showInactive: normalized.dragMode === true,
      },
    );
    const transferId = uuidv4();
    const transfer: DetachedTabTransferPayload = {
      transferId,
      sourceWindowId: sourceWindow.id,
      targetWindowId: detachedWindow.id,
      tab: normalized.tab,
      guestInstance: normalized.guestInstance,
      webContentsId: normalized.webContentsId,
      attached: false,
      deferSourceFinalize: normalized.dragMode === true,
      releaseRequested: false,
    };
    pendingDetachedTabTransferByWindowId.set(detachedWindow.id, transfer);
    detachedTabTransferById.set(transferId, transfer);
    scheduleDetachedTabBootstrapDelivery(detachedWindow);

    if (normalized.dragMode) {
      startDetachedWindowDragSession(
        transfer,
        normalized.pointerOffsetX ?? 160,
        normalized.pointerOffsetY ?? 18,
      );
    }

    return { transferId };
  });

  ipcMain.handle('window-consume-initial-url', (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return '';
    const pending = pendingInitialUrlByWindowId.get(sourceWindow.id) ?? '';
    pendingInitialUrlByWindowId.delete(sourceWindow.id);
    return pending;
  });

  ipcMain.handle('window-consume-detached-tab', (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return null;
    const pending = pendingDetachedTabTransferByWindowId.get(sourceWindow.id) ?? null;
    pendingDetachedTabTransferByWindowId.delete(sourceWindow.id);
    return pending;
  });

  ipcMain.handle('window-release-detached-tab-drag', (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return false;
    return stopDetachedWindowDragSession(sourceWindow.id, {
      requestFinalize: true,
      focusTarget: true,
    });
  });

  ipcMain.handle('detached-tab-transfer-complete', (event, transferId: unknown) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) return false;

    const normalizedTransferId = typeof transferId === 'string' ? transferId.trim() : '';
    if (!normalizedTransferId) return false;

    const transfer = detachedTabTransferById.get(normalizedTransferId);
    if (!transfer || transfer.targetWindowId !== targetWindow.id) return false;

    transfer.attached = true;
    return finalizeDetachedTransferIfReady(normalizedTransferId) || true;
  });

  ipcMain.handle('tab-open-url-in-new-tab', (event, url: unknown) => {
    const normalizedUrl = typeof url === 'string' ? url.trim() : '';
    if (!normalizedUrl) return false;
    if (event.sender.isDestroyed()) return false;
    event.sender.send('open-url-in-new-tab', normalizedUrl);
    return true;
  });

  const ownedNavigationTarget = (sender: WebContents, id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
    const target = electronWebContents.fromId(id);
    if (!target || target.isDestroyed() || target.hostWebContents?.id !== sender.id) return null;
    return target;
  };

  ipcMain.handle('tab-navigation-history', (event, id: unknown) => {
    const target = ownedNavigationTarget(event.sender, id);
    if (!target) return null;
    return {
      history: target.navigationHistory.getAllEntries().map((entry) => entry.url),
      index: target.navigationHistory.getActiveIndex(),
    };
  });

  ipcMain.handle('tab-navigation-restore', (event, payload: unknown) => {
    if (!isObjectRecord(payload)) return false;
    const target = ownedNavigationTarget(event.sender, payload.webContentsId);
    const history = payload.history;
    const index = payload.index;
    if (!target || !Array.isArray(history) || !history.length
      || history.some((url) => typeof url !== 'string' || !/^(https?:|file:|about:|view-source:|data:)/i.test(url))
      || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= history.length) return false;
    void target.navigationHistory.restore({
      entries: history.map((url) => ({ url, title: url })), index,
    }).catch(() => undefined);
    return target.navigationHistory.length() === history.length
      && target.navigationHistory.getActiveIndex() === index;
  });

  ipcMain.handle('tab-set-active-webcontents', (event, webContentsId: unknown) => {
    const hostWindow = BrowserWindow.fromWebContents(event.sender);
    if (!hostWindow || hostWindow.isDestroyed()) return false;

    const id = typeof webContentsId === 'number' && Number.isFinite(webContentsId)
      ? Math.floor(webContentsId)
      : -1;
    if (id <= 0) {
      activeWebContentsByWindow.delete(hostWindow.id);
      return false;
    }

    const target = electronWebContents.fromId(id);
    if (!target || target.isDestroyed()) {
      activeWebContentsByWindow.delete(hostWindow.id);
      return false;
    }

    // Verify this webContents belongs to the same window
    const targetHost = target.hostWebContents;
    if (!targetHost || targetHost.id !== event.sender.id) {
      return false;
    }

    activeWebContentsByWindow.set(hostWindow.id, target);
    return true;
  });

  ipcMain.handle('tab-show-native-context-menu', (event, payload: unknown) => {
    if (typeof payload !== 'object' || !payload) return false;

    const candidate = payload as {
      tabId?: unknown;
      x?: unknown;
      y?: unknown;
      hasTabsToRight?: unknown;
      hasOtherTabs?: unknown;
      isVertical?: unknown;
    };
    const tabId = typeof candidate.tabId === 'string' ? candidate.tabId.trim() : '';
    if (!tabId) return false;

    const hasTabsToRight = candidate.hasTabsToRight === true;
    const hasOtherTabs = candidate.hasOtherTabs === true;
    const isVertical = candidate.isVertical === true;
    const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x)
      ? Math.max(0, Math.floor(candidate.x))
      : null;
    const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y)
      ? Math.max(0, Math.floor(candidate.y))
      : null;

    const hostWindow = BrowserWindow.fromWebContents(event.sender);
    if (!hostWindow || hostWindow.isDestroyed()) return false;

    const sendCommand = (command: string) => {
      hostWindow.webContents.send('tab-native-context-command', { command, tabId });
    };

    const template: MenuItemConstructorOptions[] = [
      {
        label: isVertical ? 'New Tab Below' : 'New Tab to Right',
        click: () => sendCommand('new-tab-to-right'),
      },
      { type: 'separator' },
      {
        label: 'Reload',
        accelerator: 'CommandOrControl+R',
        click: () => sendCommand('reload'),
      },
      {
        label: 'Duplicate',
        click: () => sendCommand('duplicate'),
      },
      { type: 'separator' },
      {
        label: 'Close',
        accelerator: 'CommandOrControl+W',
        click: () => sendCommand('close'),
      },
      {
        label: 'Close Others',
        enabled: hasOtherTabs,
        click: () => sendCommand('close-others'),
      },
      {
        label: isVertical ? 'Close Below' : 'Close to Right',
        enabled: hasTabsToRight,
        click: () => sendCommand('close-to-right'),
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    try {
      menu.popup({
        window: hostWindow,
        ...(x !== null && y !== null ? { x, y } : {}),
      });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('bookmark-show-native-context-menu', (event, payload: unknown) => {
    if (typeof payload !== 'object' || !payload) return false;

    const candidate = payload as {
      bookmarkId?: unknown;
      x?: unknown;
      y?: unknown;
      hasUrl?: unknown;
      isFolder?: unknown;
    };
    const bookmarkId = typeof candidate.bookmarkId === 'string' ? candidate.bookmarkId.trim() : '';
    if (!bookmarkId) return false;

    const hasUrl = candidate.hasUrl === true;
    const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x)
      ? Math.max(0, Math.floor(candidate.x))
      : null;
    const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y)
      ? Math.max(0, Math.floor(candidate.y))
      : null;

    const hostWindow = BrowserWindow.fromWebContents(event.sender);
    if (!hostWindow || hostWindow.isDestroyed()) return false;

    const sendCommand = (command: string, data?: unknown) => {
      hostWindow.webContents.send('bookmark-native-context-command', { command, bookmarkId, data });
    };

    const template: MenuItemConstructorOptions[] = [];

    if (hasUrl) {
      template.push(
        {
          label: 'Open',
          click: () => sendCommand('open'),
        },
        {
          label: 'Open in New Tab',
          click: () => sendCommand('open-in-new-tab'),
        },
        {
          label: 'Open in New Window',
          click: () => sendCommand('open-in-new-window'),
        },
        { type: 'separator' }
      );
    }

    template.push(
      {
        label: 'Delete',
        click: () => sendCommand('delete'),
      }
    );

    const menu = Menu.buildFromTemplate(template);
    try {
      menu.popup({
        window: hostWindow,
        ...(x !== null && y !== null ? { x, y } : {}),
      });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('webview-open-devtools', (event, payload: unknown) => {
    if (typeof payload !== 'object' || !payload) return false;

    const candidate = payload as {
      webContentsId?: unknown;
      mode?: unknown;
      activate?: unknown;
    };
    const webContentsId =
      typeof candidate.webContentsId === 'number' && Number.isFinite(candidate.webContentsId)
        ? Math.floor(candidate.webContentsId)
        : -1;
    if (webContentsId <= 0) return false;

    const target = electronWebContents.fromId(webContentsId);
    if (!target || target.isDestroyed()) return false;

    const host = target.hostWebContents;
    if (!host || host.id !== event.sender.id) return false;
    const hostWindow = BrowserWindow.fromWebContents(host);
    if (!hostWindow || hostWindow.isDestroyed()) return false;

    const nextMode =
      candidate.mode === 'left' ||
      candidate.mode === 'right' ||
      candidate.mode === 'bottom' ||
      candidate.mode === 'undocked' ||
      candidate.mode === 'detach'
        ? candidate.mode
        : 'right';

    const wantsDockedMode = nextMode === 'left' || nextMode === 'right' || nextMode === 'bottom';
    let releaseOverlaySuppression: (() => void) | null = null;
    if (isWindows && wantsDockedMode) {
      releaseOverlaySuppression = suppressTitleBarOverlayForDockedDevTools(hostWindow);
      const cleanupSuppression = () => {
        if (!releaseOverlaySuppression) return;
        releaseOverlaySuppression();
        releaseOverlaySuppression = null;
      };
      target.once('devtools-closed', cleanupSuppression);
      target.once('destroyed', cleanupSuppression);
    }

    try {
      target.openDevTools({
        mode: nextMode,
        activate: candidate.activate !== false,
      });
      return true;
    } catch {
      if (releaseOverlaySuppression) {
        releaseOverlaySuppression();
      }
      return false;
    }
  });

  ipcMain.handle('webview-show-native-context-menu', (event, payload: unknown) => {
    if (typeof payload !== 'object' || !payload) return false;

    const candidate = payload as {
      webContentsId?: unknown;
      tabId?: unknown;
      x?: unknown;
      y?: unknown;
      params?: unknown;
      context?: unknown;
    };
    const webContentsId =
      typeof candidate.webContentsId === 'number' && Number.isFinite(candidate.webContentsId)
        ? Math.floor(candidate.webContentsId)
        : -1;
    if (webContentsId <= 0) return false;

    const tabIdFromPayload =
      typeof candidate.tabId === 'string' ? candidate.tabId.trim() : '';

    const target = electronWebContents.fromId(webContentsId);
    if (!target || target.isDestroyed()) return false;

    const host = target.hostWebContents;
    if (!host || host.id !== event.sender.id) return false;
    const hostWindow = BrowserWindow.fromWebContents(host);
    if (!hostWindow || hostWindow.isDestroyed()) return false;

    const rawParams =
      typeof candidate.params === 'object' && candidate.params !== null
        ? (candidate.params as Record<string, unknown>)
        : {};
    const rawContext =
      typeof candidate.context === 'object' && candidate.context !== null
        ? (candidate.context as Record<string, unknown>)
        : {};

    const pageURL = typeof rawParams.pageURL === 'string' ? rawParams.pageURL.trim() : '';
    const linkURL = typeof rawParams.linkURL === 'string' ? rawParams.linkURL.trim() : '';
    const srcURL = typeof rawParams.srcURL === 'string' ? rawParams.srcURL.trim() : '';
    const mediaType = typeof rawParams.mediaType === 'string' ? rawParams.mediaType.trim().toLowerCase() : '';
    const isEditable = rawParams.isEditable === true;
    const canGoBack = rawContext.canGoBack === true;
    const canGoForward = rawContext.canGoForward === true;
    const sourceUrl = typeof rawContext.sourceUrl === 'string' ? rawContext.sourceUrl.trim() : '';

    const rawEditFlags =
      typeof rawParams.editFlags === 'object' && rawParams.editFlags !== null
        ? (rawParams.editFlags as Record<string, unknown>)
        : {};
    const canUndo = rawEditFlags.canUndo !== false;
    const canRedo = rawEditFlags.canRedo !== false;
    const canCut = rawEditFlags.canCut !== false;
    const canCopy = rawEditFlags.canCopy !== false;
    const canPaste = rawEditFlags.canPaste !== false;
    const canPasteAndMatchStyle = rawEditFlags.canPasteAndMatchStyle !== false;
    const canSelectAll = rawEditFlags.canSelectAll !== false;

    const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x)
      ? Math.max(0, Math.floor(candidate.x))
      : null;
    const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y)
      ? Math.max(0, Math.floor(candidate.y))
      : null;

    const resolveContextMenuUrl = (rawUrl: string, baseUrl?: string): string => {
      const trimmed = rawUrl.trim();
      if (!trimmed) return '';

      try {
        const normalizedBase = typeof baseUrl === 'string' ? baseUrl.trim() : '';
        return normalizedBase ? new URL(trimmed, normalizedBase).toString() : new URL(trimmed).toString();
      } catch {
        return trimmed;
      }
    };

    const canOpenInNewTab = (url: string): boolean => {
      const trimmed = url.trim();
      if (!trimmed) return false;

      try {
        const protocol = new URL(trimmed).protocol.toLowerCase();
        return (
          protocol === 'http:' ||
          protocol === 'https:' ||
          protocol === 'file:' ||
          protocol === 'mailto:' ||
          protocol === 'about:' ||
          protocol === 'mira:' ||
          protocol === 'view-source:'
        );
      } catch {
        return false;
      }
    };

    const resolvedSrcUrl = resolveContextMenuUrl(srcURL, pageURL);
    const resolvedLinkUrl = resolveContextMenuUrl(linkURL, pageURL);
    const resolvedSourceUrl = resolveContextMenuUrl(sourceUrl, pageURL);
    const viewSourceUrl = resolvedSourceUrl ? `view-source:${resolvedSourceUrl}` : '';

    const sendCommand = (command: string, extra?: Record<string, unknown>) => {
      hostWindow.webContents.send('webview-native-context-command', {
        command,
        webContentsId,
        ...(tabIdFromPayload ? { tabId: tabIdFromPayload } : {}),
        ...extra,
      });
    };

    const menuItem = (
      label: string,
      command: string,
      options?: {
        enabled?: boolean;
        accelerator?: string;
        extra?: Record<string, unknown>;
      },
    ) => ({
      label,
      enabled: options?.enabled ?? true,
      accelerator: options?.accelerator,
      click: () => {
        sendCommand(command, options?.extra);
      },
    });

    const inspectEntry = menuItem('Inspect', 'inspect-element', {
      accelerator: isMacOS ? 'Command+Alt+I' : 'F12',
      extra: {
        x: x ?? 0,
        y: y ?? 0,
      },
    });

    let template: MenuItemConstructorOptions[] = [];
    if (isEditable) {
      template = [
        menuItem('Undo', 'edit-undo', {
          enabled: canUndo,
          accelerator: 'CommandOrControl+Z',
        }),
        menuItem('Redo', 'edit-redo', {
          enabled: canRedo,
          accelerator: isMacOS ? 'Shift+Command+Z' : 'CommandOrControl+Y',
        }),
        { type: 'separator' },
        menuItem('Cut', 'edit-cut', { enabled: canCut, accelerator: 'CommandOrControl+X' }),
        menuItem('Copy', 'edit-copy', { enabled: canCopy, accelerator: 'CommandOrControl+C' }),
        menuItem('Paste', 'edit-paste', { enabled: canPaste, accelerator: 'CommandOrControl+V' }),
        menuItem('Paste as Plain Text', 'edit-paste-as-plain-text', {
          enabled: canPasteAndMatchStyle,
          accelerator: isMacOS ? 'Shift+Command+V' : 'CommandOrControl+Shift+V',
        }),
        { type: 'separator' },
        menuItem('Select All', 'edit-select-all', {
          enabled: canSelectAll,
          accelerator: 'CommandOrControl+A',
        }),
        { type: 'separator' },
        inspectEntry,
      ];
    } else if (mediaType === 'image' || !!resolvedSrcUrl) {
      const canOpenImageInNewTab = canOpenInNewTab(resolvedSrcUrl);
      template = [
        menuItem('Open Image in New Tab', 'open-url-in-new-tab', {
          enabled: canOpenImageInNewTab,
          extra: {
            url: resolvedSrcUrl,
            baseUrl: pageURL,
          },
        }),
        menuItem('Save Image As', 'download-url', {
          enabled: !!resolvedSrcUrl,
          extra: {
            url: resolvedSrcUrl,
          },
        }),
        menuItem('Copy Image', 'copy-image-at', {
          extra: {
            x: x ?? 0,
            y: y ?? 0,
          },
        }),
        menuItem('Copy Image Address', 'copy-text', {
          enabled: !!resolvedSrcUrl,
          extra: {
            text: resolvedSrcUrl,
          },
        }),
        { type: 'separator' },
        inspectEntry,
      ];
    } else if (resolvedLinkUrl) {
      const canOpenLinkInNewTab = canOpenInNewTab(resolvedLinkUrl);
      template = [
        menuItem('Open in New Tab', 'open-url-in-new-tab', {
          enabled: canOpenLinkInNewTab,
          extra: {
            url: resolvedLinkUrl,
            baseUrl: pageURL,
          },
        }),
        menuItem('Open in New Window', 'open-url-in-new-window', {
          enabled: canOpenLinkInNewTab,
          extra: {
            url: resolvedLinkUrl,
            baseUrl: pageURL,
          },
        }),
        { type: 'separator' },
        menuItem('Copy Link Address', 'copy-text', {
          enabled: !!resolvedLinkUrl,
          extra: {
            text: resolvedLinkUrl,
          },
        }),
        menuItem('Save Link As', 'download-url', {
          enabled: !!resolvedLinkUrl,
          extra: {
            url: resolvedLinkUrl,
          },
        }),
        { type: 'separator' },
        inspectEntry,
      ];
    } else {
      template = [
        menuItem('Back', 'go-back', { enabled: canGoBack, accelerator: 'Alt+Left' }),
        menuItem('Forward', 'go-forward', { enabled: canGoForward, accelerator: 'Alt+Right' }),
        menuItem('Reload', 'reload', { accelerator: 'CommandOrControl+R' }),
        { type: 'separator' },
        menuItem('Save As', 'save-page-as', { accelerator: 'CommandOrControl+S' }),
        menuItem('Print', 'print', { accelerator: 'CommandOrControl+P' }),
        { type: 'separator' },
        menuItem('View Source', 'open-url-in-new-tab', {
          enabled: !!viewSourceUrl && canOpenInNewTab(viewSourceUrl),
          accelerator: 'CommandOrControl+U',
          extra: {
            url: viewSourceUrl,
            baseUrl: pageURL,
          },
        }),
        inspectEntry,
      ];
    }

    const menu = Menu.buildFromTemplate(template);

    try {
      menu.popup({
        window: hostWindow,
        ...(x !== null && y !== null ? { x, y } : {}),
      });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('renderer-show-native-text-context-menu', (event, payload: unknown) => {
    const hostWindow = BrowserWindow.fromWebContents(event.sender);
    if (!hostWindow || hostWindow.isDestroyed()) return false;

    const candidate =
      typeof payload === 'object' && payload !== null
        ? (payload as { x?: unknown; y?: unknown })
        : {};
    const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x)
      ? Math.max(0, Math.floor(candidate.x))
      : null;
    const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y)
      ? Math.max(0, Math.floor(candidate.y))
      : null;

    const menu = Menu.buildFromTemplate([
      { label: 'Undo', role: 'undo', accelerator: 'CommandOrControl+Z' },
      { label: 'Redo', role: 'redo', accelerator: isMacOS ? 'Shift+Command+Z' : 'CommandOrControl+Y' },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', accelerator: 'CommandOrControl+X' },
      { label: 'Copy', role: 'copy', accelerator: 'CommandOrControl+C' },
      { label: 'Paste', role: 'paste', accelerator: 'CommandOrControl+V' },
      {
        label: 'Paste as Plain Text',
        role: 'pasteAndMatchStyle',
        accelerator: isMacOS ? 'Shift+Command+V' : 'CommandOrControl+Shift+V',
      },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll', accelerator: 'CommandOrControl+A' },
    ]);

    try {
      menu.popup({
        window: hostWindow,
        ...(x !== null && y !== null ? { x, y } : {}),
      });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('webview-context-action', async (event, payload: unknown) => {
    if (typeof payload !== 'object' || !payload) return false;

    const candidate = payload as {
      webContentsId?: unknown;
      action?: unknown;
      x?: unknown;
      y?: unknown;
      url?: unknown;
      text?: unknown;
    };
    const webContentsId =
      typeof candidate.webContentsId === 'number' && Number.isFinite(candidate.webContentsId)
        ? Math.floor(candidate.webContentsId)
        : -1;
    if (webContentsId <= 0) return false;

    const action = typeof candidate.action === 'string' ? candidate.action.trim() : '';
    if (!action) return false;

    const target = electronWebContents.fromId(webContentsId);
    if (!target || target.isDestroyed()) return false;

    const host = target.hostWebContents;
    if (!host || host.id !== event.sender.id) return false;
    const hostWindow = BrowserWindow.fromWebContents(host);
    if (!hostWindow || hostWindow.isDestroyed()) return false;

    const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x) ? Math.floor(candidate.x) : 0;
    const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y) ? Math.floor(candidate.y) : 0;
    const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
    const text = typeof candidate.text === 'string' ? candidate.text : '';
    const focusTargetForEditAction = () => {
      try {
        target.focus();
      } catch {
        // Ignore focus failures; action methods below will return false on failure.
      }
    };

    try {
      switch (action) {
        case 'save-page-as': {
          const defaultPath = path.join(app.getPath('downloads'), getPageSaveDefaultFileName(target));
          const saveResult = await dialog.showSaveDialog(hostWindow, {
            title: 'Save Page As',
            defaultPath,
            filters: [
              { name: 'Web Page', extensions: ['html', 'htm'] },
              { name: 'All Files', extensions: ['*'] },
            ],
          });
          if (saveResult.canceled || !saveResult.filePath) return false;
          await target.savePage(saveResult.filePath, 'HTMLComplete');
          return true;
        }
        case 'download-url':
          if (!url) return false;
          {
            const targetSession = target.session;
            const cleanupDelayMs = 15000;
            let removed = false;
            const detachListener = () => {
              if (removed) return;
              removed = true;
              targetSession.removeListener('will-download', onWillDownload);
            };
            const onWillDownload = (
              _event: Electron.Event,
              item: DownloadItem,
              downloadContents: WebContents | undefined,
            ) => {
              if (downloadContents?.id !== target.id) return;
              if (item.getURL() !== url) return;
              item.setSaveDialogOptions({ title: 'Save As' });
              detachListener();
            };

            targetSession.on('will-download', onWillDownload);
            setTimeout(detachListener, cleanupDelayMs);
          }
          target.downloadURL(url);
          return true;
        case 'copy-text':
          clipboard.writeText(text);
          return true;
        case 'copy-image-at':
          target.copyImageAt(x, y);
          return true;
        case 'inspect-element':
          target.inspectElement(x, y);
          return true;
        case 'edit-undo':
          focusTargetForEditAction();
          target.undo();
          return true;
        case 'edit-redo':
          focusTargetForEditAction();
          target.redo();
          return true;
        case 'edit-cut':
          focusTargetForEditAction();
          target.cut();
          return true;
        case 'edit-copy':
          focusTargetForEditAction();
          target.copy();
          return true;
        case 'edit-paste':
          focusTargetForEditAction();
          target.paste();
          return true;
        case 'edit-paste-as-plain-text':
          focusTargetForEditAction();
          target.pasteAndMatchStyle();
          return true;
        case 'edit-select-all':
          focusTargetForEditAction();
          target.selectAll();
          return true;
        default:
          return false;
      }
    } catch {
      return false;
    }
  });

  ipcMain.handle('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    win.minimize();
    return true;
  });

  ipcMain.handle('window-maximize-toggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return true;
  });

  ipcMain.handle('window-is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    return win.isMaximized();
  });

  ipcMain.handle('window-is-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    return win.isFullScreen();
  });

  ipcMain.handle('window-fullscreen-toggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    win.setFullScreen(!win.isFullScreen());
    return true;
  });

  ipcMain.handle('window-is-titlebar-overlay-enabled', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    return isTitleBarOverlayActive(win);
  });

  ipcMain.handle('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    win.close();
    return true;
  });

  ipcMain.handle('window-toggle-devtools', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    return toggleWindowDevTools(win);
  });

  ipcMain.handle('dialog-open-file-url', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
      title: 'Open File',
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return '';
    return pathToFileURL(result.filePaths[0]).toString();
  });

  ipcMain.handle(
    'window-set-titlebar-symbol-color',
    (
      event,
      payload: unknown,
    ) => {
    if (!isWindows) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;

      let normalizedSymbolColor = '';
      let normalizedOverlayColor = '';
      if (typeof payload === 'string') {
        normalizedSymbolColor = payload.trim();
      } else if (typeof payload === 'object' && payload) {
        const candidate = payload as { symbolColor?: unknown; color?: unknown };
        normalizedSymbolColor =
          typeof candidate.symbolColor === 'string' ? candidate.symbolColor.trim() : '';
        normalizedOverlayColor = typeof candidate.color === 'string' ? candidate.color.trim() : '';
      }

      if (!normalizedSymbolColor) return false;

      const overlayState = getOrCreateTitleBarOverlayState(win);
      overlayState.symbolColor = normalizedSymbolColor;
      overlayState.color = normalizedOverlayColor || DEFAULT_TITLEBAR_OVERLAY_COLOR;
      overlayState.height = DEFAULT_TITLEBAR_OVERLAY_HEIGHT;
      overlayState.preferNativeOverlay = true;
      applyWindowTitleBarOverlay(win);
      return true;
    },
  );
}

function setupMailtoHandlers() {
  ipcMain.handle('mailto-dispatch', async (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { handled: false };
    }

    const candidate = payload as {
      url?: unknown;
      allowExternalFallback?: unknown;
    };
    const rawUrl = typeof candidate.url === 'string' ? candidate.url.trim() : '';
    const allowExternalFallback = candidate.allowExternalFallback !== false;
    const target = resolveMailtoNavigationTarget(rawUrl, { allowExternalFallback });
    if (!target) {
      return { handled: false };
    }

    if (target.kind === 'external-os') {
      try {
        await shell.openExternal(target.url);
        return {
          handled: true,
          openedExternally: true,
        };
      } catch {
        const fallbackUrl = toInternalMailtoUrl(target.url);
        if (!fallbackUrl) {
          return { handled: false };
        }

        return {
          handled: true,
          url: fallbackUrl,
          title: 'Compose Email',
        };
      }
    }

    return {
      handled: true,
      url: target.url,
      title: target.title,
    };
  });
}

function setupDefaultBrowserHandlers() {
  ipcMain.handle('default-browser-status', () => {
    const support = getDefaultBrowserSupportInfo();
    const isDefault = isDefaultBrowser();
    logDefaultBrowserDebug('default-browser-status', {
      isDefault,
      support,
    });
    return {
      isDefault,
      support,
      message: !isDefault ? support.message : '',
    };
  });

  ipcMain.handle('default-browser-set', () => {
    const support = getDefaultBrowserSupportInfo();
    const isDefaultBeforeSet = isDefaultBrowser();
    if (!support.canAttemptRegistration) {
      logDefaultBrowserDebug('default-browser-set-blocked', {
        isDefaultBeforeSet,
        support,
      });
      return {
        ok: false,
        isDefault: isDefaultBeforeSet,
        requiresUserAction: support.requiresUserAction,
        message: support.message,
        support,
      };
    }

    const didSetHttp = setAsDefaultForProtocol('http');
    const didSetHttps = setAsDefaultForProtocol('https');
    setAsDefaultForProtocol('mailto');
    setAsDefaultForProtocol('mira');
    const ok = didSetHttp && didSetHttps;
    const isDefault = isDefaultBrowser();

    // On Windows, even when registration APIs report success and
    // `isDefaultBrowser()` returns true, the OS may still require the user
    // to confirm Mira as the default in Settings. Treat *all* successful
    // registrations as requiring manual confirmation on Windows so that we
    // always guide the user and open the Default apps page.
    const requiresUserAction = isWindows ? ok : ok && !isDefault;

    if (ok && isWindows) {
      try {
        // Open the Default apps page, deep-linked to Mira when possible.
        openWindowsDefaultAppsSettings();
      } catch {
        // Best-effort only; ignore failures and fall back to messaging.
      }
    }

    let message = '';
    if (!ok) {
      message = 'Could not register Mira for http/https. Check your OS default apps settings.';
    } else if (requiresUserAction) {
      message = isMacOS
        ? 'Mira was registered for http/https. If it is still not default, set Mira in macOS System Settings > Desktop & Dock > Default web browser, then refresh.'
        : isWindows
          ? 'Mira was registered for http/https. Windows requires confirmation in the Default apps settings before the default browser changes. The Settings app should now be open—choose Mira as the default Web browser, then click Refresh Status.'
          : 'Mira was registered for http/https. Confirm Mira in your OS default apps settings, then refresh status.';
    } else {
      message = 'Mira is now set as your default browser.';
    }

    if (ok && requiresUserAction && isWindows) {
      message =
        'Mira was registered for web links and additional handlers. Windows still requires confirmation in Default apps. The Settings app should now open to Mira; click Set default there to claim its supported link and file types, then refresh status.';
    }

    logDefaultBrowserDebug('default-browser-set', {
      didSetHttp,
      didSetHttps,
      ok,
      isDefault,
      requiresUserAction,
      message,
      platform: process.platform,
      support,
    });

    return {
      ok,
      isDefault,
      requiresUserAction,
      message,
      support: {
        ...support,
        code: ok ? (requiresUserAction ? 'manual-confirmation-required' : 'ok') : 'registration-failed',
        canAttemptRegistration: ok,
        requiresUserAction,
        message,
      },
    };
  });
}

function setupIncomingUrlHandlers() {
  ipcMain.handle('incoming-urls-consume', () => {
    return takeQueuedIncomingBrowserUrls();
  });
}

function setupOnboardingHandlers() {
  ipcMain.handle('onboarding-complete', async (event) => {
    onboardingCompleted = true;
    await persistAppState().catch(() => undefined);

    let browserWindow = getFirstBrowserWindow();
    if (!browserWindow) {
      browserWindow = createWindow();
    }

    if (browserWindow && !browserWindow.isDestroyed()) {
      if (browserWindow.isMinimized()) browserWindow.restore();
      browserWindow.focus();
    }

    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow && !sourceWindow.isDestroyed()) {
      sourceWindow.close();
    }

    return true;
  });

  ipcMain.handle('onboarding-reset', async () => {
    onboardingCompleted = false;
    await persistAppState().catch(() => undefined);
    return true;
  });
}

function setupMacDockMenu() {
  if (!isMacOS) return;
  const dockMenu = Menu.buildFromTemplate([
    {
      label: 'New Window',
      click: () => createWindow(),
    },
  ]);
  app.dock.setMenu(dockMenu);
}

function setupWindowsJumpList() {
  if (!isWindows) return;

  // Set consistent AppUserModelID for proper taskbar grouping
  app.setAppUserModelId(
    isDevelopment ? 'com.fatalmistake02.mira.dev' : 'com.fatalmistake02.mira',
  );
  if (isDevelopment) return;

  // Configure Windows Jump List for taskbar right-click menu
  app.setUserTasks([
    {
      program: process.execPath,
      arguments: '--new-window',
      iconPath: process.execPath,
      iconIndex: 0,
      title: 'New Window',
      description: 'Open a new Mira window',
    },
  ]);
}

function setupApplicationMenu() {
  const template = [
    ...(isMacOS
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            createWindow(focusedWindow && !focusedWindow.isDestroyed() ? focusedWindow : undefined);
          },
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (!focusedWindow || focusedWindow.isDestroyed()) return;
            focusedWindow.webContents.send('app-shortcut', 'reopen-closed-tab');
          },
        },
        { type: 'separator' },
        {
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+J',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (!focusedWindow || focusedWindow.isDestroyed()) return;
            focusedWindow.webContents.send('app-shortcut', 'open-downloads');
          },
        },
        {
          label: 'Print...',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (!focusedWindow || focusedWindow.isDestroyed()) return;
            focusedWindow.webContents.send('app-shortcut', 'print-page');
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Browser DevTools',
          accelerator: 'Command+Alt+I',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (!focusedWindow || focusedWindow.isDestroyed()) return;
            if (toggleFocusedBrowserDevTools()) return;
            markHostDevToolsSuppressedForShortcut(focusedWindow);
            focusedWindow.webContents.send('app-shortcut', 'toggle-devtools');
          },
        },
        {
          label: 'Toggle App DevTools',
          accelerator: 'CmdOrCtrl+Alt+Shift+J',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (!focusedWindow || focusedWindow.isDestroyed()) return;
            logDebug('shortcut', 'menu-toggle-app-devtools', {
              windowId: focusedWindow.id,
            });
            toggleWindowDevTools(focusedWindow);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getFirstBrowserWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !onboardingWindowIds.has(win.id))
    ?? null;
}

function loadRendererShell(win: BrowserWindow, options?: { onboarding?: boolean }): void {
  const onboarding = options?.onboarding === true;
  if (!app.isPackaged) {
    const onboardingQuery = onboarding ? '?onboarding=1' : '';
    win.loadURL(`http://localhost:5173${onboardingQuery}`);
    return;
  }

  if (onboarding) {
    win.loadFile('dist/index.html', {
      query: {
        onboarding: '1',
      },
    });
    return;
  }

  win.loadFile('dist/index.html');
}

function createOnboardingWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && onboardingWindowIds.has(win.id),
  );
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: 760,
    height: 540,
    minWidth: 760,
    minHeight: 540,
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#12161d',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  onboardingWindowIds.add(win.id);
  loadRendererShell(win, { onboarding: true });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });
  win.setMenuBarVisibility(false);

  win.on('closed', () => {
    onboardingWindowIds.delete(win.id);
  });

  return win;
}

function createWindow(
  sourceWindow?: BrowserWindow,
  initialUrl?: string,
  restoreSnapshot?: WindowSessionSnapshot,
  options?: {
    initialBounds?: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    maximize?: boolean;
    showInactive?: boolean;
  },
): BrowserWindow {
  const sourceBounds = sourceWindow && !sourceWindow.isDestroyed() ? sourceWindow.getBounds() : null;
  const restoreBounds = restoreSnapshot?.bounds;
  const requestedBounds = options?.initialBounds;
  const win = new BrowserWindow({
    x:
      restoreBounds
        ? restoreBounds.x
        : requestedBounds?.x
          ?? (sourceBounds ? sourceBounds.x + 24 : undefined),
    y:
      restoreBounds
        ? restoreBounds.y
        : requestedBounds?.y
          ?? (sourceBounds ? sourceBounds.y + 24 : undefined),
    width: restoreBounds ? restoreBounds.width : requestedBounds?.width ?? 1200,
    height: restoreBounds ? restoreBounds.height : requestedBounds?.height ?? 800,
    frame: isMacOS,
    titleBarStyle: isMacOS ? 'hiddenInset' : isWindows ? 'hidden' : undefined,
    titleBarOverlay: isWindows
      ? {
          color: '#00000000',
          symbolColor: '#e8edf5',
          height: 38,
        }
      : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#12161d',
    show: false,
    webPreferences: {
      // devTools: false,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isMacOS) {
    win.setWindowButtonVisibility(true);
  }
  if (isWindows) {
    const overlayState = getOrCreateTitleBarOverlayState(win);
    overlayState.color = DEFAULT_TITLEBAR_OVERLAY_COLOR;
    overlayState.symbolColor = DEFAULT_TITLEBAR_SYMBOL_COLOR;
    overlayState.height = DEFAULT_TITLEBAR_OVERLAY_HEIGHT;
    overlayState.preferNativeOverlay = true;
    overlayState.suppressForDockedDevToolsCount = 0;
    applyWindowTitleBarOverlay(win);
  }

  loadRendererShell(win);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      if (options?.showInactive) {
        win.showInactive();
      } else {
        win.show();
      }
    }
  });

  if (restoreSnapshot) {
    bootRestoreByWindowId.set(win.id, restoreSnapshot);
  }

  applyWindowStateFromSnapshot(win, restoreSnapshot);
  if (!restoreSnapshot && options?.maximize !== false) {
    win.maximize();
  }

  const normalizedInitialUrl = initialUrl?.trim();
  if (normalizedInitialUrl) {
    pendingInitialUrlByWindowId.set(win.id, normalizedInitialUrl);

    const deliverInitialUrlToRenderer = () => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('open-url-in-current-tab', normalizedInitialUrl);
      } catch {
        // Ignore send failures during teardown.
      }
    };

    // Bootstrap also consumes pendingInitialUrl via window-consume-initial-url; duplicate navigation
    // to the same URL is a no-op. This IPC runs after load so React has registered ipc listeners,
    // which fixes "new window" flows where bootstrap ordering misses the URL.
    const scheduleDeliverInitialUrl = () => {
      setTimeout(deliverInitialUrlToRenderer, 150);
    };

    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', scheduleDeliverInitialUrl);
    } else {
      scheduleDeliverInitialUrl();
    }
  } else {
    pendingInitialUrlByWindowId.delete(win.id);
  }

  win.setMenuBarVisibility(false);
  win.webContents.send('window-maximized-changed', win.isMaximized());
  win.webContents.send('window-fullscreen-changed', win.isFullScreen());

  win.webContents.on('render-process-gone', (_event, details) => {
    logDebug('renderer', 'window-render-process-gone', {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });

    if (isQuitting || win.isDestroyed()) return;
    if (details.reason === 'clean-exit') return;

    const now = Date.now();
    const lastRecoveryAt = recentRendererRecoveryByWindow.get(win.id) ?? 0;
    if (now - lastRecoveryAt < RENDERER_RECOVERY_COOLDOWN_MS) return;
    recentRendererRecoveryByWindow.set(win.id, now);

    setTimeout(() => {
      if (isQuitting || win.isDestroyed()) return;
      loadRendererShell(win);
    }, 150);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logDebug('renderer', 'window-main-frame-failed-load', {
      windowId: win.id,
      errorCode,
      errorDescription,
      url: validatedURL,
    });
  });

  win.on('maximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window-maximized-changed', true);
    }
  });

  win.on('unmaximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window-maximized-changed', false);
    }
  });

  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window-fullscreen-changed', true);
    }
  });

  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window-fullscreen-changed', false);
    }
  });

  win.on('closed', () => {
    stopDetachedWindowDragSession(win.id);
    for (const [requestId, pendingRequest] of pendingSitePermissionRequests.entries()) {
      if (pendingRequest.hostWindowId !== win.id) continue;
      pendingSitePermissionRequests.delete(requestId);
      pendingRequest.callback(false);
    }
    for (const [webContentsId, pendingCloseRequest] of pendingWebviewCloseRequestsByWebContentsId.entries()) {
      if (pendingCloseRequest.hostWindowId !== win.id) continue;
      pendingWebviewCloseRequestsByWebContentsId.delete(webContentsId);
    }
    const pendingDetachedTransfer = pendingDetachedTabTransferByWindowId.get(win.id);
    if (pendingDetachedTransfer) {
      stopDetachedWindowDragSession(pendingDetachedTransfer.sourceWindowId);
      pendingDetachedTabTransferByWindowId.delete(win.id);
      detachedTabTransferById.delete(pendingDetachedTransfer.transferId);
    }
    for (const [transferId, transfer] of detachedTabTransferById.entries()) {
      if (transfer.targetWindowId !== win.id) continue;
      stopDetachedWindowDragSession(transfer.sourceWindowId);
      detachedTabTransferById.delete(transferId);
    }
    bootRestoreByWindowId.delete(win.id);
    windowTitleBarOverlayState.delete(win.id);
    recentRendererRecoveryByWindow.delete(win.id);
    pendingInitialUrlByWindowId.delete(win.id);
    const noWindowsRemaining = BrowserWindow.getAllWindows().length === 0;

    // Do not remove this snapshot immediately. Users may be closing windows
    // in quick succession to quit the app, and we need all windows restorable.
    // If the app keeps running, remove the closed window shortly after.
    if (!isQuitting && !noWindowsRemaining) {
      const existingTimer = pendingClosedWindowCleanupTimers.get(win.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      const cleanupTimer = setTimeout(() => {
        pendingClosedWindowCleanupTimers.delete(win.id);
        if (isQuitting) return;
        if (BrowserWindow.getAllWindows().length === 0) return;
        windowSessionCache.delete(win.id);
        scheduleSessionPersist();
      }, 2000);
      cleanupTimer.unref();
      pendingClosedWindowCleanupTimers.set(win.id, cleanupTimer);
      return;
    }

    if (!isQuitting) {
      scheduleSessionPersist();
    }
  });

  const onWindowBoundsChanged = () => {
    if (isQuitting) return;
    const existing = windowSessionCache.get(win.id);
    if (!existing) return;

    windowSessionCache.set(win.id, {
      ...existing,
      bounds: win.getBounds(),
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
      savedAt: Date.now(),
    });
    scheduleSessionPersist();
  };

  win.on('move', onWindowBoundsChanged);
  win.on('resize', onWindowBoundsChanged);
  win.on('maximize', onWindowBoundsChanged);
  win.on('unmaximize', onWindowBoundsChanged);
  win.on('enter-full-screen', onWindowBoundsChanged);
  win.on('leave-full-screen', onWindowBoundsChanged);
  win.webContents.on('devtools-opened', () => {
    if (!shouldSuppressHostDevTools(win)) return;
    if (win.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools();
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const key = input.key.toLowerCase();
    const hasPrimaryModifier = input.control || input.meta;
    const isPrimaryChord = hasPrimaryModifier && !input.shift;
    const isReloadChord = isPrimaryChord && key === 'r';
    const isHardReloadChord = hasPrimaryModifier && input.shift && key === 'r';
    const isHardReloadFunctionKey = hasPrimaryModifier && key === 'f5';
    const isFindChord = isPrimaryChord && key === 'f';
    const isNewWindowChord = isPrimaryChord && key === 'n';
    const isNextTabChord = isPrimaryChord && key === 'tab';
    const isPreviousTabChord = hasPrimaryModifier && input.shift && key === 'tab';
    const tabNumberShortcut = isPrimaryChord && /^[1-9]$/.test(key)
      ? Number.parseInt(key, 10)
      : null;
    const isDownloadsChord = isPrimaryChord && key === 'j';
    const isPrintChord = isPrimaryChord && key === 'p';
    const isReopenClosedTabChord = hasPrimaryModifier && input.shift && key === 't';
    const isAppDevToolsChord = hasPrimaryModifier && input.alt && input.shift && key === 'j';
    const isBrowserConsoleChord = isMacOS
      ? input.meta && input.alt && key === 'j'
      : hasPrimaryModifier && input.shift && key === 'j';
    const isReloadKey = key === 'f5';
    const isDevToolsChord = key === 'f12' || isBrowserConsoleChord || (isMacOS
      ? input.meta && input.alt && key === 'i'
      : (input.meta && input.shift && key === 'i') || (input.control && input.shift && key === 'i'));

    if (isHardReloadChord || isHardReloadFunctionKey) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'reload-tab-ignore-cache');
      return;
    }

    if (isReloadChord || isReloadKey) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'reload-tab');
      return;
    }

    if (isNewWindowChord) {
      event.preventDefault();
      triggerNewWindowFromShortcut(win);
      return;
    }

    if (isNextTabChord) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'activate-next-tab');
      return;
    }

    if (isPreviousTabChord) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'activate-previous-tab');
      return;
    }

    if (tabNumberShortcut !== null) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'activate-tab-index', tabNumberShortcut);
      return;
    }

    if (isFindChord) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'find-in-page');
      return;
    }

    if (isDownloadsChord) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'open-downloads');
      return;
    }

    if (isPrintChord) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'print-page');
      return;
    }

    if (isReopenClosedTabChord) {
      event.preventDefault();
      win.webContents.send('app-shortcut', 'reopen-closed-tab');
      return;
    }

    if (isAppDevToolsChord) {
      event.preventDefault();
      logDebug('shortcut', 'app-devtools-shortcut-from-window', {
        windowId: win.id,
        key,
        control: input.control,
        meta: input.meta,
        shift: input.shift,
      });
      toggleWindowDevTools(win);
      return;
    }

    if (isDevToolsChord) {
      event.preventDefault();
      if (toggleFocusedBrowserDevTools()) {
        return;
      }
      markHostDevToolsSuppressedForShortcut(win);
      win.webContents.send('app-shortcut', 'toggle-devtools');
    }
  });

  return win;
}

function routeIncomingBrowserUrl(rawUrl: string): void {
  const normalized = normalizeIncomingBrowserUrl(rawUrl);
  if (!normalized) return;

  const focusedWindow = BrowserWindow.getFocusedWindow();
  const focusedBrowserWindow =
    focusedWindow && !focusedWindow.isDestroyed() && !onboardingWindowIds.has(focusedWindow.id)
      ? focusedWindow
      : null;
  const fallbackWindow = getFirstBrowserWindow();
  const targetWindow = focusedBrowserWindow ?? fallbackWindow;

  if (targetWindow && !targetWindow.isDestroyed()) {
    if (targetWindow.isMinimized()) targetWindow.restore();
    targetWindow.focus();
    if (targetWindow.webContents.isLoadingMainFrame()) {
      enqueueIncomingBrowserUrl(normalized);
      return;
    }
    targetWindow.webContents.send('open-url-in-new-tab', normalized);
    return;
  }

  enqueueIncomingBrowserUrl(normalized);
  createWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  const launchUrlFromArgs = extractIncomingBrowserUrlFromArgv(process.argv);
  if (launchUrlFromArgs) {
    enqueueIncomingBrowserUrl(launchUrlFromArgs);
  }

  app.on('second-instance', (_event, commandLine) => {
    // Check if this was triggered by the Jump List "New Window" task
    if (commandLine.includes('--new-window')) {
      if (app.isReady()) {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        createWindow(focusedWindow && !focusedWindow.isDestroyed() ? focusedWindow : undefined);
      }
      return;
    }

    const incomingUrl = extractIncomingBrowserUrlFromArgv(commandLine);
    if (incomingUrl) {
      if (app.isReady()) {
        routeIncomingBrowserUrl(incomingUrl);
      } else {
        enqueueIncomingBrowserUrl(incomingUrl);
      }
      return;
    }

    const firstWindow =
      getFirstBrowserWindow()
      ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
      ?? null;
    if (!firstWindow) return;
    if (firstWindow.isMinimized()) firstWindow.restore();
    firstWindow.focus();
  });

  if (isMacOS) {
    app.on('open-url', (event, url) => {
      event.preventDefault();
      if (app.isReady()) {
        routeIncomingBrowserUrl(url);
        return;
      }
      enqueueIncomingBrowserUrl(url);
    });

    app.on('open-file', (event, filePath) => {
      event.preventDefault();
      const fileUrl = pathToFileURL(filePath).toString();
      if (app.isReady()) {
        routeIncomingBrowserUrl(fileUrl);
        return;
      }
      enqueueIncomingBrowserUrl(fileUrl);
    });
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  logDebug('startup', 'logger-ready', {
    packaged: app.isPackaged,
    platform: process.platform,
    userData: getSafeUserDataPath(),
    pid: process.pid,
  });

  // Best-effort registration for the custom mira:// protocol so OS deep links open in Mira.
  setAsDefaultForProtocol('mira');

  await loadHistory().catch(() => undefined);
  await loadCachedAdBlockHosts().catch(() => undefined);
  await loadBundledTrackerBlockHosts().catch(() => undefined);
  await loadPersistedAppState().catch(() => undefined);
  await loadPersistedSitePermissions().catch(() => undefined);
  await loadPersistedSessionSnapshot().catch(() => undefined);
  setupHistoryHandlers();
  setupVersionExposure();
  setupVersionHandlers();
  setupPerformanceHandlers();
  setupSessionHandlers();
  setupSitePermissionHandlers();
  setupUpdateHandlers();
  setupWebviewTabOpenHandler();
  setupAdBlocker();
  setupMainFrameHttpErrorReporter();
  setupWindowControlsHandlers();
  setupMailtoHandlers();
  setupDefaultBrowserHandlers();
  setupIncomingUrlHandlers();
  setupOnboardingHandlers();
  setupApplicationMenu();
  setupMacDockMenu();
  setupWindowsJumpList();
  scheduleAdBlockListRefresh();
  setupDownloadHandlers();

  if (shouldShowOnboarding()) {
    createOnboardingWindow();
  } else {
    createWindow();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (shouldShowOnboarding()) {
      createOnboardingWindow();
    } else {
      createWindow();
    }
  }
});

app.on('window-all-closed', () => {
  if (!isMacOS) {
    app.quit();
    return;
  }

  if (quitOnLastWindowClose) {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  for (const pendingRequest of pendingSitePermissionRequests.values()) {
    pendingRequest.callback(false);
  }
  pendingSitePermissionRequests.clear();
  pendingWebviewCloseRequestsByWebContentsId.clear();
  for (const timer of pendingClosedWindowCleanupTimers.values()) {
    clearTimeout(timer);
  }
  pendingClosedWindowCleanupTimers.clear();
  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer);
    sessionPersistTimer = null;
  }
  persistSessionSnapshotSync();
});
