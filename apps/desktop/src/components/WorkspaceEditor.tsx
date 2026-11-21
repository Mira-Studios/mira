import { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { electron } from '../electronBridge';
import { usePromptPresence } from '../hooks/usePromptPresence';
import { useTabs } from '../features/tabs/TabsProvider';
import { getBrowserSettings } from '../features/settings/browserSettings';
import { workspaceSettings } from '../../electron/workspacePolicy';
import {
  WORKSPACE_EDITOR_EVENT,
  workspaceAction,
  type Workspace,
} from '../features/workspaces/useWorkspaces';
import { profileError } from '../features/profiles/useProfiles';
import { WorkspaceIcon, workspaceIcons } from './WorkspaceList';
import './WorkspaceEditor.css';
type Request = { requestId: string; workspace?: Workspace };
function CreateWorkspace({ closing, onClose }: { closing: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('panels');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    form.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="site-interaction-backdrop profile-editor-backdrop"
      inert={closing}
      aria-hidden={closing || undefined}
    >
      <form
        ref={form}
        className="site-interaction theme-panel profile-editor workspace-editor workspace-editor-creation"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-editor-title"
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
          event.preventDefault();
          const index = controls.indexOf(document.activeElement as HTMLElement);
          controls[
            (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
          ]?.focus();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || closing) return;
          setBusy(true);
          setError('');
          void workspaceAction<Workspace>('workspaces-save', {
            name,
            icon,
            avatar,
            startup: 'restore',
            urls: [],
            settings: workspaceSettings(getBrowserSettings()),
          })
            .then((workspace) => workspaceAction('workspaces-open', workspace.id))
            .then(onClose)
            .catch((failure) => setError(profileError(failure)))
            .finally(() => setBusy(false));
        }}
      >
        <strong id="workspace-editor-title">Add workspace</strong>
        <label className="profile-editor-label" htmlFor="workspace-name">
          Workspace name
        </label>
        <input
          id="workspace-name"
          className="theme-input"
          required
          maxLength={60}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="profile-editor-picture-row">
          <WorkspaceIcon workspace={{ icon, avatar }} size={40} />
          <button
            type="button"
            className="theme-btn theme-btn-nav profile-small-button"
            aria-label="Choose workspace picture"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void workspaceAction<string | null>('profiles-pick-avatar')
                .then((value) => {
                  if (value) setAvatar(value);
                })
                .catch((failure) => setError(profileError(failure)))
                .finally(() => setBusy(false));
            }}
          >
            <ImagePlus size={20} />
          </button>
          {avatar && (
            <button
              type="button"
              className="theme-btn theme-btn-nav"
              disabled={busy}
              onClick={() => setAvatar(null)}
            >
              Remove picture
            </button>
          )}
        </div>
        <div className="workspace-icon-picker" role="group" aria-label="Workspace icon">
          {Object.entries(workspaceIcons).map(([key, Icon]) => (
            <button
              key={key}
              type="button"
              className="theme-btn theme-btn-nav"
              disabled={busy}
              aria-label={`${key} icon`}
              aria-pressed={!avatar && icon === key}
              onClick={() => {
                setIcon(key);
                setAvatar(null);
              }}
            >
              <Icon size={20} />
            </button>
          ))}
        </div>
        {error && (
          <p className="profile-menu-error" role="alert">
            {error}
          </p>
        )}
        <div className="site-interaction-actions">
          <button
            type="button"
            className="theme-btn theme-btn-nav"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="theme-btn theme-btn-nav site-interaction-primary"
            disabled={busy || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
export default function WorkspaceEditor() {
  const { newTab } = useTabs();
  const [request, setRequest] = useState<Request | null>(null);
  const { displayed, closing, animated } = usePromptPresence(request);
  useEffect(() => {
    const open = (event: Event) => {
      if (electron?.isPrivate) return;
      const detail = (event as CustomEvent<Request>).detail;
      if (detail.workspace) {
        if (detail.workspace.id === electron?.workspaceId)
          newTab('mira://WorkspaceSettings#section=workspace');
        else void workspaceAction('workspaces-open-settings', detail.workspace.id);
      } else setRequest(detail);
    };
    window.addEventListener(WORKSPACE_EDITOR_EVENT, open);
    return () => window.removeEventListener(WORKSPACE_EDITOR_EVENT, open);
  }, [newTab]);
  if (!displayed) return null;
  return (
    <div
      className={
        animated
          ? `profile-editor-presence ${closing ? 'prompt-motion-out' : 'prompt-motion-in'}`
          : 'profile-editor-presence'
      }
    >
      <CreateWorkspace
        key={displayed.requestId}
        closing={closing}
        onClose={() => setRequest(null)}
      />
    </div>
  );
}
