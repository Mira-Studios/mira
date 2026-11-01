import { useEffect, useState } from 'react';

type Props = { url: string; src?: string; size: number; deferred?: boolean };

/** Only replace a working tab icon after its replacement has actually loaded. */
export default function TabFavicon({ url, src, size, deferred = false }: Props) {
  let origin = url;
  let fallback: string | undefined;
  try {
    const parsed = new URL(url);
    origin = parsed.origin === 'null' ? url : parsed.origin;
    if (!deferred && /^https?:$/.test(parsed.protocol)) fallback = new URL('/favicon.ico', parsed).href;
  } catch { /* Internal pages use their supplied icon. */ }
  const [loaded, setLoaded] = useState<{ origin: string; src: string }>();

  useEffect(() => {
    let cancelled = false;
    let image: HTMLImageElement | undefined;
    const candidates = [...new Set([src, fallback].filter((value): value is string => !!value))];
    const tryNext = () => {
      const candidate = candidates.shift();
      if (cancelled || !candidate) return;
      const pendingImage = new Image();
      image = pendingImage;
      pendingImage.onload = () => {
        if (!cancelled && pendingImage.naturalWidth > 0) setLoaded({ origin, src: candidate });
      };
      pendingImage.onerror = tryNext;
      pendingImage.src = candidate;
    };
    tryNext();
    return () => {
      cancelled = true;
      if (image) { image.onload = null; image.onerror = null; }
    };
  }, [src, fallback, origin]);

  const displaySrc = loaded?.origin === origin ? loaded.src : undefined;
  const style = { width: size, height: size, borderRadius: 3, flexShrink: 0, pointerEvents: 'none' as const };
  return displaySrc ? (
    <img src={displaySrc} alt="" draggable={false} style={style} />
  ) : (
    <span aria-hidden={true} style={{ ...style, display: 'inline-block', background: 'var(--tabPlaceholderBg, var(--surfaceBorder, var(--tabBorder)))' }} />
  );
}
