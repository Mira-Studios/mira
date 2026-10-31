type PopupRequest = { features?: string; disposition?: string };

function enabled(value: string): boolean {
  if (value === '' || value === 'yes' || value === 'true') return true;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number !== 0;
}

export function isExplicitPopupRequest({ features = '', disposition = '' }: PopupRequest): boolean {
  if (['foreground-tab', 'background-tab'].includes(disposition.trim().toLowerCase())) return false;
  const options = new Map(features.toLowerCase().split(',').filter((part) => part.trim()).map((part) => {
    const [name, value = ''] = part.trim().split('=');
    return [name.trim(), value.trim()];
  }));
  // An explicit popup=false takes precedence over size and toolbar hints.
  if (options.has('popup')) return enabled(options.get('popup')!);
  // Older sites request popup windows using size/position or hidden browser chrome.
  if (['width', 'height', 'left', 'top'].some((name) => options.has(name))) return true;
  return ['toolbar', 'menubar', 'location', 'status', 'resizable', 'scrollbars']
    .some((name) => options.has(name) && !enabled(options.get(name)!));
}
