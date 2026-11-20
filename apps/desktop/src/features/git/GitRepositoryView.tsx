import { Activity, useCallback, useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import GitLogo from './GitLogo';
import { electron } from '../../electronBridge';
import ContextMenu from '../../components/ContextMenu';
import { useTabs } from '../tabs/TabsProvider';
import FileTypeIcon from '../tabs/FileTypeIcon';
import { getGitDiffLines } from './gitDiff';
import { useGitRepository } from './GitProvider';
import GitCommits from './GitCommits';
import type { GitChange, GitFileDiff, GitSnapshot } from '../../../electron/githubRepository';
import './git.css';

function changeInfo(change: GitChange) {
  if (change.index === '?') return { label: 'Untracked', code: 'U', kind: 'added' };
  if (
    change.index === 'U' ||
    change.worktree === 'U' ||
    ['AA', 'DD'].includes(change.index + change.worktree)
  )
    return { label: 'Conflict', code: '!', kind: 'conflict' };
  const code = change.worktree !== '.' ? change.worktree : change.index;
  const label =
    { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' }[
      code
    ] ?? 'Changed';
  return { label, code, kind: code === 'D' ? 'removed' : code === 'A' ? 'added' : 'changed' };
}

function fileParts(path: string) {
  const lastSlash = path.lastIndexOf('/');
  return {
    name: path.slice(lastSlash + 1),
    directory: lastSlash < 0 ? '' : path.slice(0, lastSlash),
  };
}

function DiffSection({
  title,
  text,
  patch = true,
}: {
  title: string;
  text: string;
  patch?: boolean;
}) {
  const lines = getGitDiffLines(text, patch);
  const added = lines.filter((line) => line.kind === 'added').length;
  const removed = lines.filter((line) => line.kind === 'removed').length;
  return (
    <section className="git-diff-section">
      <h3>
        {title}
        <span className="git-diff-stats">
          {added > 0 && <span className="git-stat-added">+{added}</span>}
          {removed > 0 && <span className="git-stat-removed">−{removed}</span>}
        </span>
      </h3>
      <pre>
        {lines.map((line, index) => (
          <span key={index} className={`git-diff-line git-line-${line.kind}`}>
            <span className="git-line-number" aria-hidden="true">
              {line.oldLine}
            </span>
            <span className="git-line-number" aria-hidden="true">
              {line.newLine}
            </span>
            <span className="git-line-sign" aria-hidden="true">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ''}
            </span>
            <span className="git-line-code">{line.text || ' '}</span>
          </span>
        ))}
      </pre>
    </section>
  );
}

