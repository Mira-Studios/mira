import { useState } from 'react';
import { Check, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { profileAction, profileError, useProfiles } from '../features/profiles/useProfiles';
import { openProfileEditor } from '../features/profiles/profileEditor';

export default function ProfileSettings() {
  const state = useProfiles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(profileError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-group">
      <div className="settings-card-header settings-profiles-heading">
        <h3 className="settings-card-title">Your profiles</h3>
        <button
          type="button"
          className="theme-btn theme-btn-nav settings-profile-icon-button"
          aria-label="Add profile"
          title="Add profile"
          disabled={busy}
          onClick={() => openProfileEditor()}
        >
          <Plus size={20} />
        </button>
      </div>
      <div className="settings-card">
        {state.profiles.map((profile) => (
          <div className="settings-setting-row settings-profile-row" key={profile.id}>
            <div className="settings-profile-identity">
              <span className="settings-profile-avatar-slot">
                {profile.avatar ? (
                  <img
                    src={profile.avatar}
                    className="profile-avatar settings-profile-avatar"
                    alt=""
                  />
                ) : (
                  <UserRound size={32} aria-hidden="true" />
                )}
              </span>
              <span className="settings-setting-label">{profile.name}</span>
              {profile.id === state.currentId && <Check size={14} aria-label="Current profile" />}
            </div>
            <div className="settings-profile-actions">
              <button
                type="button"
                className="theme-btn theme-btn-nav settings-btn-pad"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await profileAction('profiles-open', profile.id);
                  })
                }
              >
                Open
              </button>
              <button
                type="button"
                className="theme-btn theme-btn-nav settings-profile-icon-button"
                disabled={busy}
                aria-label={`Edit ${profile.name}`}
                onClick={() => openProfileEditor(profile)}
              >
                <Pencil size={16} />
              </button>
              <button
                type="button"
                className="theme-btn theme-btn-nav settings-profile-icon-button"
                disabled={busy || state.profiles.length < 2}
                aria-label={`Remove ${profile.name}`}
                onClick={() =>
                  void run(async () => {
                    await profileAction('profiles-remove', profile.id);
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
        {error && (
          <p role="alert" className="settings-inline-message profile-menu-error">
            {error}
          </p>
        )}
      </div>
      <div className="settings-card-header settings-profile-sync-heading">
        <h3 className="settings-card-title">Sync settings between profiles</h3>
      </div>
      <div className="settings-card">
        {state.profiles.map((profile) => (
          <label
            className="settings-setting-row"
            htmlFor={`profile-sync-${profile.id}`}
            key={profile.id}
          >
            <span className="settings-setting-label">{profile.name}</span>
            <input
              id={`profile-sync-${profile.id}`}
              type="checkbox"
              className="settings-toggle settings-setting-control"
              checked={profile.syncSettings === true}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                void run(async () => {
                  await profileAction('profiles-set-settings-sync', profile.id, enabled);
                });
              }}
            />
          </label>
        ))}
      </div>
      <div className="settings-card-header settings-profile-sync-heading">
        <h3 className="settings-card-title">Startup</h3>
      </div>
      <div className="settings-card">
        <div className="settings-setting-row">
          <label htmlFor="profile-startup-picker" className="settings-setting-label">
            Ask which profile to open on startup
          </label>
          <input
            id="profile-startup-picker"
            type="checkbox"
            className="settings-toggle settings-setting-control"
            checked={state.showPickerOnStartup}
            disabled={busy}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void run(async () => {
                await profileAction('profiles-set-startup-picker', enabled);
              });
            }}
          />
        </div>
      </div>
    </section>
  );
}
