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
  // With legacy window features, omitted chrome defaults to hidden. In particular,
  // "resizable,scrollbars,status" requests a popup even though all three are enabled.
  // Privacy/referrer features alone do not request a different window layout.
  const layoutOptions = [...options.keys()].filter((name) =>
    !['noopener', 'noreferrer', 'attributionsrc'].includes(name));
  if (!layoutOptions.length) return false;
  const shown = (name: string, fallback = false) => options.has(name)
    ? enabled(options.get(name)!) : fallback;
  return (!shown('location') && !shown('toolbar'))
    || !shown('menubar') || !shown('resizable', true)
    || !shown('scrollbars') || !shown('status');
}