export default function GitRepositoryView({ onClose }: { onClose: () => void }) {
  const { repository, target, isLocal, link, busy, pickFolder, unlink } = useGitRepository();
  const { newTab } = useTabs();
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [section, setSection] = useState<'changes' | 'commits'>('changes');
  const [selected, setSelected] = useState('');
  const [diffResult, setDiffResult] = useState<{ path: string; data: GitFileDiff } | null>(null);
  const diff = diffResult?.path === selected ? diffResult.data : null;
  const [diffError, setDiffError] = useState('');
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenuAnchor(null), []);
  const url = target;
  const githubRepository =
    repository?.github === undefined ? (repository?.key ?? null) : repository.github;

  useEffect(() => {
    let alive = true;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      setRefreshing(true);
      try {
        const value = await electron!.ipcRenderer.invoke<GitSnapshot>('git-repository-status', url);
        if (alive) {
          setSnapshot(value);
          setError('');
        }
      } catch (error) {
        if (alive) setError(String(error));
      } finally {
        running = false;
        if (alive) setRefreshing(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [url, revision]);

  useEffect(() => {
    if (!selected || !snapshot) return;
    let alive = true;
    setDiffError('');
    if (!snapshot.changes.some((change) => change.path === selected)) {
      setSelected('');
      return;
    }
    void electron!.ipcRenderer
      .invoke<GitFileDiff>('git-repository-diff', url, selected)
      .then((value) => {
        if (alive) setDiffResult({ path: selected, data: value });
      })
      .catch((error) => {
        if (alive) setDiffError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [url, selected, snapshot]);

  const selectedChange = snapshot?.changes.find((change) => change.path === selected);
  const openFile = async () => {
    try {
      newTab(await electron!.ipcRenderer.invoke<string>('git-repository-file', url, selected));
    } catch (error) {
      setDiffError(String(error));
    }
  };
  const selectedInfo = selectedChange ? changeInfo(selectedChange) : null;
  const selectedParts = fileParts(selected);
  return (
    <div className="git-repository-view">
      <header className="git-toolbar">
        <GitLogo className="git-repo-logo" size={19} />
        <div className="git-repo-identity">
          <h1 title={repository?.name}>{repository?.name}</h1>
          <span title={link?.path}>{link?.path}</span>
        </div>
        <div className="git-toolbar-actions">
          <button
            type="button"
            className="git-icon-button"
            aria-label="Refresh repository"
            title="Refresh repository"
            disabled={refreshing}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw
              size={15}
              className={refreshing ? 'git-spinning' : undefined}
              aria-hidden="true"
            />
          </button>
          {!isLocal && (
            <button
              type="button"
              className="git-icon-button"
              aria-label="Repository options"
              title="Repository options"
              aria-haspopup="menu"
              aria-expanded={!!menuAnchor}
              disabled={busy}
              onClick={(event) => {
                if (menuAnchor) {
                  closeMenu();
                  return;
                }
                const box = event.currentTarget.getBoundingClientRect();
                setMenuAnchor({ x: box.right - 190, y: box.bottom + 5 });
              }}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="git-icon-button"
            aria-label="Close local Git sidebar"
            title="Close local Git sidebar"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      {snapshot && (
        <div className="git-branch-bar">
          <span
            className="git-current-branch"
            title={
              snapshot.upstream ? `${snapshot.branch} → ${snapshot.upstream}` : snapshot.branch
            }
          >
            <GitBranch size={13} aria-hidden="true" />
            <span>{snapshot.branch}</span>
          </span>
          {snapshot.upstream && (
            <span
              className="git-sync-status"
              title={`Tracking ${snapshot.upstream}: ${snapshot.ahead} ahead, ${snapshot.behind} behind`}
            >
              {snapshot.ahead === 0 && snapshot.behind === 0 ? (
                <>
                  <Check size={12} aria-hidden="true" />
                  Up to date
                </>
              ) : (
                <>
                  <ArrowUp size={12} aria-hidden="true" />
                  {snapshot.ahead}
                  <ArrowDown size={12} aria-hidden="true" />
                  {snapshot.behind}
                </>
              )}
            </span>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="git-error">
          {error}
          <span>
            {isLocal
              ? 'Check that the file’s repository is still available.'
              : 'Choose a folder from Repository options to reconnect.'}
          </span>
        </div>
      )}
      <nav className="git-view-tabs" aria-label="Repository views">
        <button
          type="button"
          aria-label="Show changes"
          aria-pressed={section === 'changes'}
          onClick={() => {
            setSection('changes');
          }}
        >
          Changes{snapshot && <span className="git-count">{snapshot.changes.length}</span>}
        </button>
        <button
          type="button"
          aria-label="Show commits"
          aria-pressed={section === 'commits'}
          onClick={() => {
            setSection('commits');
          }}
        >
          <GitCommitHorizontal size={13} aria-hidden="true" />
          Commits
        </button>
      </nav>
      {!snapshot ? (
        <div className="git-loading" role="status">
          {!error && <LoaderCircle size={16} className="git-spinning" aria-hidden="true" />}
          {error ? 'Repository unavailable' : 'Reading repository…'}
        </div>
      ) : (
        <>
          <Activity mode={section === 'commits' ? 'visible' : 'hidden'}>
            <GitCommits
              commits={snapshot.commits}
              branch={snapshot.branch}
              repository={githubRepository}
            />
          </Activity>
          <Activity mode={section === 'changes' ? 'visible' : 'hidden'}>
            {selectedChange && selectedInfo ? (
              <div className="git-file-detail">
                <div className="git-detail-toolbar">
                  <button
                    type="button"
                    className="git-back-button"
                    aria-label="Back to changes"
                    onClick={() => setSelected('')}
                  >
                    <ArrowLeft size={14} aria-hidden="true" />
                    Changes
                  </button>
                  {selectedChange.worktree !== 'D' && selectedChange.index !== 'D' && (
                    <button
                      type="button"
                      className="git-icon-button"
                      title="Open file"
                      aria-label="Open file"
                      onClick={() => {
                        void openFile();
                      }}
                    >
                      <SquareArrowOutUpRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <div className="git-detail-filename">
                  <div>
                    <h2 title={selected}>{selectedParts.name}</h2>
                    {selectedParts.directory && (
                      <span title={selectedParts.directory}>{selectedParts.directory}</span>
                    )}
                  </div>
                  <span className="git-change-label" data-kind={selectedInfo.kind}>
                    {selectedInfo.label}
                  </span>
                </div>
                <div
                  className="git-diff-pane git-scroll-area"
                  role="region"
                  aria-label="File changes"
                >
                  {diffError ? (
                    <div className="git-error" role="alert">
                      {diffError}
                    </div>
                  ) : !diff ? (
                    <div className="git-loading" role="status">
                      <LoaderCircle size={15} className="git-spinning" aria-hidden="true" />
                      Loading diff…
                    </div>
                  ) : (
                    <>
                      {diff.truncated && (
                        <p className="git-preview-note">Preview shortened for this large file.</p>
                      )}
                      {selectedChange.originalPath && (
                        <p className="git-preview-note">
                          Renamed from {selectedChange.originalPath}
                        </p>
                      )}
                      {diff.staged && <DiffSection title="Staged" text={diff.staged} />}
                      {diff.unstaged && (
                        <DiffSection
                          title={selectedChange.index === '?' ? 'Untracked file' : 'Unstaged'}
                          text={diff.unstaged}
                          patch={selectedChange.index !== '?'}
                        />
                      )}
                      {!diff.staged && !diff.unstaged && (
                        <p className="git-preview-note">No text diff available for this change.</p>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div
                className="git-file-list git-scroll-area"
                role="region"
                aria-label="Changed files"
              >
                {snapshot.changes.length === 0 ? (
                  <div className="git-empty">
                    <Check size={24} aria-hidden="true" />
                    <h2>Working tree clean</h2>
                    <p>No local changes.</p>
                  </div>
                ) : (
                  snapshot.changes.map((change) => {
                    const info = changeInfo(change);
                    const parts = fileParts(change.path);
                    const staged =
                      change.index !== '.' && change.index !== '?' && info.kind !== 'conflict';
                    return (
                      <button
                        type="button"
                        key={change.path}
                        className="git-file"
                        aria-label={`View ${info.label.toLowerCase()} file ${change.path}`}
                        onClick={() => setSelected(change.path)}
                        title={`${change.path} · ${info.label}${staged ? ' · Staged' : ''}`}
                      >
                        <span className="git-file-icon" aria-hidden="true">
                          <FileTypeIcon
                            url={`file:///${change.path.split('/').map(encodeURIComponent).join('/')}`}
                            size={16}
                          />
                        </span>
                        <span className="git-file-text">
                          <span className="git-file-name">{parts.name}</span>
                          {(parts.directory || staged) && (
                            <span className="git-file-directory">
                              {parts.directory}
                              {parts.directory && staged ? ' · ' : ''}
                              {staged ? 'Staged' : ''}
                            </span>
                          )}
                        </span>
                        <span className="git-file-status" data-kind={info.kind} aria-hidden="true">
                          {info.code}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </Activity>
        </>
      )}
      <ContextMenu
        open={!!menuAnchor}
        anchor={menuAnchor}
        onClose={closeMenu}
        minWidth={190}
        entries={[
          {
            type: 'item',
            label: 'Change folder',
            disabled: busy,
            onSelect: () => {
              closeMenu();
              void pickFolder();
            },
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Unlink repository',
            disabled: busy,
            onSelect: () => {
              closeMenu();
              void unlink();
            },
          },
        ]}
      />
    </div>
  );
}
