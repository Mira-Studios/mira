export function normalizeBackgroundImageUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export function normalizeBackgroundImageSource(value: unknown): string {
  return typeof value === 'string' && /^local:[a-f0-9]{64}$/.test(value)
    ? value
    : normalizeBackgroundImageUrl(value);
}

export function getBackgroundImageError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return (
    message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') ||
    'Could not load the image. Try another file or URL.'
  );
}
