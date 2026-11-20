import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicSaveText } from '../electron/atomicFileSave.ts';

test('atomic saving replaces the file and cleans up staging files', async () => {
  const directory = await fs.mkdtemp(path.resolve('.tmp/atomic-save-'));
  const file = path.join(directory, 'example.txt');
  try {
    await fs.writeFile(file, 'original');
    await atomicSaveText(file, '\uFEFFnew\r\ncontents', 'original');
    assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFnew\r\ncontents');
    assert.deepEqual(await fs.readdir(directory), ['example.txt']);
    await assert.rejects(atomicSaveText(file, 'stale overwrite', 'original'), /changed on disk/);
    assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFnew\r\ncontents');
    assert.deepEqual(await fs.readdir(directory), ['example.txt']);
  } finally { await fs.rm(directory, { recursive: true }); }
});
