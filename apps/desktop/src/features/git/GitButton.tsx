import { LoaderCircle } from 'lucide-react';
import GitLogo from './GitLogo';
import { electron } from '../../electronBridge';
import { useGitRepository } from './GitProvider';

export default function GitButton({ right, onOpen }: { right: number; onOpen: () => void }) {
  const { repository, link, sidebarOpen, loading, busy, toggle } = useGitRepository();
  if (!repository || !electron) return null;
  const label = link
    ? sidebarOpen
      ? 'Hide local Git sidebar'
      : 'Show local Git sidebar'
    : 'Link local Git repository';
  return (
    <button
      type="button"
      className="theme-btn theme-btn-nav git-address-button"
      style={{ right }}
      title={`${label}: ${repository.name}`}
      aria-label={label}
      aria-pressed={sidebarOpen}
      aria-busy={busy || loading}
      disabled={busy || loading}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onOpen();
        toggle();
      }}
    >
      {busy || loading ? <LoaderCircle size={16} aria-hidden="true" /> : <GitLogo />}
    </button>
  );
}
