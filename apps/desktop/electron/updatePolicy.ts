export type InstallFormat = 'nsis' | 'mac-zip' | 'appimage' | 'deb' | 'rpm';
export type ReleaseAsset = { name?: string; browser_download_url?: string };

export function selectUpdateAsset<T extends ReleaseAsset>(
  assets: T[], platform: string, arch: string, format: InstallFormat | null,
): T | null {
  const aliases = arch === 'x64' ? ['x64', 'amd64', 'x86_64']
    : arch === 'arm64' ? ['arm64', 'aarch64'] : [arch];
  const extension = { nsis: '.exe', 'mac-zip': '.zip', appimage: '.appimage', deb: '.deb', rpm: '.rpm' }[format ?? 'deb'];
  if (!format) return null;
  return assets.find(asset => {
    const name = asset.name?.toLowerCase() ?? '';
    if (!name.endsWith(extension)) return false;
    const tokens = name.slice(0, -extension.length).split(/[-.]/);
    if (!aliases.some(alias => tokens.includes(alias))) return false;
    if (platform === 'win32') return tokens.includes('win') && tokens.includes('setup');
    if (platform === 'darwin') return tokens.includes('mac');
    return platform === 'linux';
  }) ?? null;
}

export function validateUpdateDownload(downloadUrl: string, assetName: string): void {
  const url = new URL(downloadUrl);
  if (url.origin !== 'https://github.com'
    || !url.pathname.startsWith('/FatalMistake02/mira/releases/download/')
    || !assetName || assetName === '.' || assetName === '..' || /[/\\]/.test(assetName)
    || [...assetName].some(character => character.charCodeAt(0) < 32)
    || decodeURIComponent(url.pathname.split('/').at(-1) ?? '') !== assetName) {
    throw new Error('Invalid Mira update asset.');
  }
}

export function detectUpdateFormat(
  platform: string, executable: string, appImage: string | undefined,
  ownsExecutable: (command: string, args: string[]) => boolean,
): InstallFormat | null {
  if (platform === 'win32') return 'nsis';
  if (platform === 'darwin') return 'mac-zip';
  if (platform !== 'linux') return null;
  if (appImage) return 'appimage';
  if (ownsExecutable('dpkg-query', ['-S', executable])) return 'deb';
  if (ownsExecutable('rpm', ['-qf', executable])) return 'rpm';
  return null;
}
