import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getGitDiffLines } from '../src/features/git/gitDiff.ts';

test('diff gutters follow additions, removals, context, and independent hunks', () => {
  const lines = getGitDiffLines(
    'diff --git a/a.txt b/a.txt\nindex abc..def 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -3,2 +3,3 @@\n same\n-old\n+new\n+extra\n@@ -20 +21 @@\n-before\n+after\n\\ No newline at end of file\n',
    true,
  );
  assert.deepEqual(
    lines
      .filter((line) => line.kind !== 'hunk' && line.kind !== 'info')
      .map((line) => [line.kind, line.oldLine, line.newLine, line.text]),
    [
      ['context', 3, 3, 'same'],
      ['removed', 4, null, 'old'],
      ['added', null, 4, 'new'],
      ['added', null, 5, 'extra'],
      ['removed', 20, null, 'before'],
      ['added', null, 21, 'after'],
    ],
  );
  assert.equal(lines.at(-1)?.kind, 'info');
});

test('untracked content keeps literal diff markers and source line numbers', () => {
  assert.deepEqual(
    getGitDiffLines('+++ literal\n@@ literal\n\n', false).map((line) => [
      line.kind,
      line.newLine,
      line.text,
    ]),
    [
      ['context', 1, '+++ literal'],
      ['context', 2, '@@ literal'],
      ['context', 3, ''],
    ],
  );
  assert.equal(
    getGitDiffLines('@@ -1 +1 @@\n--- literal source\n+++ literal source\n', true)[1].kind,
    'removed',
  );
});
