export type AddressBarPosition = 'toolbar' | 'topbar' | 'vertical-tabs';

export function normalizeAddressBarPosition(
  value: unknown,
  legacyTopbar: unknown,
): AddressBarPosition {
  if (value === 'toolbar' || value === 'topbar' || value === 'vertical-tabs') return value;
  return legacyTopbar === false ? 'toolbar' : 'topbar';
}

export function resolveAddressBarPosition(
  position: AddressBarPosition,
  verticalTabs: boolean,
): AddressBarPosition {
  if ((position === 'vertical-tabs' || position === 'topbar') && !verticalTabs) return 'toolbar';
  return position;
}
