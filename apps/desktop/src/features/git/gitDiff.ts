export type GitDiffLine = {
  kind: 'context' | 'added' | 'removed' | 'hunk' | 'info';
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

/** Hunk headers reset both gutters; file headers never become source lines. */
export function getGitDiffLines(text: string, patch: boolean): GitDiffLine[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldLine: number | null = null;
  let newLine: number | null = null;
  const result: GitDiffLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (!patch) {
      result.push({ kind: 'context', text: line, oldLine: null, newLine: index + 1 });
      continue;
    }
    if (line.startsWith('diff --git ')) {
      oldLine = null;
      newLine = null;
      continue;
    }
    if (oldLine === null && /^(index |--- |\+\+\+ )/.test(line)) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      result.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
    } else if (oldLine !== null && newLine !== null && /^[ +-]/.test(line)) {
      const kind = line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context';
      result.push({
        kind,
        text: line.slice(1),
        oldLine: kind === 'added' ? null : oldLine++,
        newLine: kind === 'removed' ? null : newLine++,
      });
    } else result.push({ kind: 'info', text: line, oldLine: null, newLine: null });
  }
  return result;
}
