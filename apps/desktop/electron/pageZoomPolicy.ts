export const PAGE_ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];
export type PageZoomAction = 'in' | 'out' | 'reset';

export function nextPageZoom(factor: number, action: PageZoomAction): number {
  if (action === 'reset') return 1;
  const current = Number.isFinite(factor) && factor > 0 ? factor : 1;
  if (action === 'in') return PAGE_ZOOM_FACTORS.find((step) => step > current + 0.001) ?? 5;
  return [...PAGE_ZOOM_FACTORS].reverse().find((step) => step < current - 0.001) ?? 0.25;
}
