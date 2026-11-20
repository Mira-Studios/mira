import { useEffect, useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  Code2,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  UsersRound,
} from 'lucide-react';
import { useTabs } from '../tabs/TabsProvider';
import type { GitCommit } from '../../../electron/githubRepository';
import {
  filterGitCommits,
  groupGitCommits,
  relativeCommitTime,
  type CommitPeriod,
} from './commitPresentation';

export default function GitCommits({
  commits,
  branch,
  repository,
}: {
  commits: GitCommit[];
  branch: string;
  repository: string | null;
}) {
  const { newTab } = useTabs();
  const [author, setAuthor] = useState('');
  const [period, setPeriod] = useState<CommitPeriod>('all');
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const authors = [...new Set(commits.map((commit) => commit.author))];
  if (author && !authors.includes(author)) authors.push(author);
  authors.sort((a, b) => a.localeCompare(b));
  const now = Date.now();
  const groups = groupGitCommits(filterGitCommits(commits, author, period, now));

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyHash = async (hash: string) => {
    setCopyError('');
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(hash);
    } catch {
      setCopyError('Could not copy the commit hash. Try again.');
    }
  };
  const commitUrl = (hash: string) => `https://github.com/${repository}/commit/${hash}`;
  return (
    <div className="git-commits git-scroll-area" role="region" aria-label="Recent commits">
      <div className="git-commit-filters">
        <span className="git-commit-branch" title={branch}>
          <GitBranch size={13} aria-hidden="true" />
          <span>{branch}</span>
        </span>
        <div className="git-commit-filter-controls">
          <label className="git-commit-filter">
            <UsersRound size={13} aria-hidden="true" />
            <select
              aria-label="Filter commits by author"
              value={author}
              onChange={(event) => setAuthor(event.target.value)}
            >
              <option value="">All users</option>
              {authors.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <ChevronDown size={11} aria-hidden="true" />
          </label>
          <label className="git-commit-filter">
            <CalendarDays size={13} aria-hidden="true" />
            <select
              aria-label="Filter commits by time"
              value={period}
              onChange={(event) => setPeriod(event.target.value as CommitPeriod)}
            >
              <option value="all">All time</option>
              <option value="day">Last 24 hours</option>
              <option value="week">Last 7 days</option>
              <option value="month">Last 30 days</option>
            </select>
            <ChevronDown size={11} aria-hidden="true" />
          </label>
        </div>
      </div>
      <span className="git-sr-only" role="status">
        {copied ? 'Commit hash copied' : ''}
      </span>
      {copyError && (
        <p className="git-preview-note" role="alert">
          {copyError}
        </p>
      )}
      {groups.length === 0 ? (
        <div className="git-empty">
          <GitCommitHorizontal size={24} aria-hidden="true" />
          <h2>{commits.length ? 'No matching commits' : 'No commits yet'}</h2>
          {commits.length > 0 && (
            <button
              type="button"
              className="git-back-button"
              onClick={() => {
                setAuthor('');
                setPeriod('all');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="git-commit-timeline">
          {groups.map((group) => (
            <section
              key={group.key}
              className="git-commit-group"
              aria-label={`Commits on ${group.label}`}
            >
              <h2>
                <GitCommitHorizontal size={14} aria-hidden="true" />
                Commits on {group.label}
              </h2>
              <ol className="git-commit-card">
                {group.commits.map((commit) => {
                  const shortHash = commit.hash.slice(0, 7);
                  return (
                    <li key={commit.hash} className="git-commit-row">
                      <div className="git-commit-content">
                        {repository ? (
                          <button
                            type="button"
                            className="git-commit-subject"
                            title="View commit on GitHub"
                            onClick={() => newTab(commitUrl(commit.hash))}
                          >
                            {commit.subject}
                          </button>
                        ) : (
                          <span className="git-commit-subject">{commit.subject}</span>
                        )}
                        <div className="git-commit-meta">
                          <span className="git-author-avatar" aria-hidden="true">
                            {commit.author.trim().slice(0, 1).toUpperCase() || '?'}
                          </span>
                          <span className="git-commit-attribution">
                            <strong>{commit.author}</strong> committed{' '}
                            <time
                              dateTime={commit.date}
                              title={new Date(commit.date).toLocaleString()}
                            >
                              {relativeCommitTime(commit.date, now)}
                            </time>
                          </span>
                        </div>
                      </div>
                      <div className="git-commit-row-actions">
                        {repository ? (
                          <button
                            type="button"
                            className="git-commit-sha"
                            aria-label={`View commit ${shortHash} on GitHub`}
                            title={commit.hash}
                            onClick={() => newTab(commitUrl(commit.hash))}
                          >
                            {shortHash}
                          </button>
                        ) : (
                          <code className="git-commit-sha">{shortHash}</code>
                        )}
                        <button
                          type="button"
                          className="git-icon-button"
                          aria-label={
                            copied === commit.hash
                              ? `Copied commit ${shortHash}`
                              : `Copy commit hash ${shortHash}`
                          }
                          title={copied === commit.hash ? 'Copied' : 'Copy full commit hash'}
                          onClick={() => {
                            void copyHash(commit.hash);
                          }}
                        >
                          {copied === commit.hash ? (
                            <Check size={13} aria-hidden="true" />
                          ) : (
                            <Copy size={13} aria-hidden="true" />
                          )}
                        </button>
                        {repository && (
                          <button
                            type="button"
                            className="git-icon-button"
                            aria-label={`Browse files at commit ${shortHash} on GitHub`}
                            title="Browse files on GitHub at this commit"
                            onClick={() =>
                              newTab(`https://github.com/${repository}/tree/${commit.hash}`)
                            }
                          >
                            <Code2 size={14} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
      {commits.length >= 30 && (
        <p className="git-commit-limit">Showing the 30 most recent local commits.</p>
      )}
    </div>
  );
}
