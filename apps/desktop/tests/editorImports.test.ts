import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEditorImports } from '../electron/editorImports.ts';

test('loads relative imports, JS-to-TS paths, package declarations and unsaved dependency drafts without cycles', async () => {
  const directory = await fs.mkdtemp(path.resolve('.tmp/editor-imports-'));
  try {
    const entry = path.join(directory, 'main.ts');
    const text = `import { answer } from './dependency.js'; import type { Value } from 'example'; import('./folder');`;
    await fs.writeFile(entry, text);
    await fs.writeFile(path.join(directory, 'dependency.ts'), `export const answer = 42; import './main';`);
    await fs.mkdir(path.join(directory, 'folder'));
    await fs.writeFile(path.join(directory, 'folder/index.ts'), 'export const nested = true;');
    const packageDirectory = path.join(directory, 'node_modules/example');
    await fs.mkdir(packageDirectory, { recursive: true });
    await fs.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ types: 'types.d.ts' }));
    await fs.writeFile(path.join(packageDirectory, 'types.d.ts'), 'export type Value = number;');
    const dependencyUrl = pathToFileURL(path.join(directory, 'dependency.ts')).href;
    const imports = await readEditorImports(pathToFileURL(entry).href, text, [{ url: dependencyUrl, text: 'export const answer = "unsaved";' }]);
    assert.equal(imports.length, 3);
    assert.equal(imports.find(file => file.url === dependencyUrl)?.text, 'export const answer = "unsaved";');
    assert.ok(imports.some(file => file.url.endsWith('/folder/index.ts')));
    assert.ok(imports.some(file => file.url.endsWith('/types.d.ts')));
    assert.deepEqual(await readEditorImports(pathToFileURL(path.join(directory, 'notes.txt')).href, text), []);
  } finally { await fs.rm(directory, { recursive: true }); }
});
