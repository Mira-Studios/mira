import { useCallback, useEffect, useRef, useState } from 'react';
import { electron } from '../electronBridge';
import { X } from 'lucide-react';
import './SiteInteractionPrompts.css';
import { usePromptPresence } from '../hooks/usePromptPresence';
import { promptMatchesTab, type TabPromptScope } from '../features/tabs/tabPromptScope';

type Request = {
  requestId: string;
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'passkey';
  site: string;
  message: string;
  defaultValue: string;
  intent: 'get' | 'create';
  app?: boolean;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  secondaryLabel?: string;
  tabId?: string;
  webContentsId?: number;
};

function Interaction({
  request,
  closing,
  animated,
  value,
  onValueChange,
  canRestoreFocus,
}: {
  request: Request;
  closing: boolean;
  animated: boolean;
  value: string;
  onValueChange: (value: string) => void;
  canRestoreFocus: (request: Request) => boolean;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const passkey = request.kind === 'passkey';
  const leave = request.kind === 'beforeunload';
  const alert = request.kind === 'alert';
  const title = request.app
    ? (request.title ?? 'Mira')
    : leave
      ? 'Leave site?'
      : passkey
        ? request.intent === 'create'
          ? 'Create a passkey?'
          : 'Use a passkey?'
        : request.site;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = panel.current;
    if (!passkey) (input.current ?? cancelButton.current)?.focus();
    return () => {
      if (
        canRestoreFocus(request) &&
        previous?.isConnected &&
        element?.contains(document.activeElement)
      )
        previous.focus();
    };
  }, [passkey, request, canRestoreFocus]);
  const respond = (accepted: boolean, choice = value) => {
    if (closing) return;
    void electron?.ipcRenderer
      .invoke('site-interaction-respond', {
        requestId: request.requestId,
        accepted,
        value: choice,
      })
      .catch(() => undefined);
  };
  return (
    <div
      className={`${passkey ? 'site-interaction-anchor' : 'site-interaction-backdrop'} ${animated ? (closing ? 'prompt-motion-out' : 'prompt-motion-in') : ''}`}
      inert={closing}
      aria-hidden={closing || undefined}
    >
      <section
        ref={panel}
        className="site-interaction theme-panel prompt-motion-panel"
        role={passkey ? 'region' : 'dialog'}
        aria-modal={passkey ? undefined : true}
        aria-labelledby={`interaction-title-${request.requestId}`}
        aria-describedby={
          !passkey && (leave || request.message)
            ? `interaction-message-${request.requestId}`
            : undefined
        }
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            respond(false);
          }
          if (!passkey && event.key === 'Tab') {
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>('button, input'),
            );
            const index = controls.indexOf(document.activeElement as HTMLElement);
            event.preventDefault();
            controls[
              (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
            ]?.focus();
          }
        }}
      >
        <div className="site-interaction-heading">
          <div className="site-interaction-titles">
            {(leave || passkey) && <span className="site-interaction-site">{request.site}</span>}
            <strong id={`interaction-title-${request.requestId}`}>{title}</strong>
          </div>
          <button
            className="site-interaction-close"
            aria-label="Close"
            onClick={() => respond(false)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {!passkey && (leave || request.message) && (
          <p id={`interaction-message-${request.requestId}`}>
            {leave ? 'Changes may not be saved.' : request.message}
          </p>
        )}
        {request.kind === 'prompt' && (
          <input
            ref={input}
            className="theme-input"
            aria-label="Response"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') respond(true);
            }}
          />
        )}
        <div className="site-interaction-actions">
          {request.secondaryLabel && (
            <button className="theme-btn theme-btn-nav" onClick={() => respond(false, 'secondary')}>
              {request.secondaryLabel}
            </button>
          )}
          {!alert && (
            <button
              ref={cancelButton}
              className="theme-btn theme-btn-nav"
              onClick={() => respond(false)}
            >
              {request.cancelLabel ?? (leave ? 'Stay' : passkey ? 'Not now' : 'Cancel')}
            </button>
          )}
          <button
            ref={alert ? cancelButton : undefined}
            className="theme-btn theme-btn-nav site-interaction-primary"
            onClick={() => respond(true)}
          >
            {request.confirmLabel ??
              (leave
                ? 'Leave'
                : passkey
                  ? request.intent === 'create'
                    ? 'Create passkey'
                    : 'Use passkey'
                  : 'OK')}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function SiteInteractionPrompts({ scope }: { scope?: TabPromptScope } = {}) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const canRestoreFocus = useCallback(
    (request: Request) => promptMatchesTab(request, scopeRef.current),
    [],
  );
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    const receive = (_event: unknown, raw: unknown) => {
      const request = raw as Request;
      if (!request?.requestId) return;
      setRequests((current) => [
        ...current.filter((item) => item.requestId !== request.requestId),
        request,
      ]);
    };
    const cancel = (_event: unknown, id: unknown) => {
      setRequests((current) => current.filter((item) => item.requestId !== id));
    };
    ipc.on('site-interaction-request', receive);
    ipc.on('site-interaction-cancel', cancel);
    void ipc.invoke('site-interactions-ready').catch(() => undefined);
    return () => {
      ipc.off('site-interaction-request', receive);
      ipc.off('site-interaction-cancel', cancel);
    };
  }, []);
  const visibleRequests = requests.filter((request) => promptMatchesTab(request, scope));
  const request = visibleRequests.find((item) => item.kind !== 'passkey') ?? visibleRequests[0];
  const { displayed, closing, animated } = usePromptPresence(request ?? null, scope?.tabId);
  useEffect(() => {
    setDrafts((current) => {
      const stale = Object.keys(current).filter(
        (id) =>
          id !== displayed?.requestId && !requests.some((request) => request.requestId === id),
      );
      if (!stale.length) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [requests, displayed]);
  return displayed ? (
    <div className={scope ? 'tab-interaction-layer' : undefined}>
      <Interaction
        key={displayed.requestId}
        request={displayed}
        closing={closing}
        animated={animated}
        value={drafts[displayed.requestId] ?? displayed.defaultValue}
        onValueChange={(value) =>
          setDrafts((current) => ({ ...current, [displayed.requestId]: value }))
        }
        canRestoreFocus={canRestoreFocus}
      />
    </div>
  ) : null;
}
