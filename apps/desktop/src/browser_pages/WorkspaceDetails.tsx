import { useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { electron } from '../electronBridge';
import { useTabs } from '../features/tabs/TabsProvider';
import {
  useWorkspaces,
  workspaceAction,
  type Workspace,
} from '../features/workspaces/useWorkspaces';
import { WorkspaceIcon, workspaceIcons } from '../components/WorkspaceList';
import { profileError } from '../features/profiles/useProfiles';
function Details({ workspace }: { workspace: Workspace }) {
  const [draft, setDraft] = useState(workspace);
  const latest = useRef(workspace);
  const [error, setError] = useState('');
  const [urls, setUrls] = useState(workspace.urls.join('\n'));
  const { tabs } = useTabs();
  const save = async (changes: Partial<Workspace>) => {
    const next = { ...latest.current, ...changes };
    latest.current = next;
    setDraft(next);
    if (!next.name.trim()) return;
    try {
      await workspaceAction('workspaces-save', next);
      setError('');
    } catch (failure) {
      setError(profileError(failure));
    }
  };
  const saveUrls = (value: string) => {
    const entries = value
      .split('\n')
      .map((url) => url.trim())
      .filter(Boolean);
    if (entries.some((url) => !/^(https?:\/\/|mira:\/\/)/i.test(url))) {
      setError('Use a full http, https, or mira URL for each tab.');
      return;
    }
    void save({ urls: entries });
  };
  return (
    <>
      <section className="settings-group">
        <div className="settings-card-header">
          <h3 className="settings-card-title">Workspace</h3>
        </div>
        <div className="settings-card">
          <label className="settings-setting-row">
            <span className="settings-setting-label">Name</span>
            <input
              aria-label="Workspace name"
              className="theme-input settings-select-input settings-setting-control settings-setting-control-grow"
              maxLength={60}
              value={draft.name}
              onChange={(event) => void save({ name: event.target.value })}
            />
          </label>
          <div className="settings-setting-row">
            <span className="settings-setting-label">Picture</span>
            <div className="settings-profile-actions">
              <WorkspaceIcon workspace={draft} size={32} />
              <button
                type="button"
                className="theme-btn theme-btn-nav settings-profile-icon-button"
                aria-label="Choose workspace picture"
                onClick={() =>
                  void workspaceAction<string | null>('profiles-pick-avatar')
                    .then((avatar) => {
                      if (avatar) void save({ avatar });
                    })
                    .catch((failure) => setError(profileError(failure)))
                }
              >
                <ImagePlus size={18} />
              </button>
              {draft.avatar && (
                <button
                  type="button"
                  className="theme-btn theme-btn-nav"
                  onClick={() => void save({ avatar: null })}
                >
                  Remove picture
                </button>
              )}
            </div>
          </div>
          <div className="settings-setting-row">
            <span className="settings-setting-label">Icon</span>
            <div className="workspace-icon-picker">
              {Object.entries(workspaceIcons).map(([key, Icon]) => (
                <button
                  key={key}
                  type="button"
                  className="theme-btn theme-btn-nav"
                  aria-label={`${key} icon`}
                  aria-pressed={!draft.avatar && draft.icon === key}
                  onClick={() => void save({ icon: key, avatar: null })}
                >
                  <Icon size={18} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section className="settings-group">
        <div className="settings-card-header">
          <h3 className="settings-card-title">Starting tabs</h3>
        </div>
        <div className="settings-card">
          <label className="settings-setting-row">
            <span className="settings-setting-label">When opened</span>
            <select
              className="theme-input settings-select-input settings-setting-control"
              value={draft.startup}
              onChange={(event) =>
                void save({ startup: event.target.value === 'fixed' ? 'fixed' : 'restore' })
              }
            >
              <option value="restore">Restore last tabs</option>
              <option value="fixed">Open set tabs</option>
            </select>
          </label>
          <div className="settings-setting-row workspace-starting-tabs">
            <label className="settings-setting-label" htmlFor="workspace-starting-tabs">
              Starting tabs
            </label>
            <textarea
              id="workspace-starting-tabs"
              className="theme-input"
              placeholder="One URL per line"
              value={urls}
              onChange={(event) => setUrls(event.target.value)}
              onBlur={() => saveUrls(urls)}
            />
            <button
              type="button"
              className="theme-btn theme-btn-nav"
              onClick={() => {
                const value = tabs
                  .filter((tab) => !/^mira:\/\/(Settings|WorkspaceSettings)/i.test(tab.url))
                  .map((tab) => tab.url)
                  .join('\n');
                setUrls(value);
                saveUrls(value);
              }}
            >
              Use current tabs
            </button>
          </div>
        </div>
      </section>
      {error && (
        <p className="profile-menu-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="theme-btn theme-btn-nav workspace-delete"
        onClick={() =>
          void workspaceAction('workspaces-remove', workspace.id).catch((failure) =>
            setError(profileError(failure)),
          )
        }
      >
        Delete workspace
      </button>
    </>
  );
}
export default function WorkspaceDetails() {
  const workspaces = useWorkspaces();
  const workspace = workspaces.find((item) => item.id === electron?.workspaceId);
  return workspace ? <Details key={workspace.id} workspace={workspace} /> : null;
}
