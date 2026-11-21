import React, { useState } from 'react';
import QuickNavigate from '../components/QuickNavigate';
import { showQuickNavigateMenu } from '../features/quickNavigate/quickNavigate';
import miraLogo from '../assets/mira_logo.png';
import { getBackgroundStyle, getNewTabBackgroundSource, useBackgroundImage, useNewTabAppearance } from '../features/themes/useNewTabAppearance';
import { useTabs } from '../features/tabs/TabsProvider';
import {
  DEFAULT_BROWSER_SETTINGS,
  getBrowserSettings,
  getSearchUrlFromInput,
} from '../features/settings/browserSettings';
import { markPendingHttpsUpgrade, toHttpsUrlFromHttp } from '../features/security/unsecureSitePolicy';

const NEW_TAB_INTRO_SHOWN_KEY = 'mira.newtab.intro.shown.v1';
const INTRO_BLOCK_HEIGHT = 300;

function isSupportedProtocol(value: string) {
  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*:)/i);
  if (!schemeMatch) return false;
  const scheme = schemeMatch[1].toLowerCase();
  return (
    scheme === 'http:' ||
    scheme === 'https:' ||
    scheme === 'file:' ||
    scheme === 'about:' ||
    scheme === 'mira:' ||
    scheme === 'data:' ||
    scheme === 'view-source:'
  );
}

function isIpv4Host(hostname: string) {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number.parseInt(part, 10);
    return value >= 0 && value <= 255;
  });
}

function isLikelyDomainOrHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  if (isIpv4Host(normalized)) return true;
  if (normalized.includes(':')) return true;
  if (!normalized.includes('.')) return false;

  const labels = normalized.split('.');
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9-]+$/i.test(label) &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
}

function isLikelyDomainOrUrl(value: string) {
  if (/\s/.test(value)) return false;
  if (isSupportedProtocol(value)) return true;

  // Check for host:port format (e.g., localhost:3000) before rejecting as unknown scheme
  const schemeLikeMatch = value.match(/^([a-z][a-z0-9+.-]*):(.*)/i);
  if (schemeLikeMatch) {
    const afterColon = schemeLikeMatch[2];
    // If after colon is just a port number, it's host:port, not a scheme
    const isPort = /^\d+$/.test(afterColon) && Number(afterColon) > 0 && Number(afterColon) <= 65535;
    if (!isPort) return false;
  }

  const candidate = value.startsWith('//') ? `https:${value}` : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return isLikelyDomainOrHost(parsed.hostname);
  } catch {
    return false;
  }
}

export default function NewTab() {
  const appearance = useNewTabAppearance();
  const { image } = useBackgroundImage(getNewTabBackgroundSource(appearance));
  const [query, setQuery] = useState('');
  const [introState] = useState(() => {
    try {
      const settings = getBrowserSettings();
      const showBranding = settings.showNewTabBranding;
      if (settings.disableNewTabIntro) {
        return { showBranding, showIntro: false };
      }
      const alreadyShown = sessionStorage.getItem(NEW_TAB_INTRO_SHOWN_KEY) === '1';
      if (alreadyShown) {
        return { showBranding, showIntro: false };
      }
      sessionStorage.setItem(NEW_TAB_INTRO_SHOWN_KEY, '1');
      return { showBranding, showIntro: true };
    } catch {
      return {
        showBranding: DEFAULT_BROWSER_SETTINGS.showNewTabBranding,
        showIntro: !DEFAULT_BROWSER_SETTINGS.disableNewTabIntro,
      };
    }
  });
  const shouldRenderBranding = introState.showBranding || introState.showIntro;
  const { navigate } = useTabs();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    if (isSupportedProtocol(trimmed)) {
      if (/^http:\/\//i.test(trimmed)) {
        const httpsUrl = toHttpsUrlFromHttp(trimmed);
        if (httpsUrl) {
          markPendingHttpsUpgrade(trimmed, httpsUrl);
          navigate(httpsUrl);
          setQuery('');
          return;
        }
      }
      navigate(trimmed);
    } else if (isLikelyDomainOrUrl(trimmed)) {
      const url = trimmed.startsWith('//') ? `https:${trimmed}` : `https://${trimmed}`;
      navigate(url);
    } else {
      const settings = getBrowserSettings();
      navigate(
        getSearchUrlFromInput(
          trimmed,
          settings.searchEngine,
          settings.searchEngineShortcutsEnabled,
          settings.searchEngineShortcutPrefix,
          settings.searchEngineShortcutChars,
        ),
      );
    }
    setQuery('');
  };

  return (
    <div
      onContextMenu={event => {
        if ((event.target as HTMLElement).closest('input, button, a, [role="menu"], [role="dialog"]')) return;
        event.preventDefault();
        void showQuickNavigateMenu(event.clientX, event.clientY, undefined, appearance.showQuickNavigate);
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflowY: 'auto',
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingTop: '12vh',
        ...getBackgroundStyle(appearance, image),
        color: 'var(--text1)',
      }}
    >
      <div
        style={{
          minHeight: INTRO_BLOCK_HEIGHT,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
        }}
      >
        {shouldRenderBranding ? (
          <>
            <style>{`
              @keyframes miraLogoFadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
              }

              @keyframes miraTypewriter {
                from { clip-path: inset(0 100% 0 0); }
                to { clip-path: inset(0 0 0 0); }
              }

              @keyframes miraCaretBlink {
                0% { border-color: currentColor; }
                10% { border-color: transparent; }
                20% { border-color: currentColor; }
                30% { border-color: transparent; }
                40% { border-color: currentColor; }
                50% { border-color: transparent; }
                60% { border-color: currentColor; }
                70% { border-color: transparent; }
                80% { border-color: currentColor; }
                90% { border-color: transparent; }
                100% { border-color: transparent; }
              }
            `}</style>
            <img
              src={miraLogo}
              alt="Mira logo"
              style={{
                width: 220,
                height: 220,
                objectFit: 'contain',
                opacity: introState.showIntro ? 0 : 1,
                animation: introState.showIntro
                  ? 'miraLogoFadeIn 900ms ease-out forwards'
                  : undefined,
              }}
            />
            <div style={{ width: '100%', textAlign: 'center', marginTop: 20 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 34,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    whiteSpace: 'nowrap',
                    clipPath: introState.showIntro ? 'inset(0 100% 0 0)' : 'inset(0 0 0 0)',
                    borderRight: introState.showIntro ? '2px solid currentColor' : 'none',
                    animation: introState.showIntro
                      ? 'miraTypewriter 1.6s steps(15, end) 400ms forwards, miraCaretBlink 1.8s step-end 400ms forwards'
                      : undefined,
                  }}
                >
                  Welcome to Mira
                </span>
              </h1>
            </div>
          </>
        ) : null}
      </div>
      {appearance.showNewTabSearch && <form
        onSubmit={handleSearch}
        style={{ display: 'flex', width: '60%', maxWidth: 600, minWidth: 320, marginTop: 28 }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search anything..."
          style={{
            flex: 1,
            padding: '10px 15px',
            fontSize: 18,
            borderRadius: 6,
          }}
          className="theme-input"
        />
      </form>}
      {appearance.showQuickNavigate && <QuickNavigate />}

    </div>
  );
}
