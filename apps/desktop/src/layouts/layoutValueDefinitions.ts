export type LayoutValueKind = 'length' | 'choice';

export type LayoutValueDefinition = {
  key: string;
  label: string;
  kind: LayoutValueKind;
  defaultValue: string;
  options?: string[];
};

export const LAYOUT_VALUE_DEFINITIONS: LayoutValueDefinition[] = [
  {
    key: 'layoutControlRadius',
    label: 'Control Radius',
    kind: 'length',
    defaultValue: '6px',
  },
  {
    key: 'layoutInputRadius',
    label: 'Input Radius',
    kind: 'length',
    defaultValue: '6px',
  },
  {
    key: 'layoutPanelRadius',
    label: 'Panel Radius',
    kind: 'length',
    defaultValue: '8px',
  },
  {
    key: 'layoutSettingsTabsRadius',
    label: 'Settings Tabs Radius',
    kind: 'length',
    defaultValue: '12px',
  },
  {
    key: 'layoutSettingsCardPadding',
    label: 'Settings Card Padding',
    kind: 'length',
    defaultValue: '14px',
  },
  {
    key: 'layoutSettingsCardRadius',
    label: 'Settings Card Radius',
    kind: 'length',
    defaultValue: '8px',
  },
  {
    key: 'layoutSettingsRowRadius',
    label: 'Settings Row Radius',
    kind: 'length',
    defaultValue: '8px',
  },
  {
    key: 'layoutSettingsRowPaddingY',
    label: 'Settings Row Padding Y',
    kind: 'length',
    defaultValue: '8px',
  },
  {
    key: 'layoutSettingsRowPaddingX',
    label: 'Settings Row Padding X',
    kind: 'length',
    defaultValue: '10px',
  },
  {
    key: 'layoutSettingsControlHeight',
    label: 'Settings Control Height',
    kind: 'length',
    defaultValue: '36px',
  },
  {
    key: 'layoutSettingsControlPaddingY',
    label: 'Settings Control Padding Y',
    kind: 'length',
    defaultValue: '8px',
  },
  {
    key: 'layoutSettingsControlPaddingX',
    label: 'Settings Control Padding X',
    kind: 'length',
    defaultValue: '10px',
  },
  {
    key: 'layoutSettingsButtonPaddingY',
    label: 'Settings Button Padding Y',
    kind: 'length',
    defaultValue: '8px',
  },
  {
    key: 'layoutSettingsButtonPaddingX',
    label: 'Settings Button Padding X',
    kind: 'length',
    defaultValue: '12px',
  },
  {
    key: 'layoutSettingsDropdownRadius',
    label: 'Settings Dropdown Radius',
    kind: 'length',
    defaultValue: '8px',
  },
  {
    key: 'layoutSettingsDropdownMaxHeight',
    label: 'Settings Dropdown Max Height',
    kind: 'length',
    defaultValue: '260px',
  },
  {
    key: 'layoutTabRadius',
    label: 'Tab Radius',
    kind: 'length',
    defaultValue: '10px',
  },
  {
    key: 'layoutTabHeight',
    label: 'Tab Height',
    kind: 'length',
    defaultValue: '31px',
  },
  {
    key: 'layoutTabGap',
    label: 'Tab Gap',
    kind: 'length',
    defaultValue: '6px',
  },
  {
    key: 'layoutTabMinWidth',
    label: 'Tab Minimum Width',
    kind: 'length',
    defaultValue: '100px',
  },
  {
    key: 'layoutTabTargetWidth',
    label: 'Tab Target Width',
    kind: 'length',
    defaultValue: '220px',
  },
  {
    key: 'layoutBorderWidth',
    label: 'Border Thickness',
    kind: 'length',
    defaultValue: '1px',
  },
  {
    key: 'layoutTopBarHeight',
    label: 'Top Bar Height',
    kind: 'length',
    defaultValue: '38px',
  },
  {
    key: 'layoutAddressBarPaddingY',
    label: 'Address Bar Vertical Padding',
    kind: 'length',
    defaultValue: '6px',
  },
  {
    key: 'layoutNavButtonHeight',
    label: 'Navigation Button Height',
    kind: 'length',
    defaultValue: '30px',
  },
  {
    key: 'layoutDownloadButtonSize',
    label: 'Download Button Size',
    kind: 'length',
    defaultValue: '34px',
  },
  {
    key: 'layoutAddressMenuPanelRadius',
    label: 'Address Menu Panel Radius',
    kind: 'length',
    defaultValue: '12px',
  },
  {
    key: 'layoutAddressMenuItemHeight',
    label: 'Address Menu Item Height',
    kind: 'length',
    defaultValue: '34px',
  },
  {
    key: 'layoutAddressMenuItemRadius',
    label: 'Address Menu Item Radius',
    kind: 'length',
    defaultValue: '8px',
  },
  {
    key: 'layoutDownloadIndicatorVisibility',
    label: 'Download Indicator Visibility',
    kind: 'choice',
    defaultValue: 'always',
    options: ['always', 'sometimes', 'never'],
  },
];

const displayNameByKey = new Map(LAYOUT_VALUE_DEFINITIONS.map((entry) => [entry.key, entry.label]));

/**
 * Returns a human-readable label for a layout value key.
 */
export function getLayoutValueDisplayName(key: string): string {
  return displayNameByKey.get(key) ?? key;
}

/**
 * Builds the default layout variable map from definition metadata.
 */
export function getDefaultLayoutValues(): Record<string, string> {
  return Object.fromEntries(
    LAYOUT_VALUE_DEFINITIONS.map((entry) => [entry.key, entry.defaultValue]),
  );
}
