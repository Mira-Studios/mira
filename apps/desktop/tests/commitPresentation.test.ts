import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterGitCommits, groupGitCommits } from '../src/features/git/commitPresentation.ts';

const now = new Date(2026, 10, 20, 12).getTime();
const commits = [
  { hash: 'a', subject: 'First', author: 'Avery', date: new Date(now).toISOString() },
  { hash: 'b', subject: 'Second', author: 'Jamie', date: new Date(now - 3600_000).toISOString() },
  {
    hash: 'c',
    subject: 'Third',
    author: 'Avery',
    date: new Date(now - 8 * 86_400_000).toISOString(),
  },
];

test('commits group by local calendar day, newest date first, preserving order within a day', () => {
  const groups = groupGitCommits([commits[2], commits[0], commits[1]]);
  assert.deepEqual(
    groups.map((group) => group.commits.map((commit) => commit.hash)),
    [['a', 'b'], ['c']],
  );
  assert.deepEqual(
    groups.map((group) => group.key),
    ['2026-11-20', '2026-11-12'],
  );
});

test('author and time filters combine and All time restores older commits', () => {
  assert.deepEqual(
    filterGitCommits(commits, 'Avery', 'week', now).map((commit) => commit.hash),
    ['a'],
  );
  assert.deepEqual(
    filterGitCommits(commits, 'Avery', 'all', now).map((commit) => commit.hash),
    ['a', 'c'],
  );
  assert.deepEqual(
    filterGitCommits(commits, '', 'day', now).map((commit) => commit.hash),
    ['a', 'b'],
  );
  assert.equal(filterGitCommits(commits, 'Unknown', 'all', now).length, 0);
  assert.equal(commits.length, 3);
});
