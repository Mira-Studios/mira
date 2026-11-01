import { useEffect, useMemo, useState } from 'react';
import { applyTheme } from '../features/themes/applyTheme';
import {
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  getAllThemes,
  getThemeById,
  importThemeFromJson,
  resolveThemeWithModeFallback,
  type ThemeEntry,
} from '../features/themes/themeLoader';
import { getBrowserSettings, saveBrowserSettings } from '../features/settings/browserSettings';
import { THEME_SCHEMA_VERSION, type Theme, type ThemeMode } from '../themes/types';
import { getThemeColorDisplayName } from '../themes/colorVariableToDisplayName';

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CSS_VAR_PATTERN = /^var\(\s*--([a-zA-Z0-9_-]+)(?:\s*,.+)?\)$/;
type RGBAColor = { r: number; g: number; b: number; a: number };
const THEME_FONT_DISPLAY_NAMES: Record<string, string> = {
  fontPrimaryFamily: 'Primary Font Family',
  fontSecondaryFamily: 'Secondary Font Family',
  fontPrimaryWeight: 'Primary Font Weight',
  fontSecondaryWeight: 'Secondary Font Weight',
};
const DEFAULT_FONT_SELECT_VALUE = '__theme_default__';
type FontOption = { label: string; value: string };
type LocalFontRecord = { family?: string };
type FontQueryGlobal = typeof globalThis & {
  queryLocalFonts?: () => Promise<LocalFontRecord[]>;
};
const BUILT_IN_FONT_FAMILIES = [
  'Abel',
  'Abril Fatface',
  'Alegreya',
  'Alegreya Sans',
  'Alegreya Sans SC',
  'Alegreya SC',
  'Alfa Slab One',
  'Amaranth',
  'Amatic SC',
  'Andale Mono',
  'Anton',
  'Aptos',
  'Arimo',
  'Archivo',
  'Archivo Black',
  'Archivo Narrow',
  'Arvo',
  'Asap',
  'Asap Condensed',
  'Atkinson Hyperlegible',
  'Avenir',
  'Avenir Next',
  'Arial',
  'Arial Black',
  'Bai Jamjuree',
  'Bahnschrift',
  'Barlow',
  'Barlow Condensed',
  'Barlow Semi Condensed',
  'Baskerville',
  'Bebas Neue',
  'Bell MT',
  'Bitter',
  'Book Antiqua',
  'Bookman Old Style',
  'Bree Serif',
  'Brush Script MT',
  'Cabin',
  'Calibri',
  'Calisto MT',
  'Cambria',
  'Cambria Math',
  'Candal',
  'Candara',
  'Cardo',
  'Carlito',
  'Catamaran',
  'Century Gothic',
  'Charter',
  'Chivo',
  'Cinzel',
  'Clear Sans',
  'Comfortaa',
  'Cormorant',
  'Cormorant Garamond',
  'Courgette',
  'Comic Sans MS',
  'Cooper Black',
  'Consolas',
  'Constantia',
  'Corbel',
  'Crimson Text',
  'DM Mono',
  'DM Sans',
  'DM Serif Display',
  'DM Serif Text',
  'Dancing Script',
  'Didot',
  'Dosis',
  'EB Garamond',
  'Exo 2',
  'Fantasque Sans Mono',
  'Faustina',
  'Figtree',
  'Fira Code',
  'Fira Mono',
  'Fira Sans',
  'Frank Ruhl Libre',
  'Franklin Gothic Medium',
  'Fraunces',
  'Freight Text',
  'GFS Didot',
  'Gadugi',
  'Garamond',
  'Geneva',
  'Gentium Plus',
  'Georgia',
  'Gilda Display',
  'Glegoo',
  'Gloria Hallelujah',
  'Graphik',
  'Heebo',
  'Hind',
  'Hind Siliguri',
  'Hoefler Text',
  'Homenaje',
  'Helvetica',
  'Helvetica Neue',
  'IBM Plex Mono',
  'IBM Plex Sans',
  'IBM Plex Serif',
  'Ibarra Real Nova',
  'Inconsolata',
  'Impact',
  'Inter',
  'Instrument Sans',
  'Instrument Serif',
  'JetBrains Mono',
  'Josefin Sans',
  'Jost',
  'Karla',
  'Kreon',
  'Laila',
  'Lato',
  'League Gothic',
  'Lexend',
  'Libre Baskerville',
  'Libre Caslon Text',
  'Libre Franklin',
  'Literata',
  'Lora',
  'Lucida Bright',
  'Lucida Console',
  'Lucida Fax',
  'Lucida Grande',
  'Lucida Sans',
  'M PLUS 1p',
  'M PLUS Rounded 1c',
  'MS Gothic',
  'MS Mincho',
  'MS PGothic',
  'MS PMincho',
  'Manrope',
  'Marcellus',
  'Merriweather',
  'Merriweather Sans',
  'Mina',
  'MingLiU',
  'Monaco',
  'Montserrat',
  'Mukta',
  'Mulish',
  'Nanum Gothic',
  'Nanum Myeongjo',
  'Newsreader',
  'Noto Color Emoji',
  'Noto Emoji',
  'Noto Kufi Arabic',
  'Noto Naskh Arabic',
  'Noto Sans',
  'Noto Sans Arabic',
  'Noto Sans CJK JP',
  'Noto Sans CJK KR',
  'Noto Sans CJK SC',
  'Noto Sans CJK TC',
  'Noto Sans Hebrew',
  'Noto Sans JP',
  'Noto Sans KR',
  'Noto Sans Mono',
  'Noto Sans SC',
  'Noto Sans TC',
  'Noto Serif',
  'Noto Serif JP',
  'Noto Serif KR',
  'Noto Serif SC',
  'Noto Serif TC',
  'Nunito',
  'Nunito Sans',
  'OCR A Std',
  'Old Standard TT',
  'Open Sans',
  'Open Sans Condensed',
  'Optima',
  'Orbitron',
  'Oswald',
  'PT Mono',
  'PT Sans',
  'PT Sans Caption',
  'PT Sans Narrow',
  'PT Serif',
  'Palatino',
  'Palatino Linotype',
  'Papyrus',
  'Parchment',
  'Passion One',
  'Play',
  'Playfair Display',
  'Plus Jakarta Sans',
  'Poppins',
  'Prata',
  'Proxima Nova',
  'Public Sans',
  'Quattrocento',
  'Quattrocento Sans',
  'Questrial',
  'Quicksand',
  'Raleway',
  'Red Hat Display',
  'Red Hat Text',
  'Roboto',
  'Roboto Condensed',
  'Roboto Flex',
  'Roboto Mono',
  'Roboto Serif',
  'Rockwell',
  'Rubik',
  'Sarabun',
  'Segoe Print',
  'Segoe Script',
  'Segoe UI',
  'Segoe UI Emoji',
  'Segoe UI Historic',
  'Segoe UI Symbol',
  'Shrikhand',
  'Signika',
  'SimHei',
  'SimSun',
  'Source Code Pro',
  'Source Sans 3',
  'Source Serif 4',
  'Space Grotesk',
  'Space Mono',
  'Spectral',
  'Tahoma',
  'Teko',
  'Times',
  'Times New Roman',
  'Titillium Web',
  'Trebuchet MS',
  'Ubuntu',
  'Ubuntu Condensed',
  'Ubuntu Mono',
  'Varela Round',
  'Verdana',
  'Volkhov',
  'Work Sans',
  'Yu Gothic',
  'Yu Gothic UI',
  'Yu Mincho',
  'Zapf Chancery',
  'Zapfino',
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
];

