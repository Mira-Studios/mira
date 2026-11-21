import { Pencil, Plus } from 'lucide-react';
import { electron } from '../electronBridge';
import {
  openWorkspaceEditor,
  useWorkspaces,
  workspaceAction,
} from '../features/workspaces/useWorkspaces';
import { WorkspaceIcon } from '../components/WorkspaceList';
import { useState } from 'react';
import { profileError } from '../features/profiles/useProfiles';
export default function Workspaces() {
  const workspaces = useWorkspaces();
  const [error, setError] = useState('');
  if (electron?.isPrivate) return null;
  return (
    <section className="settings-group">
      <div className="settings-card-header settings-profiles-heading">
        <h3 className="settings-card-title">Your workspaces</h3>
        <button
          type="button"
          className="theme-btn theme-btn-nav settings-profile-icon-button"
          aria-label="Add workspace"
          onClick={() => openWorkspaceEditor()}
        >
          <Plus size={18} />
        </button>
      </div>
      <div className="settings-card">
        {workspaces.map((workspace) => (
          <div className="settings-setting-row" key={workspace.id}>
            <div className="settings-profile-identity">
              <WorkspaceIcon workspace={workspace} size={32} />
              <span className="settings-setting-label">{workspace.name}</span>
            </div>
            <div className="settings-profile-actions">
              <button
                className="theme-btn theme-btn-nav"
                onClick={() =>
                  void workspaceAction('workspaces-open', workspace.id).catch((failure) =>
                    setError(profileError(failure)),
                  )
                }
              >
                Open
              </button>
              <button
                className="theme-btn theme-btn-nav settings-profile-icon-button"
                aria-label={`Edit workspace ${workspace.name}`}
                onClick={() => openWorkspaceEditor(workspace)}
              >
                <Pencil size={16} />
              </button>
            </div>
          </div>
        ))}
        {!workspaces.length && <p className="theme-text2">No workspaces yet</p>}
      </div>
      {error && (
        <p className="profile-menu-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
