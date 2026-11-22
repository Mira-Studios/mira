import { app } from 'electron';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpdateProgressWindow, downloadUpdate } from '../electron/updateInstaller.ts';

void app.whenReady().then(async () => {
const ui = createUpdateProgressWindow();
try {
  await ui.status('Downloading update… 42%', 42);
  assert.equal(await ui.win.webContents.executeJavaScript("document.querySelector('progress').value"), 42);
  assert.equal(await ui.win.webContents.executeJavaScript("document.getElementById('status').textContent"), 'Downloading update… 42%');
  assert.equal(ui.win.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(ui.win.webContents.getLastWebPreferences().nodeIntegration, false);
  ui.win.close();
  assert.equal(ui.win.isDestroyed(), false, 'An active installation keeps its progress window open');
  await ui.status('Installing update…');
  assert.equal(await ui.win.webContents.executeJavaScript("document.querySelector('progress').hasAttribute('value')"), false);
  await delay(300);
  const image = await ui.win.webContents.capturePage();
  assert.equal(image.isEmpty(), false);
  await fs.writeFile(path.join(os.tmpdir(), 'mira-update-progress.png'), image.toPNG());
  await ui.status('Administrator permission was cancelled.');
  await ui.done();
  assert.equal(await ui.win.webContents.executeJavaScript("document.getElementById('hint').textContent"), 'Close this window and try again.');

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mira-download-test-'));
  const originalFetch = globalThis.fetch;
  const url = 'https://github.com/FatalMistake02/mira/releases/download/v2/Mira.deb';
  try {
    let progress = 0;
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } });
    const downloaded = await downloadUpdate(url, 'Mira.deb', directory, received => { progress = received; });
    assert.deepEqual(await fs.readFile(downloaded), Buffer.from([1, 2, 3]));
    assert.equal(progress, 3);
    globalThis.fetch = async () => new Response(new Uint8Array([1]), { headers: { 'content-length': '3' } });
    await assert.rejects(downloadUpdate(url, 'Mira.deb', directory), /incomplete/);
    assert.deepEqual(await fs.readFile(downloaded), Buffer.from([1, 2, 3]), 'A partial download never replaces an existing complete file');
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.partial')), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log('PASS: updater window, sandbox, progress, error state, streaming download, and partial-file cleanup');
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}

});
