export type PipMode = 'window' | 'desktop';
export type PipRect = { x: number; y: number; width: number; height: number };
export type PipSettings = { onTabSwitch: boolean; onWindowHidden: boolean; themeId?: string };
export type PipVideo = {
  id: string;
  playing: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  width: number;
  height: number;
  area: number;
};
export function pipMode(
  settings: PipSettings,
  hidden: boolean,
  sourceIsActive: boolean,
): PipMode | null {
  if (hidden) return settings.onWindowHidden ? 'desktop' : null;
  return !sourceIsActive && settings.onTabSwitch ? 'window' : null;
}
export function clampPip(
  rect: Partial<PipRect> | undefined,
  area: PipRect,
  ratio = 16 / 9,
): PipRect {
  const finite = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const width = Math.round(
    Math.min(area.width, Math.max(Math.min(240, area.width), finite(rect?.width, 360))),
  );
  const height = Math.round(
    Math.min(
      area.height,
      Math.max(Math.min(135, area.height), finite(rect?.height, width / ratio)),
    ),
  );
  return {
    width,
    height,
    x: Math.round(
      Math.min(
        area.x + area.width - width,
        Math.max(area.x, finite(rect?.x, area.x + area.width - width - 20)),
      ),
    ),
    y: Math.round(
      Math.min(
        area.y + area.height - height,
        Math.max(area.y, finite(rect?.y, area.y + area.height - height - 20)),
      ),
    ),
  };
}
export function normalizePipVideos(value: unknown): PipVideo[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const v = candidate as Record<string, unknown>;
    if (
      typeof v.id !== 'string' ||
      v.id.length > 80 ||
      !Number.isFinite(v.width) ||
      !Number.isFinite(v.height) ||
      Number(v.width) <= 0 ||
      Number(v.height) <= 0
    )
      return [];
    const number = (key: string, fallback = 0) =>
      typeof v[key] === 'number' && Number.isFinite(v[key]) ? (v[key] as number) : fallback;
    return [
      {
        id: v.id,
        playing: v.playing === true,
        ended: v.ended === true,
        muted: v.muted === true,
        volume: Math.min(1, Math.max(0, number('volume', 1))),
        currentTime: Math.max(0, number('currentTime')),
        duration: Math.max(0, number('duration')),
        width: Math.min(16384, number('width')),
        height: Math.min(16384, number('height')),
        area: Math.min(100_000_000, Math.max(0, number('area'))),
      },
    ];
  });
}
