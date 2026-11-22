import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUpdateFormat, selectUpdateAsset, validateUpdateDownload } from '../electron/updatePolicy.ts';
import { windowsUpdateScript } from '../electron/windowsUpdateScript.ts';

const assets = ['Mira-2.0.0-linux-arm64.deb', 'Mira-2.0.0-linux-x64.AppImage',
  'Mira-2.0.0-linux-x64.deb', 'Mira-2.0.0-linux-x64.rpm',
  'Mira-2.0.0-win-x64.exe', 'Mira-2.0.0-win-x64-setup.exe',
  'Mira-2.0.0-mac-arm64.dmg', 'Mira-2.0.0-mac-x64.zip', 'Mira-2.0.0-mac-arm64.zip'].map(name => ({ name }));

test('updates preserve Linux package format and architecture', () => {
  for (const [format, extension] of [['deb', '.deb'], ['rpm', '.rpm'], ['appimage', '.AppImage']] as const) {
    assert.equal(selectUpdateAsset(assets, 'linux', 'x64', format)?.name, `Mira-2.0.0-linux-x64${extension}`);
  }
  assert.equal(selectUpdateAsset(assets, 'linux', 'arm64', 'rpm'), null);
  assert.equal(selectUpdateAsset(assets, 'linux', 'x64', null), null);
});

test('Windows selects the architecture-tagged setup, never portable', () => {
  assert.equal(selectUpdateAsset(assets, 'win32', 'x64', 'nsis')?.name, 'Mira-2.0.0-win-x64-setup.exe');
  assert.equal(selectUpdateAsset(assets, 'win32', 'arm64', 'nsis'), null);
});

test('macOS selects an extractable ZIP for the exact architecture', () => {
  assert.equal(selectUpdateAsset(assets, 'darwin', 'arm64', 'mac-zip')?.name, 'Mira-2.0.0-mac-arm64.zip');
  assert.equal(selectUpdateAsset(assets.filter(a => a.name.endsWith('.dmg')), 'darwin', 'arm64', 'mac-zip'), null);
});

test('download validation confines files to Mira releases and safe filenames', () => {
  const url = 'https://github.com/FatalMistake02/mira/releases/download/v2.0.0/Mira.deb';
  assert.doesNotThrow(() => validateUpdateDownload(url, 'Mira.deb'));
  for (const name of ['../Mira.deb', '/tmp/Mira.deb', 'Mira\\evil.deb', 'other.deb'])
    assert.throws(() => validateUpdateDownload(url, name));
  assert.throws(() => validateUpdateDownload(url.replace('github.com', 'example.com'), 'Mira.deb'));
});

test('Windows helper waits for Mira, checks installer exit, and reopens the original profile', () => {
  const script = windowsUpdateScript("C:\\Users\\O'Brien\\Mira.exe", 'C:\\Mira\\Mira.exe', '--mira-profile=abc', 123);
  assert.match(script, /Get-Process -Id 123/);
  assert.match(script, /ExitCode -ne 0/);
  assert.match(script, /O''Brien/);
  assert.match(script, /--mira-profile=abc/);
  assert.ok(script.indexOf('ExitCode -ne 0') < script.indexOf("Start-Process -FilePath 'C:\\Mira"));
});

test('Linux detection follows executable ownership even when both package managers exist', () => {
  const probe = (command: string, args: string[]) => {
    assert.equal(args.at(-1), '/opt/Mira/mira');
    return command === 'rpm';
  };
  assert.equal(detectUpdateFormat('linux', '/opt/Mira/mira', undefined, probe), 'rpm');
  assert.equal(detectUpdateFormat('linux', '/opt/Mira/mira', undefined, () => true), 'deb');
  assert.equal(detectUpdateFormat('linux', '/opt/Mira/mira', undefined, () => false), null);
  assert.equal(detectUpdateFormat('linux', '/tmp/.mount/mira', '/home/me/Mira.AppImage', () => {
    throw new Error('AppImages must not probe package managers');
  }), 'appimage');
});
