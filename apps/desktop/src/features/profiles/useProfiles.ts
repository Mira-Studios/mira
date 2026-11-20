import { useEffect, useState } from 'react';
import { electron } from '../../electronBridge';

export type Profile = { id: string; name: string; avatar?: string; syncSettings?: boolean };
export type ProfileState = { currentId: string; profiles: Profile[]; showPickerOnStartup: boolean };

export function profileAction<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  if (!electron?.ipcRenderer)
    return Promise.reject(new Error('Profiles are available in the desktop app.'));
  return electron.ipcRenderer.invoke<T>(channel, ...args);
}

export function profileError(failure: unknown): string {
  return failure instanceof Error
    ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : 'Could not update this profile.';
}

export function useProfiles() {
  const [state, setState] = useState<ProfileState>(() => ({
    currentId: electron?.profileId ?? 'default',
    showPickerOnStartup: true,
    profiles:
      !electron?.profileId || electron.profileId === 'default'
        ? [{ id: 'default', name: 'Default' }]
        : [],
  }));
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc || electron?.isPrivate) return;
    let disposed = false;
    const refresh = (_event?: unknown, value?: ProfileState) => {
      if (value) {
        if (!disposed) setState(value);
        return;
      }
      void profileAction<ProfileState>('profiles-list')
        .then((data) => {
          if (!disposed && data) setState(data);
        })
        .catch(() => undefined);
    };
    refresh();
    ipc.on('profiles-changed', refresh);
    return () => {
      disposed = true;
      ipc.off('profiles-changed', refresh);
    };
  }, []);
  return state;
}
