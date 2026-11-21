import { useEffect, useMemo, useRef } from 'react';
import { PanelsTopLeft } from 'lucide-react';
import { electron } from '../electronBridge';
import { usePromptPresence } from '../hooks/usePromptPresence';
import { useWorkspaces } from '../features/workspaces/useWorkspaces';
import { saveBrowserSettings } from '../features/settings/browserSettings';
import { useSidebarSettings } from '../features/sidebar/useSidebarSettings';
import WorkspaceList, { WorkspaceIcon } from './WorkspaceList';
export function WorkspaceMenuSetting() {
  const settings = useSidebarSettings();
  if (electron?.isPrivate) return null;
  return (
    <label className="settings-setting-row" htmlFor="show-workspace-menu">
      <span className="settings-setting-label">Show workspace menu in the toolbar</span>
      <input
        id="show-workspace-menu"
        type="checkbox"
        className="settings-toggle settings-setting-control"
        checked={settings.showWorkspaceMenu}
        onChange={(event) => saveBrowserSettings({ showWorkspaceMenu: event.target.checked })}
      />
    </label>
  );
}
export default function WorkspaceMenu({
  open,
  showButton = false,
  embedded = false,
  onOpen,
  onClose,
}: {
  open: boolean;
  showButton?: boolean;
  embedded?: boolean;
  onOpen?: () => void;
  onClose: () => void;
}) {
  const workspaces = useWorkspaces();
  const current = workspaces.find((workspace) => workspace.id === electron?.workspaceId);
  const request = useMemo(() => (open ? { requestId: 'workspace-menu' } : null), [open]);
  const { displayed, closing, animated } = usePromptPresence(request);
  const root = useRef<HTMLDivElement>(null);
  const visible = embedded ? open : !!displayed;
  useEffect(() => {
    if (!visible || closing || embedded) return;
    const previous = document.activeElement;
    root.current?.querySelector<HTMLElement>('[role="dialog"] button')?.focus();
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [
        ...(root.current?.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button:not(:disabled)',
        ) ?? []),
      ];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
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
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [visible, closing, embedded, onClose]);
  return (
    <div ref={root} className={embedded ? 'profile-menu-embedded' : 'profile-menu-anchor'}>
      {showButton && (
        <button
          type="button"
          className={`theme-btn theme-btn-nav nav-icon-btn profile-menu-trigger ${open ? 'address-menu-trigger-open' : ''}`}
          aria-label={`Workspaces${current ? `: ${current.name}` : ''}`}
          title={`Workspaces${current ? `: ${current.name}` : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? onClose() : onOpen?.())}
        >
          <span className="profile-avatar-slot">
            {current ? <WorkspaceIcon workspace={current} /> : <PanelsTopLeft size={22} />}
          </span>
        </button>
      )}
      {visible && (
        <div
          role={embedded ? 'group' : 'dialog'}
          aria-label="Workspaces"
          inert={closing}
          aria-hidden={closing || undefined}
          className={
            embedded
              ? 'profile-menu-inline'
              : `theme-panel address-menu-panel profile-menu-panel ${animated ? (closing ? 'address-menu-panel-closing' : 'address-menu-panel-open') : ''}`
          }
        >
          <WorkspaceList onClose={onClose} />
        </div>
      )}
    </div>
  );
}
