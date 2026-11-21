import { useEffect, useState } from 'react';
import { electron } from '../../electronBridge';
import type { Workspace } from '../../../electron/workspacePolicy';
export type { Workspace };
export const WORKSPACE_EDITOR_EVENT = 'mira:workspace-editor';
export function openWorkspaceEditor(workspace?: Workspace) {
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_EDITOR_EVENT, {
      detail: { requestId: crypto.randomUUID(), workspace },
    }),
  );
}
export function workspaceAction<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  if (!electron || electron.isPrivate)
    return Promise.reject(new Error('Workspaces are unavailable in this window.'));
  return electron.ipcRenderer.invoke<T>(channel, ...args);
}
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  useEffect(() => {
    if (!electron || electron.isPrivate) return;
    let disposed = false;
    const refresh = () => {
      void workspaceAction<Workspace[]>('workspaces-list')
        .then((items) => {
          if (!disposed) setWorkspaces(items);
        })
        .catch(() => undefined);
    };
    refresh();
    electron.ipcRenderer.on('workspaces-changed', refresh);
    return () => {
      disposed = true;
      electron?.ipcRenderer.off('workspaces-changed', refresh);
    };
  }, []);
  return workspaces;
}
