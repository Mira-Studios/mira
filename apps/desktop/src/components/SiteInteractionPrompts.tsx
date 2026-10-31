import { useEffect, useRef, useState } from 'react';
import { KeyRound, MessageSquare, TriangleAlert, X } from 'lucide-react';
import './SiteInteractionPrompts.css';

type Request = {
  requestId: string;
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'passkey';
  site: string;
  message: string;
  defaultValue: string;
  intent: 'get' | 'create';
};

function Interaction({ request }: { request: Request }) {
  const [value, setValue] = useState(request.defaultValue);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const passkey = request.kind === 'passkey';
  const leave = request.kind === 'beforeunload';
  const alert = request.kind === 'alert';
  const Icon = passkey ? KeyRound : leave ? TriangleAlert : MessageSquare;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = panel.current;
    if (!passkey) (input.current ?? cancelButton.current)?.focus();
    return () => {
      if (previous?.isConnected && (!passkey || element?.contains(document.activeElement))) previous.focus();
    };
  }, [passkey]);
  const respond = (accepted: boolean) => {
    void window.electron?.ipcRenderer.invoke('site-interaction-respond', {
      requestId: request.requestId, accepted, value,
    }).catch(() => undefined);
  };
  return (
    <div className={passkey ? 'site-interaction-anchor' : 'site-interaction-backdrop'}>
      <section ref={panel} className="site-interaction theme-panel"
        role={passkey ? 'region' : 'dialog'} aria-modal={passkey ? undefined : true}
        aria-label={passkey ? 'Passkey request' : leave ? 'Leave site?' : `${request.site} says`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); respond(false); }
          if (!passkey && event.key === 'Tab') {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input'));
            const index = controls.indexOf(document.activeElement as HTMLElement);
            event.preventDefault();
            controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
          }
        }}>
        <div className="site-interaction-heading">
          <span className="site-interaction-icon"><Icon size={20} strokeWidth={1.8} aria-hidden="true" /></span>
          <div className="site-interaction-titles">
            {(leave || passkey) && <span className="site-interaction-site">{request.site}</span>}
            <strong>{leave ? 'Leave site?' : passkey ? (request.intent === 'create' ? 'Create a passkey?' : 'Use a passkey?') : request.site}</strong>
          </div>
          <button className="site-interaction-close" aria-label="Close" onClick={() => respond(false)}><X size={16} aria-hidden="true" /></button>
        </div>
        {!passkey && <p className="theme-text2">{leave ? 'Changes may not be saved.' : request.message}</p>}
        {request.kind === 'prompt' && (
          <input ref={input} className="theme-input" aria-label="Response" value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') respond(true); }} />
        )}
        <div className="site-interaction-actions">
          {!alert && <button ref={cancelButton} className="theme-btn theme-btn-nav" onClick={() => respond(false)}>{leave ? 'Stay' : passkey ? 'Not now' : 'Cancel'}</button>}
          <button ref={alert ? cancelButton : undefined} className="theme-btn theme-btn-go" onClick={() => respond(true)}>{leave ? 'Leave' : passkey ? (request.intent === 'create' ? 'Create passkey' : 'Use passkey') : 'OK'}</button>
        </div>
      </section>
    </div>
  );
}

export default function SiteInteractionPrompts() {
  const [requests, setRequests] = useState<Request[]>([]);
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;
    const receive = (_event: unknown, raw: unknown) => {
      const request = raw as Request;
      if (!request?.requestId) return;
      setRequests((current) => [...current.filter((item) => item.requestId !== request.requestId), request]);
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
  const request = requests.find((item) => item.kind !== 'passkey') ?? requests[0];
  return request ? <Interaction key={request.requestId} request={request} /> : null;
}
