/**
 * Flat CSS variable map keyed by semantic color token.
 */
export type ThemeColors = Record<string, string>;
/**
 * Flat CSS variable map keyed by semantic font token.
 */
export type ThemeFonts = Record<string, string>;
export type ThemeMode = 'light' | 'dark';
/**
 * Current serialized theme schema version.
 */
export const THEME_SCHEMA_VERSION = 'v1' as const;
export type ThemeSchemaVersion = typeof THEME_SCHEMA_VERSION;

/**
 * Canonical theme representation used by the renderer.
 */
export interface Theme {
  version: ThemeSchemaVersion;
  name: string;
  author: string;
  mode: ThemeMode;
  colors: ThemeColors;
  fonts?: ThemeFonts;
  /** Optional New Tab wallpaper, downloaded and cached when the user enables it. */
  backgroundImageUrl?: string;
}