function formatFontFamilyValue(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  const escaped = trimmed.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  return `'${escaped}'`;
}

function createFontFamilyOptions(fontFamilies: string[]): FontOption[] {
  const seen = new Set<string>();
  const options: FontOption[] = [];

  fontFamilies.forEach((fontFamily) => {
    const trimmed = fontFamily.trim();
    if (!trimmed) return;

    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    options.push({
      label: trimmed,
      value: formatFontFamilyValue(trimmed),
    });
  });

  options.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return options;
}

function getThemeFontDisplayName(key: string): string {
  return THEME_FONT_DISPLAY_NAMES[key] ?? key;
}

function getFontPreviewFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) {
    return "var(--fontPrimaryFallbackFamily, 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif)";
  }
  return `${trimmed}, var(--fontPrimaryFallbackFamily, 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif)`;
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null;

  if (trimmed.length === 4) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  if (trimmed.length === 5) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    const a = trimmed[4];
    return `#${r}${r}${g}${g}${b}${b}${a}${a}`.toLowerCase();
  }

  return trimmed.toLowerCase();
}

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${clampChannel(r).toString(16).padStart(2, '0')}${clampChannel(g)
    .toString(16)
    .padStart(2, '0')}${clampChannel(b).toString(16).padStart(2, '0')}`;
}

function rgbToHexWithAlpha(r: number, g: number, b: number, a: number): string {
  const alpha = Math.max(0, Math.min(1, a));
  const alphaHex = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${rgbToHex(r, g, b)}${alphaHex}`;
}

