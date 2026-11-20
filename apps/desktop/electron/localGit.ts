import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getGitHubRemoteRepository,
  type GitChange,
  type GitFileDiff,
  type GitSnapshot,
} from './githubRepository.ts';
import { isEditorUrl } from './editorPolicy.ts';

function git(directory: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'color.ui=false',
        '-c',
        'core.quotePath=false',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        cwd: directory,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if ('code' in error && error.code === 'ENOENT')
          return reject(new Error('Git was not found. Install Git and restart Mira.'));
        reject(
          new Error(
            stderr.trim() ||
              'Git could not read this repository. Check that the folder is available.',
          ),
        );
      },
    );
  });
}

export async function resolveGitRoot(directory: string): Promise<string> {
  const realDirectory = await fs.realpath(directory).catch(() => {
    throw new Error('The repository folder is unavailable. Choose its folder again.');
  });
  const root = (await git(realDirectory, ['rev-parse', '--show-toplevel'])).trim();
  if (!root) throw new Error('Choose a folder inside a local Git repository.');
  return fs.realpath(root);
}

export async function resolveEditorGitRoot(url: string): Promise<string | null> {
  if (!isEditorUrl(url)) throw new Error('Open a local text file to use Git in the editor.');
  const file = await fs.realpath(fileURLToPath(url));
  if (!(await fs.stat(file)).isFile()) return null;
  try {
    return await resolveGitRoot(path.dirname(file));
  } catch {
    return null;
  }
}

export async function readGitHubRemote(directory: string) {
  try {
    const config = await git(directory, ['config', '--get-regexp', '^remote[.].*[.]url$']);
    const remotes = config
      .trim()
      .split('\n')
      .map((line) => {
        const space = line.search(/\s/);
        return { name: line.slice(0, space), url: line.slice(space + 1) };
      });
    remotes.sort(
      (a, b) => Number(b.name === 'remote.origin.url') - Number(a.name === 'remote.origin.url'),
    );
    for (const remote of remotes) {
      const repository = getGitHubRemoteRepository(remote.url);
      if (repository) return repository;
    }
  } catch {
    /* A local repository does not need a remote. */
  }
  return null;
}

export function parseGitStatus(output: string): Omit<GitSnapshot, 'commits'> & { unborn: boolean } {
  const result = {
    branch: '',
    upstream: '',
    ahead: 0,
    behind: 0,
    changes: [] as GitChange[],
    unborn: false,
  };
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('# branch.head '))
      result.branch = record.slice(14) === '(detached)' ? 'Detached HEAD' : record.slice(14);
    else if (record.startsWith('# branch.oid ')) result.unborn = record.slice(13) === '(initial)';
    else if (record.startsWith('# branch.upstream ')) result.upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) {
      const match = record.match(/\+(\d+) -(\d+)/);
      if (match) {
        result.ahead = Number(match[1]);
        result.behind = Number(match[2]);
      }
    } else if (record.startsWith('? '))
      result.changes.push({ path: record.slice(2), index: '?', worktree: '?' });
    else if (/^[12u] /.test(record)) {
      const fields = record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10;
      let offset = 0;
      for (let field = 0; field < fields; field++) offset = record.indexOf(' ', offset) + 1;
      const change: GitChange = {
        path: record.slice(offset),
        index: record[2],
        worktree: record[3],
      };
      if (record[0] === '2') change.originalPath = records[++i];
      result.changes.push(change);
    }
  }
  return result;
}

async function readGitStatus(directory: string) {
  return parseGitStatus(
    await git(directory, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
  );
}

export async function readGitSnapshot(directory: string): Promise<GitSnapshot> {
  const { unborn, ...status } = await readGitStatus(directory);
  const log = unborn
    ? ''
    : await git(directory, [
        'log',
        '-30',
        '--format=%H%x00%s%x00%an%x00%aI%x00',
        '--no-show-signature',
      ]);
  const fields = log.split('\0');
  const commits = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    commits.push({
      hash: fields[i].trim(),
      subject: fields[i + 1],
      author: fields[i + 2],
      date: fields[i + 3],
    });
  }
  return { ...status, commits };
}

async function repositoryFile(directory: string, name: string): Promise<string> {
  if (!name || path.isAbsolute(name) || name.includes('\0'))
    throw new Error('Invalid repository file.');
  const root = await fs.realpath(directory);
  const resolved = await fs.realpath(path.resolve(root, name));
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('This file points outside the linked repository.');
  return resolved;
}

export async function openGitFile(directory: string, name: string): Promise<string> {
  return pathToFileURL(await repositoryFile(directory, name)).href;
}

export async function readGitDiff(directory: string, name: string): Promise<GitFileDiff> {
  const snapshot = await readGitStatus(directory);
  const change = snapshot.changes.find((entry) => entry.path === name);
  if (!change) throw new Error('This file has no local changes. Refresh the repository.');
  let staged = '',
    unstaged = '';
  if (change.index === '?') {
    const file = await repositoryFile(directory, name);
    const handle = await fs.open(file, 'r');
    try {
      const bytes = Buffer.alloc(256_001);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const data = bytes.subarray(0, bytesRead);
      if (data.includes(0)) unstaged = 'Binary file';
      else unstaged = data.toString('utf8');
      return { staged, unstaged: unstaged.slice(0, 256_000), truncated: bytesRead > 256_000 };
    } finally {
      await handle.close();
    }
  }
  const paths = change.originalPath ? [change.originalPath, name] : [name];
  [staged, unstaged] = await Promise.all([
    git(directory, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ...paths]),
    git(directory, ['diff', '--no-ext-diff', '--no-textconv', '--', ...paths]),
  ]);
  return {
    staged: staged.slice(0, 256_000),
    unstaged: unstaged.slice(0, 256_000),
    truncated: staged.length > 256_000 || unstaged.length > 256_000,
  };
}
