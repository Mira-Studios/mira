import { THEME_SCHEMA_VERSION, type Theme, type ThemeMode } from '../../themes/types';
import { normalizeBackgroundImageUrl } from '../../themes/backgroundImage';

const modules = import.meta.glob('../../themes/*.json', { eager: true });

const CUSTOM_THEME_STORAGE_KEY = 'mira.themes.custom.v1';
export const DEFAULT_THEME_ID = 'default_dark';
export const DEFAULT_LIGHT_THEME_ID = 'default_light';
const CSS_VAR_PATTERN = /^var\(\s*--[a-zA-Z0-9_-]+(?:\s*,\s*.+)?\)$/;
const DEFAULT_THEME_FONTS: Record<string, string> = {
  fontPrimaryFamily: "'Segoe UI'",
  fontSecondaryFamily: "'Segoe UI'",
  fontPrimaryWeight: '400',
  fontSecondaryWeight: '300',
};

type StoredTheme = { id: string; theme: Theme };

export type ThemeEntry = {
  id: string;
  theme: Theme;
  source: 'bundled' | 'custom';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const raw = value.trim();
  if (!raw.startsWith('#')) return null;

  const hex = raw.slice(1);
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r, g, b };
  }

  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r, g, b };
  }

  return null;
}

function inferThemeMode(colors: Record<string, string>): 'light' | 'dark' {
  const sample = colors.bg || colors.tabBg || colors.urlBarBg || '';
  const rgb = parseHexColor(sample);
  if (!rgb) return 'dark';

  // Relative luminance approximation (sRGB)
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luminance >= 0.5 ? 'light' : 'dark';
}

function normalizeTheme(value: unknown): Theme | null {
  if (!isRecord(value)) return null;

  const versionRaw = typeof value.version === 'string' ? value.version.trim().toLowerCase() : '';
  // Accept both "1" and "v1" for backwards compatibility with existing theme files
  const normalizedVersion = versionRaw.replace(/^v/, '');
  const expectedVersion = THEME_SCHEMA_VERSION.replace(/^v/, '');
  if (versionRaw && normalizedVersion !== expectedVersion) return null;

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const author = typeof value.author === 'string' ? value.author.trim() : '';
  if (!name || !author) return null;

  if (!isRecord(value.colors)) return null;

  const colors: Record<string, string> = {};
  Object.entries(value.colors).forEach(([key, raw]) => {
    if (!key || typeof raw !== 'string') return;
    colors[key] = raw;
  });
  const fonts: Record<string, string> = {};
  if (isRecord(value.fonts)) {
    Object.entries(value.fonts).forEach(([key, raw]) => {
      if (!key || typeof raw !== 'string') return;
      fonts[key] = raw;
    });
  }

  if (!Object.keys(colors).length) return null;
  const modeRaw = typeof value.mode === 'string' ? value.mode.trim().toLowerCase() : '';
  const mode = modeRaw === 'light' || modeRaw === 'dark' ? modeRaw : inferThemeMode(colors);

  return {
    version: THEME_SCHEMA_VERSION,
    name,
    author,
    mode,
    colors,
    fonts,
    ...(normalizeBackgroundImageUrl(value.backgroundImageUrl)
      ? { backgroundImageUrl: normalizeBackgroundImageUrl(value.backgroundImageUrl) } : {}),
  };
}

function supportsCssValue(property: string, value: string): boolean {
  const css = globalThis.CSS;
  if (!css || typeof css.supports !== 'function') return true;
  try {
    return css.supports(property, value);
  } catch {
    return false;
  }
}

function isValidThemeColorValue(key: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (CSS_VAR_PATTERN.test(trimmed)) return true;
  if (key.toLowerCase().includes('opacity')) {
    return supportsCssValue('opacity', trimmed);
  }
  if (key.toLowerCase().includes('shadow')) {
    return supportsCssValue('box-shadow', trimmed);
  }
  return supportsCssValue('color', trimmed);
}

function isValidThemeFontValue(key: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (CSS_VAR_PATTERN.test(trimmed)) return true;
  if (key.toLowerCase().includes('weight')) {
    return supportsCssValue('font-weight', trimmed);
  }
  if (key.toLowerCase().includes('family')) {
    return supportsCssValue('font-family', trimmed);
  }
  return supportsCssValue('font', trimmed);
}

function resolveThemeWithModeFallbackInternal(
  theme: Theme,
  baseColorsByMode: Record<ThemeMode, Record<string, string>>,
  baseFontsByMode: Record<ThemeMode, Record<string, string>>,
): Theme {
  const baseColors = baseColorsByMode[theme.mode] ?? {};
  const allKeys = new Set([...Object.keys(baseColors), ...Object.keys(theme.colors)]);
  const colors: Record<string, string> = {};

  for (const key of allKeys) {
    const raw = theme.colors[key];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed && isValidThemeColorValue(key, trimmed)) {
        colors[key] = trimmed;
        continue;
      }
    }

    const fallback = baseColors[key];
    if (typeof fallback === 'string' && fallback.trim()) {
      colors[key] = fallback.trim();
    }
  }
  const baseFonts = baseFontsByMode[theme.mode] ?? DEFAULT_THEME_FONTS;
  const themeFonts = theme.fonts ?? {};
  const fontKeys = new Set([...Object.keys(baseFonts), ...Object.keys(themeFonts)]);
  const fonts: Record<string, string> = {};

  for (const key of fontKeys) {
    const raw = themeFonts[key];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed && isValidThemeFontValue(key, trimmed)) {
        fonts[key] = trimmed;
        continue;
      }
    }

    const fallback = baseFonts[key];
    if (typeof fallback === 'string' && fallback.trim()) {
      fonts[key] = fallback.trim();
    }
  }

  return {
    ...theme,
    colors,
    fonts,
  };
}

