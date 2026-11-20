import type { GitCommit } from '../../../electron/githubRepository';

export type CommitPeriod = 'all' | 'day' | 'week' | 'month';

export function filterGitCommits(
  commits: GitCommit[],
  author: string,
  period: CommitPeriod,
  now = Date.now(),
) {
  const days = { all: Infinity, day: 1, week: 7, month: 30 }[period];
  const cutoff = now - days * 86_400_000;
  return commits.filter(
    (commit) =>
      (!author || commit.author === author) &&
      (period === 'all' || new Date(commit.date).getTime() >= cutoff),
  );
}

export function groupGitCommits(commits: GitCommit[]) {
  const groups = new Map<string, { key: string; label: string; commits: GitCommit[] }>();
  for (const commit of commits) {
    const date = new Date(commit.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: date.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        commits: [],
      };
      groups.set(key, group);
    }
    group.commits.push(commit);
  }
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
}

export function relativeCommitTime(date: string, now = Date.now()) {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  if (Math.abs(seconds) < 60) return 'just now';
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const [unit, duration] = units.find(([, duration]) => Math.abs(seconds) >= duration)!;
  return formatter.format(Math.trunc(seconds / duration), unit);
}
