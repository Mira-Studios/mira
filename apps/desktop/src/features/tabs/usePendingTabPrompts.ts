import { useEffect, useState } from 'react';
import { electron } from '../../electronBridge';
import type { TabPromptSource } from './tabPromptScope';

/** Runtime only: pending requests must not be lost to automatic tab discard. */
export function usePendingTabPrompts() {
  const [requests, setRequests] = useState<Record<string, TabPromptSource>>({});
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    const receive = (_event: unknown, raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const request = raw as TabPromptSource & { requestId?: string };
      if (!request.requestId) return;
      const id = request.requestId;
      setRequests((current) => ({ ...current, [id]: request }));
    };
    const cancel = (_event: unknown, id: unknown) => {
      if (typeof id !== 'string') return;
      setRequests((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    };
    for (const channel of ['site-permission-request', 'site-interaction-request'])
      ipc.on(channel, receive);
    for (const channel of ['site-permission-cancel', 'site-interaction-cancel'])
      ipc.on(channel, cancel);
    return () => {
      for (const channel of ['site-permission-request', 'site-interaction-request'])
        ipc.off(channel, receive);
      for (const channel of ['site-permission-cancel', 'site-interaction-cancel'])
        ipc.off(channel, cancel);
    };
  }, []);
  return requests;
}
