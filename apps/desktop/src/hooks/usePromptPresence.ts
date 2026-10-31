import { useEffect, useState } from 'react';
import {
  BROWSER_SETTINGS_CHANGED_EVENT,
  getBrowserSettings,
} from '../features/settings/browserSettings';
import './promptMotion.css';

const EXIT_DURATION_MS = 160;

export function usePromptPresence<T extends { requestId: string }>(request: T | null) {
  const [displayed, setDisplayed] = useState(request);
  const [animationsEnabled, setAnimationsEnabled] = useState(
    () => getBrowserSettings().animationsEnabled,
  );
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const animated = animationsEnabled && !reducedMotion;
  const closing = animated && !!displayed && displayed.requestId !== request?.requestId;

  useEffect(() => {
    const syncSettings = () => setAnimationsEnabled(getBrowserSettings().animationsEnabled);
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => setReducedMotion(media.matches);
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
    media.addEventListener('change', syncMotion);
    return () => {
      window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
      media.removeEventListener('change', syncMotion);
    };
  }, []);

  useEffect(() => {
    if (!closing) {
      setDisplayed(request);
      return;
    }
    // Keep the old content through the exit, including when the next request is queued.
    const timer = window.setTimeout(() => setDisplayed(request), EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [request, closing]);

  return { displayed: animated ? displayed : request, closing, animated };
}
