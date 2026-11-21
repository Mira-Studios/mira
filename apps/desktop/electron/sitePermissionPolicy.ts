export type KnownSitePermissionId =
  | 'camera'
  | 'microphone'
  | 'location'
  | 'notifications'
  | 'fullscreen'
  | 'clipboard'
  | 'pointer-lock'
  | 'screen-capture'
  | 'midi'
  | 'sensors'
  | 'storage-access'
  | 'window-management'
  | 'idle-detection'
  | 'speaker-selection'
  | 'keyboard-lock'
  | 'external-apps'
  | 'file-system'
  | 'persistent-storage'
  | 'clipboard-write'
  | 'protected-media'
  | 'unknown';
export type SitePermissionId = KnownSitePermissionId | `other:${string}`;

export const SITE_SETTINGS_PERMISSION_ORDER: KnownSitePermissionId[] = [
  'camera',
  'microphone',
  'location',
  'notifications',
  'clipboard',
  'clipboard-write',
  'pointer-lock',
  'screen-capture',
  'midi',
  'sensors',
  'storage-access',
  'persistent-storage',
  'protected-media',
  'window-management',
  'idle-detection',
  'speaker-selection',
  'keyboard-lock',
  'external-apps',
  'file-system',
  'unknown',
];

const SITE_PERMISSION_LABELS: Record<KnownSitePermissionId, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  location: 'Location',
  notifications: 'Notifications',
  fullscreen: 'Fullscreen',
  clipboard: 'Read clipboard',
  'clipboard-write': 'Copy to clipboard',
  'persistent-storage': 'Persistent storage',
  'protected-media': 'Protected media',
  'pointer-lock': 'Pointer lock',
  'screen-capture': 'Screen capture',
  midi: 'MIDI devices',
  sensors: 'Motion and orientation',
  'storage-access': 'Cross-site cookies and site data',
  'window-management': 'Window management',
  'idle-detection': 'Idle detection',
  'speaker-selection': 'Speaker selection',
  'keyboard-lock': 'Keyboard lock',
  'external-apps': 'External apps',
  'file-system': 'File system',
  unknown: 'Other permission (legacy)',
};

export function isSitePermissionId(value: unknown): value is SitePermissionId {
  return (
    typeof value === 'string' &&
    (SITE_SETTINGS_PERMISSION_ORDER.includes(value as KnownSitePermissionId) ||
      /^other:[a-z][a-z0-9-]{0,79}$/i.test(value))
  );
}
export function sitePermissionLabel(id: SitePermissionId): string {
  return id.startsWith('other:')
    ? `Browser permission: ${id.slice(6)}`
    : SITE_PERMISSION_LABELS[id as KnownSitePermissionId];
}

// These APIs do not need a permission prompt. Explicit per-site settings win.
export function automaticSitePermissionDecision(
  permission: string,
  requester: string,
  topLevel: string,
  isPrivate = false,
): boolean | undefined {
  if (permission === 'clipboard-sanitized-write') return true;
  if (permission !== 'persistent-storage') return undefined;
  if (isPrivate) return false;
  try {
    const source = new URL(requester);
    const top = new URL(topLevel);
    return ['https:', 'http:'].includes(source.protocol) && source.origin === top.origin;
  } catch {
    return false;
  }
}

export function mapPermissionIdsFromDetails(
  permission: string,
  details: {
    mediaType?: 'video' | 'audio' | 'unknown';
    mediaTypes?: Array<'video' | 'audio'>;
  },
): SitePermissionId[] {
  if (permission === 'media') {
    const requestedMediaTypes =
      Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0
        ? details.mediaTypes
        : details.mediaType && details.mediaType !== 'unknown'
          ? [details.mediaType]
          : [];

    const permissionIds = new Set<SitePermissionId>();
    for (const mediaType of requestedMediaTypes) {
      if (mediaType === 'video') permissionIds.add('camera');
      if (mediaType === 'audio') permissionIds.add('microphone');
    }
    if (permissionIds.size === 0) {
      permissionIds.add('camera');
      permissionIds.add('microphone');
    }
    return Array.from(permissionIds);
  }

  switch (permission) {
    case 'geolocation':
      return ['location'];
    case 'notifications':
      return ['notifications'];
    case 'fullscreen':
      return ['fullscreen'];
    case 'clipboard-read':
      return ['clipboard'];
    case 'clipboard-sanitized-write':
      return ['clipboard-write'];
    case 'persistent-storage':
      return ['persistent-storage'];
    case 'mediaKeySystem':
      return ['protected-media'];
    case 'pointerLock':
      return ['pointer-lock'];
    case 'display-capture':
      return ['screen-capture'];
    case 'midi':
    case 'midiSysex':
      return ['midi'];
    case 'sensors':
    case 'accelerometer':
    case 'gyroscope':
    case 'magnetometer':
      return ['sensors'];
    case 'storage-access':
    case 'top-level-storage-access':
      return ['storage-access'];
    case 'window-management':
      return ['window-management'];
    case 'idle-detection':
      return ['idle-detection'];
    case 'speaker-selection':
      return ['speaker-selection'];
    case 'keyboardLock':
      return ['keyboard-lock'];
    case 'openExternal':
      return ['external-apps'];
    case 'fileSystem':
      return ['file-system'];
    default:
      return [`other:${/^[a-z][a-z0-9-]{0,79}$/i.test(permission) ? permission : 'unknown'}`];
  }
}

export function describeSitePermissionRequest(permissionIds: SitePermissionId[]): string {
  const filtered = permissionIds.filter((permissionId) => permissionId !== 'unknown');
  if (filtered.length === 2 && filtered.includes('camera') && filtered.includes('microphone')) {
    return 'Use your camera and microphone';
  }

  const firstPermissionId = permissionIds.find((id) => id !== 'unknown') ?? 'unknown';
  switch (firstPermissionId) {
    case 'camera':
      return 'Use your camera';
    case 'microphone':
      return 'Use your microphone';
    case 'location':
      return 'Know your location';
    case 'notifications':
      return 'Show notifications';
    case 'fullscreen':
      return 'Enter fullscreen';
    case 'clipboard':
      return 'Read your clipboard';
    case 'clipboard-write':
      return 'Copy to your clipboard';
    case 'persistent-storage':
      return 'Keep site data in persistent storage';
    case 'protected-media':
      return 'Play protected media';
    case 'pointer-lock':
      return 'Lock your pointer';
    case 'screen-capture':
      return 'Capture your screen';
    case 'midi':
      return 'Use MIDI devices';
    case 'sensors':
      return 'Use motion and orientation sensors';
    case 'storage-access':
      return 'Use cross-site cookies and site data';
    case 'window-management':
      return 'Manage your windows';
    case 'idle-detection':
      return 'Detect when you are idle';
    case 'speaker-selection':
      return 'Choose your speaker';
    case 'keyboard-lock':
      return 'Capture keyboard shortcuts';
    case 'external-apps':
      return 'Open external apps';
    case 'file-system':
      return 'Access files on this device';
    case 'unknown':
    default:
      return firstPermissionId.startsWith('other:')
        ? `Use the ?${firstPermissionId.slice(6)}? permission`
        : 'Use an unrecognized browser permission';
  }
}
