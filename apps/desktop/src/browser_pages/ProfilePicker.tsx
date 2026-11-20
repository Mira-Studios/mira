import { useState } from 'react';
import { Plus, UserRound, X } from 'lucide-react';
import { electron } from '../electronBridge';
import { useProfiles, profileAction, profileError } from '../features/profiles/useProfiles';
import { openProfileEditor } from '../features/profiles/profileEditor';
import miraLogo from '../assets/mira_logo.png';
import './Onboarding.css';
import './ProfilePicker.css';

export default function ProfilePicker() {
  const state = useProfiles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="onboarding-root profile-picker">
      <header className="onboarding-header">
        <div className="onboarding-brand">
          <img src={miraLogo} alt="" />
          <span>Mira</span>
        </div>
        <button
          type="button"
          className="site-interaction-close"
          aria-label="Close window"
          onClick={() => void electron?.ipcRenderer.invoke('window-close')}
        >
          <X size={18} />
        </button>
      </header>
      <main className="profile-picker-main">
        <div className="profile-picker-heading">
          <h1>Choose a profile</h1>
          <button
            type="button"
            className="theme-btn theme-btn-nav profile-small-button"
            aria-label="Add profile"
            title="Add profile"
            disabled={busy}
            onClick={() => openProfileEditor()}
          >
            <Plus size={20} />
          </button>
        </div>
        <div className="profile-picker-grid">
          {state.profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className="theme-btn theme-btn-nav profile-picker-card"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void profileAction('profiles-open', profile.id).catch((failure) => {
                  setError(profileError(failure));
                  setBusy(false);
                });
              }}
            >
              <span className="profile-picker-avatar">
                {profile.avatar ? <img src={profile.avatar} alt="" /> : <UserRound size={40} />}
              </span>
              <span>{profile.name}</span>
            </button>
          ))}
        </div>
        {error && (
          <p className="profile-menu-error" role="alert">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
