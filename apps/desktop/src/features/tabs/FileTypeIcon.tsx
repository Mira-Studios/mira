import { FileCode2, FileJson2, FileText, FileSpreadsheet, Terminal } from 'lucide-react';

/** Small extension-specific badges, independent of the editor bundle. */
export default function FileTypeIcon({ url, size }: { url: string; size: number }) {
  let extension = '';
  try { extension = decodeURIComponent(new URL(url).pathname).split('.').pop()!.toLowerCase(); } catch { /* Generic file. */ }
  const badge = ({ ts: ['TS', '#3178c6', 'TypeScript'], tsx: ['TSX', '#3178c6', 'TypeScript React'], js: ['JS', '#f0db4f', 'JavaScript'], jsx: ['JSX', '#61dafb', 'JavaScript React'], py: ['Py', '#3776ab', 'Python'], cs: ['C#', '#a475d7', 'C#'], rs: ['Rs', '#dea584', 'Rust'], go: ['Go', '#00add8', 'Go'] } as Record<string, string[]>)[extension];
  const style = { width: size, height: size, flexShrink: 0, pointerEvents: 'none' as const };
  if (badge) return <span role="img" aria-label={`${badge[2]} file`} style={{ ...style, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: badge[1], color: ['js', 'jsx', 'rs'].includes(extension) ? '#18212b' : '#fff', borderRadius: 1, fontSize: size * (badge[0].length > 2 ? 0.43 : 0.58), fontWeight: 700, fontFamily: 'sans-serif', lineHeight: 1 }}>{badge[0]}</span>;
  const Icon = ['json', 'jsonc'].includes(extension) ? FileJson2 : ['csv', 'tsv'].includes(extension) ? FileSpreadsheet : ['sh', 'bash', 'ps1'].includes(extension) ? Terminal : ['html', 'css', 'scss', 'xml', 'vue', 'svelte', 'c', 'cpp', 'h', 'java', 'php', 'rb'].includes(extension) ? FileCode2 : FileText;
  const color = ['json', 'jsonc'].includes(extension) ? '#e5c07b' : ['md', 'markdown'].includes(extension) ? '#6cb6ff' : ['css', 'scss'].includes(extension) ? '#c792ea' : '#a9b7c6';
  return <Icon role="img" aria-label={`${extension || 'Text'} file`} size={size} style={{ ...style, color }} strokeWidth={1.7} />;
}
