// Deliberately excludes bookmarks, tabs, history, downloads, permissions, and
// all Chromium site storage. New settings families must opt in explicitly.
export const SYNCED_SETTINGS_KEYS = [
  'mira.settings.browser.v1',
  'mira.themes.custom.v1',
  'mira.layouts.custom.v1',
] as const;
export type SettingsBundle = Record<(typeof SYNCED_SETTINGS_KEYS)[number], string | null>;

export function normalizeSettingsBundle(value: unknown): SettingsBundle {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings.');
  const candidate = value as Record<string, unknown>;
  const entries = SYNCED_SETTINGS_KEYS.map((key) => {
    const raw = candidate[key];
    if (raw !== null && (typeof raw !== 'string' || raw.length > 2_000_000))
      throw new Error('Invalid settings.');
    if (typeof raw === 'string') JSON.parse(raw);
    return [key, raw];
  });
  return Object.fromEntries(entries) as SettingsBundle;
}
