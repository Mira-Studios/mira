import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { electron } from '../electronBridge';
import appIcon from '../assets/mira_icon.png';
import appWordmark from '../assets/mira.png';
import {
  BROWSER_SETTINGS_CHANGED_EVENT,
  getBrowserSettings,
} from '../features/settings/browserSettings';

export default function TopBar({
  children,
  hideBrandWhenNarrow = false,
  horizontalTabCount = 0,
  horizontalPinnedTabCount = 0,
}: {
  children?: React.ReactNode;
  hideBrandWhenNarrow?: boolean;
  horizontalTabCount?: number;
  horizontalPinnedTabCount?: number;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLDivElement>(null);
  const brandIconRef = useRef<HTMLImageElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tabSizeRef = useRef<HTMLDivElement>(null);
  const [brandWidth, setBrandWidth] = useState(0);
  const [brandIconWidth, setBrandIconWidth] = useState(26);
  const [brandHidden, setBrandHidden] = useState(false);
  const [animationsEnabled, setAnimationsEnabled] = useState(
    () => getBrowserSettings().animationsEnabled,
  );
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isTitleBarOverlayEnabled, setIsTitleBarOverlayEnabled] = useState(true);
  const isMacOS = electron?.isMacOS ?? false;
  const isWindows = electron?.platform === 'win32';

  useLayoutEffect(() => {
    const measure = () => {
      const bar = barRef.current;
      const brand = brandRef.current;
      if (!bar || !brand) return;
      const naturalBrandWidth = brand.getBoundingClientRect().width;
      setBrandWidth(naturalBrandWidth);
      const brandStyle = getComputedStyle(brand);
      setBrandIconWidth(
        (brandIconRef.current?.getBoundingClientRect().width ?? 16) +
          parseFloat(brandStyle.paddingLeft) +
          parseFloat(brandStyle.paddingRight),
      );
      const strip = contentRef.current?.querySelector('.tab-strip-scroll');
      const contentStyle = contentRef.current && getComputedStyle(contentRef.current);
      const padding = contentStyle
        ? parseFloat(contentStyle.paddingLeft) + parseFloat(contentStyle.paddingRight)
        : 16;
      const availableWithBrand =
        bar.clientWidth -
        naturalBrandWidth -
        (controlsRef.current?.getBoundingClientRect().width ?? 0) -
        padding;
      const tabWidth = tabSizeRef.current?.getBoundingClientRect().width ?? 220;
      const gap = strip ? parseFloat(getComputedStyle(strip).columnGap) || 0 : 6;
      const newTabWidth =
        strip?.querySelector('.tab-new-tab-btn')?.getBoundingClientRect().width ?? 33;
      const needed = (horizontalTabCount - horizontalPinnedTabCount) * tabWidth + horizontalPinnedTabCount * 38 + horizontalTabCount * gap + newTabWidth;
      const stripStyle = strip && getComputedStyle(strip);
      const edgePadding = stripStyle ? parseFloat(stripStyle.paddingLeft) + parseFloat(stripStyle.paddingRight) : 0;
      const crowded = horizontalTabCount > 1 && needed + edgePadding > availableWithBrand;
      setBrandHidden(crowded || (hideBrandWhenNarrow && window.innerWidth <= 800));
    };
    const syncSettings = () => {
      setAnimationsEnabled(getBrowserSettings().animationsEnabled);
      measure();
    };
    const observer = new ResizeObserver(measure);
    for (const element of [
      barRef.current,
      brandRef.current,
      controlsRef.current,
      tabSizeRef.current,
    ]) {
      if (element) observer.observe(element);
    }
    measure();
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
    return () => {
      observer.disconnect();
      window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, syncSettings);
    };
  }, [horizontalTabCount, horizontalPinnedTabCount, hideBrandWhenNarrow, isFullscreen, isTitleBarOverlayEnabled]);

  useEffect(() => {
    electron?.ipcRenderer
      .invoke<boolean>('window-is-fullscreen')
      .then((value) => setIsFullscreen(!!value))
      .catch(() => undefined);

    const onFullscreenChanged = (_event: unknown, value: boolean) => {
      setIsFullscreen(!!value);
    };

    electron?.ipcRenderer.on('window-fullscreen-changed', onFullscreenChanged);

    if (isMacOS) {
      return () => {
        electron?.ipcRenderer.off('window-fullscreen-changed', onFullscreenChanged);
      };
    }

    electron?.ipcRenderer
      .invoke<boolean>('window-is-maximized')
      .then((value) => setIsMaximized(!!value))
      .catch(() => undefined);

    const onMaximizedChanged = (_event: unknown, value: boolean) => {
      setIsMaximized(!!value);
    };

    electron?.ipcRenderer.on('window-maximized-changed', onMaximizedChanged);
    return () => {
      electron?.ipcRenderer.off('window-fullscreen-changed', onFullscreenChanged);
      electron?.ipcRenderer.off('window-maximized-changed', onMaximizedChanged);
    };
  }, [isMacOS]);

  useEffect(() => {
    if (!isWindows) {
      setIsTitleBarOverlayEnabled(false);
      return;
    }

    electron?.ipcRenderer
      .invoke<boolean>('window-is-titlebar-overlay-enabled')
      .then((value) => setIsTitleBarOverlayEnabled(!!value))
      .catch(() => undefined);

    const onOverlayChanged = (_event: unknown, value: boolean) => {
      setIsTitleBarOverlayEnabled(!!value);
    };

    electron?.ipcRenderer.on('window-titlebar-overlay-changed', onOverlayChanged);
    return () => {
      electron?.ipcRenderer.off('window-titlebar-overlay-changed', onOverlayChanged);
    };
  }, [isWindows]);

  const onMinimize = () => {
    electron?.ipcRenderer.invoke('window-minimize').catch(() => undefined);
  };

  const onToggleMaximize = () => {
    if (isMacOS) return;
    electron?.ipcRenderer.invoke('window-maximize-toggle').catch(() => undefined);
  };

  const onClose = () => {
    electron?.ipcRenderer.invoke('window-close').catch(() => undefined);
  };

  const brandSection = (
    <div
      className={`topbar-brand${brandHidden ? ' topbar-brand-hidden' : ''}${animationsEnabled ? ' topbar-brand-animated' : ''}`}
      style={
        {
          '--topbar-brand-width': brandWidth ? `${brandWidth}px` : 'auto',
          '--topbar-brand-icon-width': `${brandIconWidth}px`,
        } as CSSProperties
      }
    >
      <div
        ref={brandRef}
        className="topbar-brand-content"
        style={{
          alignItems: 'center',
          gap: 8,
          paddingLeft: isMacOS ? 0 : 10,
          paddingRight: isMacOS ? 10 : 0,
        }}
      >
        <img
          ref={brandIconRef}
          src={appIcon}
          alt="Mira"
          style={{ width: 16, height: 16, flexShrink: 0 }}
        />
        <img
          className="topbar-brand-wordmark"
          src={appWordmark}
          alt=""
          aria-hidden="true"
          style={{ height: 25, width: 'auto', marginLeft: -6, transform: 'translateY(1px)' }}
        />
      </div>
    </div>
  );

  const useNativeWindowsControls = isWindows && isTitleBarOverlayEnabled;
  const controlsSection = isMacOS ? (
    <div
      style={{
        width: isFullscreen ? 0 : 76,
        flexShrink: 0,
        transition: 'width 140ms ease',
      }}
    />
  ) : useNativeWindowsControls ? (
    <div
      style={{
        width: isFullscreen ? 0 : 138,
        flexShrink: 0,
        transition: 'width 140ms ease',
      }}
    />
  ) : (
    <div className="topbar-window-controls">
      <button
        title="Minimize"
        onClick={onMinimize}
        className="theme-btn topbar-window-btn"
        style={{
          width: 44,
          height: 'var(--layoutTopBarHeight, 38px)',
          borderRadius: 0,
          borderTop: 'none',
          borderBottom: 'none',
          borderRight: 'none',
        }}
      >
        <Minus size={14} strokeWidth={2.1} aria-hidden="true" />
      </button>
      <button
        title={isMaximized ? 'Restore' : 'Maximize'}
        onClick={onToggleMaximize}
        className="theme-btn topbar-window-btn"
        style={{
          width: 44,
          height: 'var(--layoutTopBarHeight, 38px)',
          borderRadius: 0,
          borderTop: 'none',
          borderBottom: 'none',
          borderRight: 'none',
        }}
      >
        {isMaximized ? (
          <Copy size={13} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Square size={12} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      <button
        title="Close"
        onClick={onClose}
        className="theme-btn topbar-window-btn topbar-window-btn-close"
        style={{
          width: 48,
          height: 'var(--layoutTopBarHeight, 38px)',
          borderRadius: 0,
          borderTop: 'none',
          borderBottom: 'none',
          borderRight: 'none',
        }}
      >
        <X size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div
      ref={barRef}
      className={`browser-topbar${hideBrandWhenNarrow ? ' topbar-hide-brand-when-narrow' : ''}`}
      onDoubleClick={isMacOS ? undefined : onToggleMaximize}
      style={{
        height: 'var(--layoutTopBarHeight, 38px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--surfaceBg, var(--tabBg))',
        userSelect: 'none',
      }}
    >
      <div
        ref={tabSizeRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          width: 'var(--layoutTabTargetWidth, 220px)',
          height: 0,
        }}
      />
      {isMacOS ? (
        <div ref={controlsRef} className="topbar-controls-slot">
          {controlsSection}
        </div>
      ) : (
        brandSection
      )}

      <div
        ref={contentRef}
        style={{
          flex: 1,
          height: '100%',
          minWidth: 0,
          display: 'flex',
          alignItems: 'stretch',
          padding: '0 8px',
        }}
      >
        <div
          style={{
            height: '100%',
            minWidth: 0,
            display: 'flex',
            maxWidth: '100%',
            flex: 1,
          }}
        >
          {children}
        </div>
      </div>

      {electron?.isPrivate && (
        <span style={{ fontSize: 12, padding: '0 10px', color: 'var(--surfaceText, var(--text1))', flexShrink: 0 }}>Private</span>
      )}
      {isMacOS ? (
        brandSection
      ) : (
        <div ref={controlsRef} className="topbar-controls-slot">
          {controlsSection}
        </div>
      )}
    </div>
  );
}
