export type GitHubRepository = { key: string; name: string };
export type GitRepository = GitHubRepository & { github?: string | null };
export type GitRepositoryLink = { path: string };
export type GitEditorRepository = {
  repository: GitRepository;
  link: GitRepositoryLink;
  target: string;
};
export type GitChange = { path: string; originalPath?: string; index: string; worktree: string };
export type GitCommit = { hash: string; subject: string; author: string; date: string };
export type GitSnapshot = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
  commits: GitCommit[];
};
export type GitFileDiff = { staged: string; unstaged: string; truncated: boolean };

// These GitHub routes have two path segments but do not identify repositories.
const reservedOwners = new Set([
  'about',
  'account',
  'apps',
  'codespaces',
  'collections',
  'contact',
  'customer-stories',
  'discussions',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'search',
  'security',
  'sessions',
  'settings',
  'signup',
  'site',
  'sponsors',
  'stars',
  'topics',
  'trending',
  'users',
]);

export function getGitHubRepository(raw: string): GitHubRepository | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    const [owner, rawRepo] = url.pathname.split('/').filter(Boolean);
    const repo = rawRepo?.replace(/\.git$/i, '');
    if (
      !owner ||
      !repo ||
      reservedOwners.has(owner.toLowerCase()) ||
      !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner) ||
      !/^[\w.-]+$/.test(repo) ||
      repo === '.' ||
      repo === '..'
    )
      return null;
    const name = `${owner}/${repo}`;
    return { key: name.toLowerCase(), name };
  } catch {
    return null;
  }
}

export function getGitHubRemoteRepository(raw: string): GitHubRepository | null {
  const value = raw.trim();
  const ssh = value.match(/^git@github\.com:(.+)$/i);
  if (ssh) return getGitHubRepository(`https://github.com/${ssh[1]}`);
  try {
    const url = new URL(value);
    if (url.protocol === 'ssh:' && url.hostname === 'github.com')
      return getGitHubRepository(`https://github.com${url.pathname}`);
  } catch {
    /* Not a URL. */
  }
  return getGitHubRepository(value);
}
