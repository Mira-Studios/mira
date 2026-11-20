import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type EditorImport = { url: string; text: string };
const extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

async function resolveFile(base: string): Promise<string | undefined> {
  const candidates = [...extensions.map(ext => base + ext), base];
  if (/\.[cm]?js$/i.test(base)) candidates.unshift(...['.ts', '.tsx', '.d.ts'].map(ext => base.replace(/\.[cm]?js$/i, ext)));
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(base, 'package.json'), 'utf8'));
    const entry = manifest.types ?? manifest.typings ?? manifest.main;
    if (typeof entry === 'string') candidates.unshift(path.resolve(base, entry));
  } catch { /* Not a package directory. */ }
  candidates.push(...extensions.map(ext => path.join(base, 'index' + ext)));
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Next resolution candidate. */ }
  }
}
async function resolveImport(specifier: string, directory: string): Promise<string | undefined> {
  if (specifier.startsWith('.')) return resolveFile(path.resolve(directory, specifier));
  if (!/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w./-]+)*$/.test(specifier)) return;
  let current = directory;
  while (true) {
    const direct = await resolveFile(path.join(current, 'node_modules', specifier));
    if (direct) return direct;
    const types = specifier.startsWith('@') ? specifier.slice(1).replace('/', '__') : specifier;
    const declarations = await resolveFile(path.join(current, 'node_modules', '@types', types));
    if (declarations) return declarations;
    const next = path.dirname(current);
    if (next === current) return;
    current = next;
  }
}

/** Load a bounded graph for IntelliSense; never execute imports or fetch dependencies. */
export async function readEditorImports(url: string, text: string, drafts: EditorImport[] = []): Promise<EditorImport[]> {
  if (!/\.[cm]?[jt]sx?$/i.test(fileURLToPath(url))) return [];
  const pending = [{ url, text }];
  const visited = new Set([url]);
  const results: EditorImport[] = [];
  let bytes = 0;
  for (let index = 0; index < pending.length && visited.size <= MAX_FILES; index++) {
    const source = pending[index];
    // Imports, re-exports, require(), dynamic imports, and triple-slash declaration references.
    const pattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\b(?:require|import)\s*\(\s*|\/\/\/\s*<reference\s+path\s*=\s*)['"]([^'"\r\n]+)['"]/g;
    for (const match of source.text.matchAll(pattern)) {
      if (visited.size >= MAX_FILES) break;
      const filename = await resolveImport(match[1], path.dirname(fileURLToPath(source.url)));
      if (!filename) continue;
      const importUrl = pathToFileURL(filename).href;
      if (visited.has(importUrl)) continue;
      visited.add(importUrl);
      try {
        const stat = await fs.stat(filename);
        if (stat.size > 512 * 1024 || bytes + stat.size > MAX_TOTAL_BYTES) continue;
        const buffer = await fs.readFile(filename);
        if (buffer.includes(0) || buffer.length > 512 * 1024 || bytes + buffer.length > MAX_TOTAL_BYTES) continue;
        const contents = drafts.find(draft => draft.url === importUrl)?.text ?? new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        bytes += buffer.length;
        const imported = { url: importUrl, text: contents };
        results.push(imported); pending.push(imported);
      } catch { /* Missing or non-text dependencies remain normal editor diagnostics. */ }
    }
  }
  return results;
}
