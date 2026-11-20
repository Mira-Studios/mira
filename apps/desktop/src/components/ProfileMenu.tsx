import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Pencil, Plus, UserRound } from 'lucide-react';
import { useProfiles, profileAction, profileError } from '../features/profiles/useProfiles';
import { openProfileEditor } from '../features/profiles/profileEditor';
import { usePromptPresence } from '../hooks/usePromptPresence';

export default function ProfileMenu({
  open,
  showButton,
  onOpen,
  onClose,
  embedded = false,
}: {
  open: boolean;
  showButton: boolean;
  onOpen: () => void;
  onClose: () => void;
  animationsEnabled: boolean;
  embedded?: boolean;
}) {
  const state = useProfiles();
  const request = useMemo(() => (open ? { requestId: 'profile-menu' } : null), [open]);
  const { displayed, closing, animated } = usePromptPresence(request);
  const visible = embedded ? open : !!displayed;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const current = state.profiles.find((p) => p.id === state.currentId);
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    if (!visible || closing) return;
    const previous = document.activeElement;
    if (!embedded) panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: MouseEvent) => {
      if (
        !embedded &&
        !busyRef.current &&
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      )
        onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (embedded && !root.current?.contains(document.activeElement)) return;
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onClose();
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [
        ...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
      ];
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      buttons[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      ]?.focus();
    };
    window.addEventListener('mousedown', outside);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('mousedown', outside);
      window.removeEventListener('keydown', keydown);
      if (!embedded && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [visible, closing, onClose, embedded]);
  const openProfile = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await profileAction('profiles-open', id);
      onClose();
    } catch (failure) {
      setError(profileError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={root} className={embedded ? 'profile-menu-embedded' : 'profile-menu-anchor'}>
      {showButton && (
        <button
          type="button"
          className={`theme-btn theme-btn-nav nav-icon-btn profile-menu-trigger ${open ? 'address-menu-trigger-open' : ''}`}
          title={`Profiles${current ? `: ${current.name}` : ''}`}
          aria-label={`Profiles${current ? `: ${current.name}` : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? onClose() : onOpen())}
        >
          <span className="profile-avatar-slot">
            {current?.avatar ? (
              <img src={current.avatar} alt="" className="profile-avatar" />
            ) : (
              <UserRound size={22} aria-hidden="true" />
            )}
          </span>
        </button>
      )}
      {visible && (
        <div
          ref={panel}
          role={embedded ? 'group' : 'dialog'}
          aria-label="Profiles"
          inert={closing}
          aria-hidden={closing || undefined}
          className={
            embedded
              ? 'profile-menu-inline'
              : `theme-panel address-menu-panel profile-menu-panel ${animated ? (closing ? 'address-menu-panel-closing' : 'address-menu-panel-open') : ''}`
          }
        >
          <div className="profile-menu-heading">
            <strong>Profiles</strong>
            <button
              type="button"
              className="theme-btn theme-btn-nav profile-small-button"
              aria-label="Add profile"
              title="Add profile"
              disabled={busy}
              onClick={() => {
                openProfileEditor();
                onClose();
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="profile-menu-list">
            {state.profiles.map((profile) => (
              <div className="profile-menu-row" key={profile.id}>
                <button
                  type="button"
                  className="theme-btn address-menu-item profile-select"
                  disabled={busy}
                  title={`Open ${profile.name}`}
                  onClick={() => void openProfile(profile.id)}
                >
                  <span className="profile-avatar-slot">
                    {profile.avatar ? (
                      <img className="profile-avatar" src={profile.avatar} alt="" />
                    ) : (
                      <UserRound size={22} />
                    )}
                  </span>
                  <span className="profile-name">{profile.name}</span>
                  {profile.id === state.currentId && (
                    <Check size={14} aria-label="Current profile" />
                  )}
                </button>
                <button
                  type="button"
                  className="theme-btn theme-btn-nav profile-small-button"
                  aria-label={`Edit ${profile.name}`}
                  disabled={busy}
                  onClick={() => {
                    openProfileEditor(profile);
                    onClose();
                  }}
                >
                  <Pencil size={14} />
                </button>
              </div>
            ))}
          </div>
          {error && (
            <p role="alert" className="profile-menu-description profile-menu-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
