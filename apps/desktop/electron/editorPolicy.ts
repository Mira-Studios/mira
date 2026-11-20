/** File types edited as text. Browser documents and media keep their existing viewers. */
export const EDITOR_EXTENSIONS = ['txt', 'text', 'md', 'markdown', 'json', 'jsonc', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'less', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'log', 'csv', 'tsv', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'ps1', 'sql', 'rb', 'php', 'vue', 'svelte'];
export const MAX_EDITOR_BYTES = 16 * 1024 * 1024;
export function isEditorUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return false;
    const name = decodeURIComponent(url.pathname).split('/').pop()!.toLowerCase();
    return EDITOR_EXTENSIONS.includes(name.split('.').pop()!) || ['dockerfile', 'makefile', '.gitignore', '.env', '.editorconfig'].includes(name) || name.startsWith('.env.');
  } catch { return false; }
}