function parseColorToRgba(value: string): RGBAColor | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const hex = normalizeHexColor(raw);
  if (hex) {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    const a = hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1;
    return { r, g, b, a };
  }

  const rgbaMatch = raw.match(
    /^rgba?\(\s*([0-9]{1,3})\s*[, ]\s*([0-9]{1,3})\s*[, ]\s*([0-9]{1,3})(?:\s*[,/]\s*([0-9.]+))?\s*\)$/,
  );
  if (!rgbaMatch) return null;

  const r = clampChannel(Number.parseInt(rgbaMatch[1], 10));
  const g = clampChannel(Number.parseInt(rgbaMatch[2], 10));
  const b = clampChannel(Number.parseInt(rgbaMatch[3], 10));
  const aRaw = rgbaMatch[4];
  const parsedAlpha = aRaw === undefined ? 1 : Number.parseFloat(aRaw);
  const a = Number.isFinite(parsedAlpha) ? Math.max(0, Math.min(1, parsedAlpha)) : 1;
  return { r, g, b, a };
}

function parseRgbLikeToHex(value: string): string | null {
  const parsed = parseColorToRgba(value);
  if (!parsed) return null;
  return rgbToHex(parsed.r, parsed.g, parsed.b);
}

function resolveColorValue(
  key: string,
  colors: Record<string, string>,
  fallbackColors: Record<string, string>,
  visited: Set<string>,
): string | null {
  if (visited.has(key)) return null;
  visited.add(key);

  const ownValue = colors[key];
  const fallbackValue = fallbackColors[key];
  const candidate = (
    typeof ownValue === 'string' && ownValue.trim()
      ? ownValue
      : typeof fallbackValue === 'string'
        ? fallbackValue
        : ''
  ).trim();
  if (!candidate) return null;

  const varMatch = candidate.match(CSS_VAR_PATTERN);
  if (varMatch) {
    return resolveColorValue(varMatch[1], colors, fallbackColors, visited);
  }

  return candidate;
}

function resolveHexColorValue(
  key: string,
  colors: Record<string, string>,
  fallbackColors: Record<string, string>,
): string | null {
  const candidate = resolveColorValue(key, colors, fallbackColors, new Set<string>());
  if (!candidate) return null;

  const normalizedHex = normalizeHexColor(candidate);
  if (normalizedHex) return normalizedHex;

  return null;
}

function getColorPickerValue(
  key: string,
  colors: Record<string, string>,
  fallbackColors: Record<string, string>,
): string {
  const resolved = resolveColorValue(key, colors, fallbackColors, new Set<string>()) ?? '';
  return (
    resolveHexColorValue(key, colors, fallbackColors) ?? parseRgbLikeToHex(resolved) ?? '#000000'
  );
}

function getResolvedRgbaForEditor(
  key: string,
  colors: Record<string, string>,
  fallbackColors: Record<string, string>,
): RGBAColor {
  const resolved = resolveColorValue(key, colors, fallbackColors, new Set<string>()) ?? '';
  return parseColorToRgba(resolved) ?? { r: 0, g: 0, b: 0, a: 1 };
}

