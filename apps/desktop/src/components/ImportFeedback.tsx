import { useEffect, useEffectEvent, useState } from 'react';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';

const LIFETIME_MS = 5200;

export default function ImportFeedback({ message, error = false, onDismiss }: { message: string; error?: boolean; onDismiss: () => void }) {
  const [visible, setVisible] = useState(true);
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    const timer = window.setTimeout(() => { setVisible(false); dismiss(); }, LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, []);
  if (!visible) return null;
  const Icon = error ? CircleAlert : CheckCircle2;
  return <div className="import-feedback" data-kind={error ? 'error' : 'success'} role={error ? 'alert' : 'status'}>
    <Icon size={18} aria-hidden="true" />
    <div><strong>{error ? 'Import needs attention' : 'Import complete'}</strong><p>{message}</p></div>
    <button type="button" className="getting-started-icon" aria-label="Dismiss import message" onClick={() => { setVisible(false); onDismiss(); }}><X size={15} /></button>
  </div>;
}
