import { useState } from 'react';
import {
  BookOpen,
  Briefcase,
  Check,
  Code2,
  Coffee,
  Globe,
  Home,
  PanelsTopLeft,
  Pencil,
  Plus,
  Star,
} from 'lucide-react';
import { electron } from '../electronBridge';
import { useTabs } from '../features/tabs/TabsProvider';
import {
  openWorkspaceEditor,
  useWorkspaces,
  workspaceAction,
  type Workspace,
} from '../features/workspaces/useWorkspaces';
import { profileError } from '../features/profiles/useProfiles';
export const workspaceIcons = {
  panels: PanelsTopLeft,
  briefcase: Briefcase,
  home: Home,
  code: Code2,
  book: BookOpen,
  globe: Globe,
  coffee: Coffee,
  star: Star,
};
export function WorkspaceIcon({
  workspace,
  size = 22,
}: {
  workspace: Pick<Workspace, 'icon' | 'avatar'>;
  size?: number;
}) {
  const Icon = workspaceIcons[workspace.icon as keyof typeof workspaceIcons] ?? PanelsTopLeft;
  return (
    <span className="workspace-avatar" style={{ width: size, height: size }}>
      {workspace.avatar ? (
        <img src={workspace.avatar} alt="" />
      ) : (
        <Icon size={size} aria-hidden="true" />
      )}
    </span>
  );
}
export default function WorkspaceList({
  sidebar = false,
  tooltips = false,
  onClose,
}: {
  sidebar?: boolean;
  tooltips?: boolean;
  onClose?: () => void;
}) {
  const workspaces = useWorkspaces();
  const { newTab } = useTabs();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const itemClass = sidebar ? 'browser-sidebar-item' : 'address-menu-item profile-select';
  const labelClass = sidebar ? 'browser-sidebar-label' : 'profile-name';
  const edit = (workspace?: Workspace) => {
    openWorkspaceEditor(workspace);
    onClose?.();
  };
  return (
    <div
      className={sidebar ? 'workspace-sidebar-list' : 'profile-menu-inline'}
      role="group"
      aria-label="Workspaces"
    >
      <div className={sidebar ? 'browser-sidebar-section-heading' : 'profile-menu-heading'}>
        {sidebar ? (
          <button
            className="theme-btn theme-btn-nav browser-sidebar-item browser-sidebar-section-link"
            aria-label="Workspaces"
            data-sidebar-tooltip={tooltips ? 'Workspaces' : undefined}
            onClick={() => newTab('mira://Settings#section=workspaces')}
          >
            <span className="browser-sidebar-icon">
              <PanelsTopLeft size={18} />
            </span>
            <span className={labelClass}>Workspaces</span>
          </button>
        ) : (
          <strong>Workspaces</strong>
        )}
        <button
          type="button"
          className={`theme-btn theme-btn-nav profile-small-button ${sidebar ? 'browser-sidebar-section-action' : ''}`}
          aria-label="Add workspace"
          data-sidebar-tooltip={tooltips ? 'Add workspace' : undefined}
          onClick={() => edit()}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className={sidebar ? 'browser-sidebar-list' : 'profile-menu-list'}>
        {workspaces.map((workspace) => (
          <div
            className={sidebar ? 'workspace-sidebar-row' : 'profile-menu-row'}
            key={workspace.id}
          >
            <button
              type="button"
              className={`theme-btn theme-btn-nav ${itemClass}`}
              aria-label={`Open workspace ${workspace.name}`}
              data-sidebar-tooltip={tooltips ? workspace.name : undefined}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void workspaceAction('workspaces-open', workspace.id)
                  .then(() => onClose?.())
                  .catch((failure) => setError(profileError(failure)))
                  .finally(() => setBusy(false));
              }}
            >
              <span className={sidebar ? 'browser-sidebar-icon' : 'profile-avatar-slot'}>
                <WorkspaceIcon workspace={workspace} />
              </span>
              <span className={labelClass}>{workspace.name}</span>
              {workspace.id === electron?.workspaceId && (
                <Check
                  size={14}
                  className={sidebar ? 'browser-sidebar-label' : ''}
                  aria-label="Current workspace"
                />
              )}
            </button>
            {!sidebar && (
              <button
                className="theme-btn theme-btn-nav profile-small-button"
                aria-label={`Edit workspace ${workspace.name}`}
                onClick={() => edit(workspace)}
              >
                <Pencil size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p className="profile-menu-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