function moduleToTheme(moduleValue: unknown): Theme | null {
  if (!isRecord(moduleValue)) return normalizeTheme(moduleValue);

  if ('default' in moduleValue) {
    return normalizeTheme(moduleValue.default);
  }

  return normalizeTheme(moduleValue);
}

function pathToThemeId(path: string): string | null {
  const match = path.match(/\/([^/]+)\.json$/);
  if (!match) return null;
  return match[1].trim();
}

const bundledThemesRaw: ThemeEntry[] = Object.entries(modules).flatMap(([path, moduleValue]) => {
  const id = pathToThemeId(path);
  const theme = moduleToTheme(moduleValue);
  if (!id || !theme) return [];
  return [{ id, theme, source: 'bundled' as const }];
});

const defaultDarkBaseColors =
  bundledThemesRaw.find((entry) => entry.id === 'default_dark')?.theme.colors ?? {};
const defaultLightBaseColors =
  bundledThemesRaw.find((entry) => entry.id === 'default_light')?.theme.colors ?? {};
const defaultDarkBaseFonts =
  bundledThemesRaw.find((entry) => entry.id === 'default_dark')?.theme.fonts ?? {};
const defaultLightBaseFonts =
  bundledThemesRaw.find((entry) => entry.id === 'default_light')?.theme.fonts ?? {};
const baseColorsByMode: Record<ThemeMode, Record<string, string>> = {
  dark: Object.keys(defaultDarkBaseColors).length ? defaultDarkBaseColors : defaultLightBaseColors,
  light: Object.keys(defaultLightBaseColors).length
    ? defaultLightBaseColors
    : defaultDarkBaseColors,
};
const baseFontsByMode: Record<ThemeMode, Record<string, string>> = {
  dark: {
    ...DEFAULT_THEME_FONTS,
    ...(Object.keys(defaultDarkBaseFonts).length ? defaultDarkBaseFonts : defaultLightBaseFonts),
  },
  light: {
    ...DEFAULT_THEME_FONTS,
    ...(Object.keys(defaultLightBaseFonts).length ? defaultLightBaseFonts : defaultDarkBaseFonts),
  },
};

/**
 * Ensures a theme has valid color/font values, filling missing tokens from mode defaults.
 */
export function resolveThemeWithModeFallback(theme: Theme): Theme {
  return resolveThemeWithModeFallbackInternal(theme, baseColorsByMode, baseFontsByMode);
}

const bundledThemes: ThemeEntry[] = bundledThemesRaw.map((entry) => ({
  ...entry,
  theme: resolveThemeWithModeFallback(entry.theme),
}));

function readCustomThemes(): StoredTheme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const theme = normalizeTheme(entry.theme);
        if (!id || !theme) return null;
        return { id, theme: resolveThemeWithModeFallback(theme) };
      })
      .filter((entry): entry is StoredTheme => entry !== null);
  } catch {
    return [];
  }
}

function writeCustomThemes(themes: StoredTheme[]) {
  try {
    localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(themes));
  } catch {
    // Ignore storage failures.
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createCustomThemeId(theme: Theme, existingIds: Set<string>): string {
  const base =
    `${slugify(theme.name)}-${slugify(theme.author)}`.replace(/^-+|-+$/g, '') || 'custom-theme';
  let candidate = base;
  let counter = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/**
 * Returns bundled and custom themes merged by id, with custom entries taking precedence.
 */
export function getAllThemes(): ThemeEntry[] {
  const customEntries: ThemeEntry[] = readCustomThemes().map((entry) => ({
    id: entry.id,
    theme: entry.theme,
    source: 'custom',
  }));

  const byId = new Map<string, ThemeEntry>();
  bundledThemes.forEach((entry) => byId.set(entry.id, entry));
  customEntries.forEach((entry) => byId.set(entry.id, entry));

  return Array.from(byId.values());
}

/**
 * Resolves a theme by id and falls back to the configured default theme.
 */
export function getThemeById(themeId: string | null | undefined): Theme | null {
  const allThemes = getAllThemes();
  const selected = allThemes.find((entry) => entry.id === themeId);
  if (selected) return selected.theme;

  const fallback = allThemes.find((entry) => entry.id === DEFAULT_THEME_ID) ?? allThemes[0];
  return fallback?.theme ?? null;
}

/**
 * Validates and imports a custom theme JSON payload into local storage.
 */
export function importThemeFromJson(jsonText: string): ThemeEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Theme JSON is invalid.');
  }

  const theme = normalizeTheme(parsed);
  if (!theme) {
    throw new Error(
      'Theme JSON must be version v1 and include name, author, and a colors object with string values. Fonts are optional.',
    );
  }
  const themeWithFallback = resolveThemeWithModeFallback(theme);

  const customThemes = readCustomThemes();
  const existingIds = new Set(getAllThemes().map((entry) => entry.id));
  const id = createCustomThemeId(themeWithFallback, existingIds);
  const storedTheme: StoredTheme = { id, theme: themeWithFallback };

  customThemes.push(storedTheme);
  writeCustomThemes(customThemes);

  return {
    id,
    theme: themeWithFallback,
    source: 'custom',
  };
}

/**
 * Removes a custom theme by id.
 */
export function deleteCustomTheme(themeId: string): boolean {
  const customThemes = readCustomThemes();
  const nextCustomThemes = customThemes.filter((entry) => entry.id !== themeId);

  if (nextCustomThemes.length === customThemes.length) {
    return false;
  }

  writeCustomThemes(nextCustomThemes);
  return true;
}
