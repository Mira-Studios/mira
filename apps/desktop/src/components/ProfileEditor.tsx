import { useEffect, useRef, useState } from 'react';
import { ImagePlus, UserRound } from 'lucide-react';
import { electron } from '../electronBridge';
import { usePromptPresence } from '../hooks/usePromptPresence';
import { profileAction, profileError, type Profile } from '../features/profiles/useProfiles';
import {
  PROFILE_EDITOR_EVENT,
  type ProfileEditorRequest,
} from '../features/profiles/profileEditor';

function Editor({
  request,
  closing,
  onClose,
}: {
  request: ProfileEditorRequest;
  closing: boolean;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState(request.profile);
  const [name, setName] = useState(request.profile?.name ?? '');
  const [avatar, setAvatar] = useState(request.profile?.avatar ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    input.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy || closing) return;
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
    <div
      className="site-interaction-backdrop profile-editor-backdrop"
      inert={closing}
      aria-hidden={closing || undefined}
    >
      <form
        ref={form}
        className="site-interaction theme-panel profile-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-editor-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!busy) onClose();
          }
          if (event.key !== 'Tab') return;
          const controls = [
            ...(form.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled)',
            ) ?? []),
          ];
          if (!controls.length) return;
          const index = controls.indexOf(document.activeElement as HTMLElement);
          event.preventDefault();
          controls[
            (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
          ]?.focus();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const saved = await profileAction<Profile>('profiles-save', {
              id: profile?.id,
              name,
              avatar,
            });
            setProfile(saved);
            if (!request.profile) await profileAction('profiles-open', saved.id);
            onClose();
          });
        }}
      >
        <div className="site-interaction-heading">
          <div className="site-interaction-titles">
            <strong id="profile-editor-title">
              {request.profile ? 'Edit profile' : 'Add profile'}
            </strong>
          </div>
        </div>
        <div className="profile-editor-picture-row">
          <button
            type="button"
            className="theme-btn theme-btn-nav profile-editor-picture"
            aria-label="Choose profile picture"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const value = await profileAction<string | null>('profiles-pick-avatar');
                if (value) setAvatar(value);
              })
            }
          >
            {avatar ? <img src={avatar} alt="" /> : <UserRound size={32} />}
            <span>
              <ImagePlus size={14} />
            </span>
          </button>
          {avatar && (
            <button
              type="button"
              className="theme-btn theme-btn-nav profile-editor-button"
              disabled={busy}
              onClick={() => setAvatar(null)}
            >
              Remove picture
            </button>
          )}
        </div>
        <label htmlFor="profile-editor-name" className="profile-editor-label">
          Profile name
        </label>
        <input
          ref={input}
          id="profile-editor-name"
          className="theme-input"
          required
          maxLength={60}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        {error && (
          <p role="alert" className="profile-menu-error">
            {error}
          </p>
        )}
        <div className="site-interaction-actions">
          <button
            type="button"
            className="theme-btn theme-btn-nav profile-editor-button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="theme-btn theme-btn-nav site-interaction-primary profile-editor-button"
            disabled={busy || !name.trim()}
          >
            {busy ? 'Saving…' : request.profile ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ProfileEditor() {
  const [request, setRequest] = useState<ProfileEditorRequest | null>(null);
  const { displayed, closing, animated } = usePromptPresence(request);
  useEffect(() => {
    if (electron?.isPrivate) return;
    const open = (event: Event) => setRequest((event as CustomEvent<ProfileEditorRequest>).detail);
    window.addEventListener(PROFILE_EDITOR_EVENT, open);
    return () => window.removeEventListener(PROFILE_EDITOR_EVENT, open);
  }, []);
  if (!displayed || electron?.isPrivate) return null;
  return (
    <div
      className={
        animated
          ? closing
            ? 'profile-editor-presence profile-editor-exit'
            : 'profile-editor-presence profile-editor-enter'
          : 'profile-editor-presence'
      }
    >
      <Editor
        key={displayed.requestId}
        request={displayed}
        closing={closing}
        onClose={() => setRequest(null)}
      />
    </div>
  );
}
