import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getGitHubRepository, getGitHubRemoteRepository } from '../electron/githubRepository.ts';
import {
  openGitFile,
  readGitDiff,
  readGitSnapshot,
  resolveGitRoot,
  resolveEditorGitRoot,
  readGitHubRemote,
} from '../electron/localGit.ts';

const tempRoot = path.resolve('.tmp');
async function fixture() {
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, 'local-git-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Mira Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  return { directory, git };
}
async function cleanup(directory: string) {
  assert.ok(path.resolve(directory).startsWith(tempRoot + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
}

test('GitHub repository identity is stable across subpages, queries, casing, and .git suffixes', () => {
  for (const url of [
    'https://github.com/Owner/Repo',
    'https://github.com/Owner/Repo/issues/12?q=test#comment',
    'https://github.com/Owner/Repo.git/',
  ]) {
    assert.deepEqual(getGitHubRepository(url), { key: 'owner/repo', name: 'Owner/Repo' });
  }
  for (const url of [
    'https://github.com',
    'https://github.com/owner',
    'https://github.com/settings/profile',
    'https://github.com/orgs/example',
    'https://github.com/topics/git',
    'https://github.com.evil.test/owner/repo',
    'https://github.com:8080/owner/repo',
    'https://user@github.com/owner/repo',
    'http://github.com/owner/repo',
    'mira://github.com/owner/repo',
  ]) {
    assert.equal(getGitHubRepository(url), null, url);
  }
});

test('editor Git discovery follows the containing repository and supports GitHub SSH remotes', async () => {
  const { directory, git } = await fixture();
  try {
    const file = path.join(directory, 'source files', 'hello world.ts');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, 'export const hello = true;');
    assert.equal(
      await resolveEditorGitRoot(pathToFileURL(file).href),
      await fs.realpath(directory),
    );
    assert.equal(await readGitHubRemote(directory), null);
    git('remote', 'add', 'origin', 'git@github.com:Owner/Repo.git');
    assert.deepEqual(await readGitHubRemote(directory), { key: 'owner/repo', name: 'Owner/Repo' });
    await assert.rejects(resolveEditorGitRoot('https://example.com/file.ts'), /local text file/);
    const bare = path.join(directory, 'bare');
    git('init', '--bare', bare);
    await fs.writeFile(path.join(bare, 'notes.txt'), 'Not a working tree');
    assert.equal(
      await resolveEditorGitRoot(pathToFileURL(path.join(bare, 'notes.txt')).href),
      null,
    );
  } finally {
    await cleanup(directory);
  }
});

test('GitHub remotes normalize HTTPS, scp-style SSH, and SSH URLs without guessing another host', () => {
  for (const url of [
    'https://github.com/Owner/Repo.git',
    'git@github.com:Owner/Repo.git',
    'ssh://git@github.com/Owner/Repo.git',
  ]) {
    assert.deepEqual(getGitHubRemoteRepository(url), { key: 'owner/repo', name: 'Owner/Repo' });
  }
  assert.equal(getGitHubRemoteRepository('git@gitlab.com:Owner/Repo.git'), null);
  assert.equal(getGitHubRemoteRepository('git@github.com.evil.test:Owner/Repo.git'), null);
});

test('reads empty repositories, staged and unstaged diffs, renames, tracking, and detached HEAD', async () => {
  const { directory, git } = await fixture();
  try {
    assert.equal(await resolveGitRoot(directory), await fs.realpath(directory));
    let snapshot = await readGitSnapshot(directory);
    assert.equal(snapshot.branch, 'main');
    assert.deepEqual(snapshot.commits, []);
    await fs.writeFile(path.join(directory, 'original file.txt'), 'first\n');
    git('add', '.');
    git('commit', '-m', 'First commit');
    git('remote', 'add', 'origin', directory);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('branch', '--set-upstream-to=origin/main');
    git('mv', 'original file.txt', 'renamed file.txt');
    await fs.writeFile(path.join(directory, 'renamed file.txt'), 'second\n');
    await fs.writeFile(path.join(directory, 'untracked ü.txt'), 'new file\n');
    snapshot = await readGitSnapshot(directory);
    assert.equal(snapshot.commits[0].subject, 'First commit');
    assert.equal(snapshot.commits[0].author, 'Mira Test');
    assert.equal(snapshot.upstream, 'origin/main');
    assert.equal(snapshot.ahead, 0);
    const renamed = snapshot.changes.find((change) => change.path === 'renamed file.txt');
    assert.deepEqual(renamed, {
      path: 'renamed file.txt',
      originalPath: 'original file.txt',
      index: 'R',
      worktree: 'M',
    });
    const diff = await readGitDiff(directory, 'renamed file.txt');
    assert.match(diff.staged, /rename from original file.txt/);
    assert.match(diff.unstaged, /\+second/);
    assert.equal((await readGitDiff(directory, 'untracked ü.txt')).unstaged, 'new file\n');
    assert.match(await openGitFile(directory, 'renamed file.txt'), /^file:/);
    await assert.rejects(openGitFile(directory, '../outside.txt'));
    await assert.rejects(readGitDiff(directory, '../outside.txt'), /no local changes/);
    git('add', '.');
    git('commit', '-m', 'Second commit');
    snapshot = await readGitSnapshot(directory);
    assert.equal(snapshot.ahead, 1);
    assert.equal(snapshot.behind, 0);
    assert.equal(snapshot.changes.length, 0);
    assert.deepEqual(
      snapshot.commits.map((commit) => commit.subject),
      ['Second commit', 'First commit'],
    );
    git('checkout', '--detach');
    assert.equal((await readGitSnapshot(directory)).branch, 'Detached HEAD');
  } finally {
    await cleanup(directory);
  }
});

test('supports worktree folders and bounds large and binary untracked previews', async () => {
  const { directory, git } = await fixture();
  const worktree = path.join(directory, 'worktree');
  try {
    await fs.writeFile(path.join(directory, 'tracked.txt'), 'tracked\n');
    git('add', '.');
    git('commit', '-m', 'Initial');
    git('worktree', 'add', '--detach', worktree);
    assert.equal(await resolveGitRoot(worktree), await fs.realpath(worktree));
    await fs.writeFile(path.join(worktree, 'large.txt'), 'x'.repeat(300_000));
    const large = await readGitDiff(worktree, 'large.txt');
    assert.equal(large.truncated, true);
    assert.equal(large.unstaged.length, 256_000);
    await fs.writeFile(path.join(worktree, 'binary.dat'), Buffer.from([1, 0, 2]));
    assert.equal((await readGitDiff(worktree, 'binary.dat')).unstaged, 'Binary file');
  } finally {
    await cleanup(directory);
  }
});

test('rejects files outside the linked root and reports unavailable folders', async () => {
  const { directory } = await fixture();
  const outside = path.join(tempRoot, `${path.basename(directory)}-outside.txt`);
  try {
    await fs.writeFile(outside, 'outside repository');
    await assert.rejects(
      openGitFile(directory, `../${path.basename(outside)}`),
      /outside the linked repository/,
    );
    await assert.rejects(resolveGitRoot(path.join(directory, 'missing')), /folder is unavailable/);
    await fs.mkdir(path.join(directory, 'subfolder'));
    assert.equal(
      await resolveGitRoot(path.join(directory, 'subfolder')),
      await fs.realpath(directory),
    );
  } finally {
    await fs.unlink(outside);
    await cleanup(directory);
  }
});