function formatColorWithOpacity(r: number, g: number, b: number, opacityPercent: number): string {
  const clampedOpacity = Math.max(0, Math.min(100, Math.round(opacityPercent)));
  if (clampedOpacity <= 0) return 'transparent';

  const alpha = clampedOpacity / 100;
  if (alpha >= 1) return rgbToHex(r, g, b);
  return rgbToHexWithAlpha(r, g, b, alpha);
}

function parseOpacityPercent(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, parsed));
}

function createEditableColors(baseTheme: Theme, fallbackTheme: Theme): Record<string, string> {
  const allKeys = Object.keys(fallbackTheme.colors).sort();
  const result: Record<string, string> = {};
  allKeys.forEach((key) => {
    const baseRaw = baseTheme.colors[key];
    if (typeof baseRaw !== 'string') {
      result[key] = '';
      return;
    }

    const normalized = normalizeHexColor(baseRaw);
    result[key] = normalized ?? baseRaw;
  });
  return result;
}

function createEditableFonts(baseTheme: Theme, fallbackTheme: Theme): Record<string, string> {
  const fallbackFonts = fallbackTheme.fonts ?? {};
  const allKeys = Object.keys(fallbackFonts).sort();
  const result: Record<string, string> = {};
  allKeys.forEach((key) => {
    const baseRaw = typeof baseTheme.fonts?.[key] === 'string' ? baseTheme.fonts[key].trim() : '';
    const fallbackRaw = typeof fallbackFonts[key] === 'string' ? fallbackFonts[key].trim() : '';
    if (key === 'fontPrimaryFamily' || key === 'fontSecondaryFamily') {
      result[key] = !baseRaw || baseRaw === fallbackRaw ? '' : baseRaw;
      return;
    }

    result[key] = baseRaw || fallbackRaw;
  });
  return result;
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export default function ThemeCreator() {
  const [themes, setThemes] = useState<ThemeEntry[]>(() => getAllThemes());
  const settingsThemeId = getBrowserSettings().themeId;
  const initialThemeEntry =
    themes.find((entry) => entry.id === settingsThemeId) ?? themes[0] ?? null;
  const defaultDarkTheme =
    themes.find((entry) => entry.id === DEFAULT_THEME_ID)?.theme ??
    initialThemeEntry?.theme ??
    themes[0]?.theme;
  const defaultLightTheme =
    themes.find((entry) => entry.id === DEFAULT_LIGHT_THEME_ID)?.theme ?? defaultDarkTheme;

  const [baseThemeId, setBaseThemeId] = useState<string>(initialThemeEntry?.id ?? '');
  const [themeName, setThemeName] = useState('My Theme');
  const [themeAuthor, setThemeAuthor] = useState('Me');
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    initialThemeEntry?.theme.mode ?? defaultDarkTheme?.mode ?? 'dark',
  );
  const [colors, setColors] = useState<Record<string, string>>(() =>
    initialThemeEntry && defaultDarkTheme
      ? createEditableColors(
          initialThemeEntry.theme,
          initialThemeEntry.theme.mode === 'light'
            ? (defaultLightTheme ?? defaultDarkTheme)
            : defaultDarkTheme,
        )
      : {},
  );
  const [fonts, setFonts] = useState<Record<string, string>>(() =>
    initialThemeEntry && defaultDarkTheme
      ? createEditableFonts(
          initialThemeEntry.theme,
          initialThemeEntry.theme.mode === 'light'
            ? (defaultLightTheme ?? defaultDarkTheme)
            : defaultDarkTheme,
        )
      : {},
  );
  const [fontFamilyOptions, setFontFamilyOptions] = useState<FontOption[]>(() =>
    createFontFamilyOptions(BUILT_IN_FONT_FAMILIES),
  );
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(true);
  const [exportMessage, setExportMessage] = useState('');

  const selectedThemeEntry: ThemeEntry | null =
    themes.find((entry) => entry.id === baseThemeId) ?? initialThemeEntry;
  const fallbackThemeForMode = useMemo(() => {
    if (themeMode === 'light') {
      return defaultLightTheme ?? defaultDarkTheme ?? null;
    }
    return defaultDarkTheme ?? defaultLightTheme ?? null;
  }, [themeMode, defaultDarkTheme, defaultLightTheme]);

  useEffect(() => {
    if (!selectedThemeEntry) return;

    const fallbackTheme =
      selectedThemeEntry.theme.mode === 'light'
        ? (defaultLightTheme ?? defaultDarkTheme)
        : (defaultDarkTheme ?? defaultLightTheme);
    if (!fallbackTheme) return;

    setThemeMode(selectedThemeEntry.theme.mode);
    setColors(createEditableColors(selectedThemeEntry.theme, fallbackTheme));
    setFonts(createEditableFonts(selectedThemeEntry.theme, fallbackTheme));
  }, [selectedThemeEntry, defaultDarkTheme, defaultLightTheme]);

  useEffect(() => {
    let cancelled = false;
    const queryLocalFonts = (globalThis as FontQueryGlobal).queryLocalFonts;
    if (typeof queryLocalFonts !== 'function') return undefined;

    void (async () => {
      try {
        const localFonts = await queryLocalFonts();
        if (cancelled || !Array.isArray(localFonts)) return;

        const localFamilies = localFonts
          .map((entry) => (entry && typeof entry.family === 'string' ? entry.family : ''))
          .filter((family) => !!family.trim());
        if (!localFamilies.length) return;

        setFontFamilyOptions(
          createFontFamilyOptions([...BUILT_IN_FONT_FAMILIES, ...localFamilies]),
        );
      } catch {
        // Ignore permission and unsupported errors, built-in options remain available.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const editableKeys = useMemo(
    () => Object.keys(fallbackThemeForMode?.colors ?? {}).sort(),
    [fallbackThemeForMode],
  );
  const editableFontKeys = useMemo(
    () => Object.keys(fallbackThemeForMode?.fonts ?? {}).sort(),
    [fallbackThemeForMode],
  );

  useEffect(() => {
    if (!livePreviewEnabled || !fallbackThemeForMode) return;

    const previewTheme = resolveThemeWithModeFallback({
      version: THEME_SCHEMA_VERSION,
      name: themeName.trim() || 'My Theme',
      author: themeAuthor.trim() || 'Me',
      mode: themeMode,
      colors,
      fonts,
    });
    applyTheme(previewTheme);
  }, [themeName, themeAuthor, themeMode, colors, fonts, livePreviewEnabled, fallbackThemeForMode]);

  useEffect(() => {
    if (livePreviewEnabled) return;

    const settingsThemeId = getBrowserSettings().themeId;
    applyTheme(getThemeById(settingsThemeId));
  }, [livePreviewEnabled]);

  const handleExport = () => {
    const trimmedName = themeName.trim() || 'My Theme';
    const trimmedAuthor = themeAuthor.trim() || 'Me';
    const payload: Theme = {
      version: THEME_SCHEMA_VERSION,
      name: trimmedName,
      author: trimmedAuthor,
      mode: themeMode,
      colors,
      fonts,
    };
    const filename = `${trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'theme'}.json`;
    downloadTextFile(filename, JSON.stringify(payload, null, 2));
    setExportMessage(`Exported ${filename}`);
  };

  const handleExportLoadAndSelect = () => {
    try {
      const trimmedName = themeName.trim() || 'My Theme';
      const trimmedAuthor = themeAuthor.trim() || 'Me';
      const payload: Theme = {
        version: THEME_SCHEMA_VERSION,
        name: trimmedName,
        author: trimmedAuthor,
        mode: themeMode,
        colors,
        fonts,
      };
      const json = JSON.stringify(payload, null, 2);
      const imported = importThemeFromJson(json);
      saveBrowserSettings({ themeId: imported.id });
      applyTheme(imported.theme);
      setThemes(getAllThemes());
      setBaseThemeId(imported.id);
      setExportMessage(`Loaded and selected: ${imported.theme.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load and select theme.';
      setExportMessage(message);
    }
  };

  if (!themes.length || !defaultDarkTheme) {
    return (
      <div className="settings-page creator-page">No themes are available to use as a base.</div>
    );
  }
  const fallbackColors = fallbackThemeForMode?.colors ?? defaultDarkTheme.colors;
  const fallbackFonts = fallbackThemeForMode?.fonts ?? defaultDarkTheme.fonts ?? {};

  return (
    <div className="settings-page creator-page" data-mira-prevent-suspension="true">
      <header className="settings-header">
        <div>
          <h1 className="settings-title">Theme Creator</h1>
        </div>
      </header>

      <section className="theme-panel settings-card">
        <div className="settings-card-header">
          <h2 className="settings-card-title">Actions</h2>
        </div>
        <div className="settings-actions-row">
          <button
            type="button"
            onClick={handleExport}
            className="theme-btn theme-btn-go settings-btn-pad"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={handleExportLoadAndSelect}
            className="theme-btn theme-btn-nav settings-btn-pad"
          >
            Export, Load, and Select
          </button>
          <label className="creator-live-preview">
            <input
              type="checkbox"
              checked={livePreviewEnabled}
              onChange={(e) => setLivePreviewEnabled(e.currentTarget.checked)}
              className="settings-toggle"
            />
            <span className="theme-text2">Live Preview</span>
          </label>
        </div>
        {!!exportMessage && (
          <div className="theme-text2 settings-inline-message">{exportMessage}</div>
        )}
      </section>

      <section className="theme-panel settings-card">
        <div className="settings-card-header">
          <h2 className="settings-card-title">Theme Details</h2>
        </div>
        <div className="creator-meta-grid theme-creator-meta-grid">
          <label className="creator-meta-field">
            <span className="settings-setting-label">Base Theme</span>
            <select
              value={baseThemeId}
              onChange={(e) => {
                setBaseThemeId(e.currentTarget.value);
                setExportMessage('');
              }}
              className="theme-input settings-select-input"
            >
              {themes.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.theme.name} - {entry.theme.author} ({entry.theme.mode})
                </option>
              ))}
            </select>
          </label>

          <label className="creator-meta-field">
            <span className="settings-setting-label">Name</span>
            <input
              value={themeName}
              onChange={(e) => {
                setThemeName(e.currentTarget.value);
                setExportMessage('');
              }}
              className="theme-input settings-text-input"
            />
          </label>

          <label className="creator-meta-field">
            <span className="settings-setting-label">Author</span>
            <input
              value={themeAuthor}
              onChange={(e) => {
                setThemeAuthor(e.currentTarget.value);
                setExportMessage('');
              }}
              className="theme-input settings-text-input"
            />
          </label>

          <label className="creator-meta-field">
            <span className="settings-setting-label">Mode</span>
            <select
              value={themeMode}
              onChange={(e) => {
                const nextMode = e.currentTarget.value;
                if (nextMode === 'light' || nextMode === 'dark') {
                  setThemeMode(nextMode);
                  setExportMessage('');
                }
              }}
              className="theme-input settings-select-input"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </div>
      </section>

      <section className="theme-panel settings-card">
        <div className="settings-card-header">
          <h2 className="settings-card-title">Fonts</h2>
        </div>
        <div className="creator-values-list theme-creator-values-list">
          {editableFontKeys.map((key) => {
            const options =
              key === 'fontPrimaryFamily' || key === 'fontSecondaryFamily' ? fontFamilyOptions : [];
            const currentRaw = (fonts[key] ?? '').trim();
            const hasCustomCurrent =
              !!currentRaw && !options.some((entry) => entry.value === currentRaw);
            const selectedValue = currentRaw || DEFAULT_FONT_SELECT_VALUE;
            const selectedPreviewFamily =
              options.length && (key === 'fontPrimaryFamily' || key === 'fontSecondaryFamily')
                ? getFontPreviewFamily(currentRaw || fallbackFonts[key] || '')
                : undefined;

            return (
              <div key={key} className="settings-setting-row creator-value-row">
                <div className="settings-setting-meta">
                  <span className="settings-setting-label">{getThemeFontDisplayName(key)}</span>
                </div>
                <div className="settings-setting-control settings-setting-control-grow settings-setting-control-right">
                  {options.length ? (
                    <select
                      value={selectedValue}
                      onChange={(e) => {
                        const nextValue = e.currentTarget.value;
                        setFonts((prev) => ({
                          ...prev,
                          [key]: nextValue === DEFAULT_FONT_SELECT_VALUE ? '' : nextValue,
                        }));
                        setExportMessage('');
                      }}
                      style={
                        selectedPreviewFamily ? { fontFamily: selectedPreviewFamily } : undefined
                      }
                      className="theme-input settings-select-input settings-setting-control-grow creator-code-input"
                    >
                      <option value={DEFAULT_FONT_SELECT_VALUE}>Default</option>
                      {options.map((option) => (
                        <option
                          key={`${key}-${option.value}`}
                          value={option.value}
                          style={{
                            fontFamily: getFontPreviewFamily(option.value),
                          }}
                        >
                          {option.label}
                        </option>
                      ))}
                      {hasCustomCurrent && (
                        <option
                          value={currentRaw}
                          style={{
                            fontFamily: getFontPreviewFamily(currentRaw),
                          }}
                        >
                          Custom ({currentRaw})
                        </option>
                      )}
                    </select>
                  ) : (
                    <input
                      value={fonts[key] ?? ''}
                      onChange={(e) => {
                        const raw = e.currentTarget.value;
                        setFonts((prev) => ({ ...prev, [key]: raw }));
                        setExportMessage('');
                      }}
                      className="theme-input settings-text-input settings-setting-control-grow creator-code-input"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="theme-panel settings-card">
        <div className="settings-card-header">
          <h2 className="settings-card-title">Colors</h2>
        </div>
        <div className="creator-values-list theme-creator-values-list">
          {editableKeys.map((key) =>
            (() => {
              const resolvedRgba = getResolvedRgbaForEditor(key, colors, fallbackColors);
              const opacityPercent = Math.round(resolvedRgba.a * 100);
              return (
                <div
                  key={key}
                  className="settings-setting-row creator-value-row theme-creator-value-row"
                >
                  <div className="settings-setting-meta">
                    <span className="settings-setting-label">{getThemeColorDisplayName(key)}</span>
                  </div>
                  <div className="creator-color-controls settings-setting-control settings-setting-control-grow settings-setting-control-right">
                    <input
                      value={colors[key] ?? ''}
                      onChange={(e) => {
                        const raw = e.currentTarget.value;
                        const trimmed = raw.trim();
                        if (!trimmed) {
                          setColors((prev) => ({ ...prev, [key]: '' }));
                          setExportMessage('');
                          return;
                        }
                        const normalized = normalizeHexColor(trimmed);
                        setColors((prev) => ({ ...prev, [key]: normalized ?? raw }));
                        setExportMessage('');
                      }}
                      placeholder="Leave blank to use mode default"
                      className="theme-input settings-text-input creator-code-input"
                    />
                    <input
                      type="color"
                      value={getColorPickerValue(key, colors, fallbackColors)}
                      onChange={(e) => {
                        const nextHex = e.currentTarget.value;
                        const parsedHex = parseColorToRgba(nextHex) ?? { r: 0, g: 0, b: 0, a: 1 };
                        setColors((prev) => ({
                          ...prev,
                          [key]: formatColorWithOpacity(
                            parsedHex.r,
                            parsedHex.g,
                            parsedHex.b,
                            opacityPercent,
                          ),
                        }));
                        setExportMessage('');
                      }}
                      className="creator-color-swatch"
                    />
                    <label className="theme-text2" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      Opacity
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={opacityPercent}
                      onChange={(event) => {
                        const nextOpacity = parseOpacityPercent(
                          event.currentTarget.value,
                          opacityPercent,
                        );
                        setColors((prev) => ({
                          ...prev,
                          [key]: formatColorWithOpacity(
                            resolvedRgba.r,
                            resolvedRgba.g,
                            resolvedRgba.b,
                            nextOpacity,
                          ),
                        }));
                        setExportMessage('');
                      }}
                      className="theme-input settings-text-input"
                      style={{ width: 72 }}
                      aria-label={`${getThemeColorDisplayName(key)} opacity`}
                    />
                  </div>
                </div>
              );
            })(),
          )}
        </div>
      </section>
    </div>
  );
}
