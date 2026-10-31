import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import './Settings.css';
import './Onboarding.css';
import miraLogo from '../assets/mira_logo.png';
import { electron } from '../electronBridge';
import {
  getBrowserSettings,
  saveBrowserSettings,
  type AutoUpdateMode,
  type StartupRestoreBehavior,
} from '../features/settings/browserSettings';
import { applyTheme } from '../features/themes/applyTheme';
import { getAllThemes, getThemeById, type ThemeEntry } from '../features/themes/themeLoader';
import { applyLayout } from '../features/layouts/applyLayout';
import { getAllLayouts, getLayoutById, type LayoutEntry } from '../features/layouts/layoutLoader';

type ThemePreference = 'system' | 'light' | 'dark';
type ThemeMode = 'light' | 'dark';

type RunOnStartupStatusResponse = {
  canConfigure: boolean;
};

type UpdateLaunchAutoSupportResponse = {
  canAutoInstall: boolean;
};

function getSystemThemeMode(): ThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function pickThemeIdForMode(
  mode: ThemeMode,
  themes: ThemeEntry[],
  fallbackThemeId: string,
): string {
  const builtInId = mode === 'dark' ? 'default_dark' : 'default_light';
  if (themes.some((entry) => entry.id === builtInId)) {
    return builtInId;
  }

  const modeMatch = themes.find((entry) => entry.theme.mode === mode);
  if (modeMatch) {
    return modeMatch.id;
  }

  if (themes.some((entry) => entry.id === fallbackThemeId)) {
    return fallbackThemeId;
  }

  return themes[0]?.id ?? fallbackThemeId;
}

function formatLayoutLabel(entry: LayoutEntry): string {
  return `${entry.layout.name} - ${entry.layout.author}`;
}

export default function Onboarding() {
  const initialSettings = getBrowserSettings();
  const allThemes = useMemo(() => getAllThemes(), []);
  const allLayouts = useMemo(() => getAllLayouts(), []);

  const fallbackLayoutId = allLayouts[0]?.id ?? initialSettings.layoutId;
  const [stepIndex, setStepIndex] = useState(0);
  const [systemThemeMode, setSystemThemeMode] = useState<ThemeMode>(() => getSystemThemeMode());
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');
  const [layoutId, setLayoutId] = useState(() => {
    const hasCurrentLayout = allLayouts.some((entry) => entry.id === initialSettings.layoutId);
    return hasCurrentLayout ? initialSettings.layoutId : fallbackLayoutId;
  });
  const [startupRestoreBehavior, setStartupRestoreBehavior] = useState<StartupRestoreBehavior>(
    () => initialSettings.startupRestoreBehavior,
  );
  const [runOnStartup, setRunOnStartup] = useState(() => initialSettings.runOnStartup);
  const [adBlockEnabled, setAdBlockEnabled] = useState(() => initialSettings.adBlockEnabled);
  const [trackerBlockEnabled, setTrackerBlockEnabled] = useState(
    () => initialSettings.trackerBlockEnabled,
  );
  const [autoUpdateMode, setAutoUpdateMode] = useState<AutoUpdateMode>(
    () => initialSettings.autoUpdateOnLaunch,
  );
  const [canConfigureRunOnStartup, setCanConfigureRunOnStartup] = useState(false);
  const [canAutoInstallOnLaunch, setCanAutoInstallOnLaunch] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [finishError, setFinishError] = useState('');

  const resolvedThemeMode: ThemeMode =
    themePreference === 'system' ? systemThemeMode : themePreference;
  const resolvedThemeId = useMemo(
    () => pickThemeIdForMode(resolvedThemeMode, allThemes, initialSettings.themeId),
    [resolvedThemeMode, allThemes, initialSettings.themeId],
  );
  const stepCount = 4;
  const isLastStep = stepIndex === stepCount - 1;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      setSystemThemeMode(mediaQuery.matches ? 'dark' : 'light');
    };

    onChange();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onChange);
      return () => mediaQuery.removeEventListener('change', onChange);
    }

    mediaQuery.addListener(onChange);
    return () => mediaQuery.removeListener(onChange);
  }, []);

  useEffect(() => {
    applyTheme(getThemeById(resolvedThemeId));
  }, [resolvedThemeId]);

  useEffect(() => {
    applyLayout(getLayoutById(layoutId));
  }, [layoutId]);

  useEffect(() => {
    if (!electron?.ipcRenderer) return;

    let isSubscribed = true;
    void electron.ipcRenderer
      .invoke<RunOnStartupStatusResponse>('settings-run-on-startup-status')
      .then((response) => {
        if (!isSubscribed) return;
        setCanConfigureRunOnStartup(response.canConfigure === true);
      })
      .catch(() => {
        if (!isSubscribed) return;
        setCanConfigureRunOnStartup(false);
      });

    void electron.ipcRenderer
      .invoke<UpdateLaunchAutoSupportResponse>('updates-launch-auto-support')
      .then((response) => {
        if (!isSubscribed) return;
        setCanAutoInstallOnLaunch(response.canAutoInstall === true);
      })
      .catch(() => {
        if (!isSubscribed) return;
        setCanAutoInstallOnLaunch(false);
      });

    return () => {
      isSubscribed = false;
    };
  }, []);

  useEffect(() => {
    if (canAutoInstallOnLaunch) return;
    if (autoUpdateMode === 'auto-on-launch' || autoUpdateMode === 'auto-on-close') {
      setAutoUpdateMode('ask-on-launch');
    }
  }, [canAutoInstallOnLaunch, autoUpdateMode]);

  const finishOnboarding = async () => {
    if (isFinishing) return;
    setIsFinishing(true);
    setFinishError('');

    saveBrowserSettings({
      themeId: resolvedThemeId,
      layoutId,
      startupRestoreBehavior,
      runOnStartup: canConfigureRunOnStartup ? runOnStartup : false,
      adBlockEnabled,
      trackerBlockEnabled,
      autoUpdateOnLaunch:
        canAutoInstallOnLaunch || autoUpdateMode === 'off' || autoUpdateMode === 'ask-on-launch'
          ? autoUpdateMode
          : 'ask-on-launch',
    });

    if (!electron?.ipcRenderer) {
      setFinishError('Open Mira on desktop to finish setup.');
      setIsFinishing(false);
      return;
    }

    try {
      const completed = await electron.ipcRenderer.invoke('onboarding-complete');
      if (completed !== true) throw new Error('Setup not completed');
    } catch {
      setFinishError('Could not finish setup. Please try again.');
    } finally {
      setIsFinishing(false);
    }
  };

  const handleNext = () => {
    if (isLastStep) {
      void finishOnboarding();
      return;
    }
    setStepIndex((index) => Math.min(index + 1, stepCount - 1));
  };

  const titleByStep = ['Welcome to Mira', 'Appearance', 'Startup and updates', 'Privacy'];

  return (
    <div className="onboarding-root settings-redesign">
      <header className="onboarding-header">
        <span className="onboarding-brand">
          <img src={miraLogo} alt="" />
          Mira
        </span>
        <span className="onboarding-step-count">
          {stepIndex + 1} of {stepCount}
        </span>
      </header>
      <div className="onboarding-body">
        <main className={`onboarding-main ${stepIndex === 0 ? 'onboarding-main-welcome' : ''}`}>
          <div className="onboarding-scroll" key={stepIndex}>
            {stepIndex === 0 ? (
              <div className="onboarding-welcome">
                <img className="onboarding-welcome-logo" src={miraLogo} alt="" />
                <h1>{titleByStep[stepIndex]}</h1>
              </div>
            ) : (
              <header className="onboarding-section-header">
                <h1>{titleByStep[stepIndex]}</h1>
              </header>
            )}
            {stepIndex === 1 && (
              <section className="onboarding-group">
                <div className="settings-card">
                  <label className="settings-setting-row" htmlFor="onboarding-theme">
                    <span className="settings-setting-meta">
                      <span className="settings-setting-label">Theme preference</span>
                      <span className="settings-setting-description">
                        System follows your OS theme.
                      </span>
                    </span>
                    <select
                      id="onboarding-theme"
                      className="theme-input settings-select-input settings-setting-control"
                      value={themePreference}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (value === 'system' || value === 'light' || value === 'dark') {
                          setThemePreference(value as ThemePreference);
                        }
                      }}
                    >
                      <option value="system">System</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>
                  <label className="settings-setting-row" htmlFor="onboarding-layout">
                    <span className="settings-setting-meta">
                      <span className="settings-setting-label">Layout</span>
                      <span className="settings-setting-description">
                        Pick how your browser controls should look.
                      </span>
                    </span>
                    <select
                      id="onboarding-layout"
                      className="theme-input settings-select-input settings-setting-control"
                      value={layoutId}
                      onChange={(event) => setLayoutId(event.currentTarget.value)}
                    >
                      {allLayouts.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {formatLayoutLabel(entry)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>
            )}

            {stepIndex === 2 && (
              <section className="onboarding-group">
                <div className="settings-card">
                  <label
                    className="settings-setting-row"
                    htmlFor="onboarding-startup-restore-behavior"
                  >
                    <span className="settings-setting-meta">
                      <span className="settings-setting-label">Restore behavior</span>
                      <span className="settings-setting-description">
                        Choose what opens when Mira starts.
                      </span>
                    </span>
                    <select
                      id="onboarding-startup-restore-behavior"
                      className="theme-input settings-select-input settings-setting-control"
                      value={startupRestoreBehavior}
                      onChange={(event) => {
                        const nextMode = event.currentTarget.value;
                        if (
                          nextMode === 'ask' ||
                          nextMode === 'windows' ||
                          nextMode === 'tabs' ||
                          nextMode === 'fresh'
                        ) {
                          setStartupRestoreBehavior(nextMode as StartupRestoreBehavior);
                        }
                      }}
                    >
                      <option value="ask">Always ask</option>
                      <option value="windows">Restore all windows</option>
                      <option value="tabs">Restore tabs</option>
                      <option value="fresh">Start fresh</option>
                    </select>
                  </label>

                  <label className="settings-setting-row" htmlFor="onboarding-run-on-startup">
                    <span className="settings-setting-meta">
                      <span className="settings-setting-label">Run on startup</span>
                      <span className="settings-setting-description">
                        {canConfigureRunOnStartup
                          ? 'Launch Mira when you sign in.'
                          : 'Unavailable in this build.'}
                      </span>
                    </span>
                    <input
                      id="onboarding-run-on-startup"
                      type="checkbox"
                      className="settings-toggle settings-setting-control"
                      checked={runOnStartup}
                      disabled={!canConfigureRunOnStartup}
                      onChange={(event) => setRunOnStartup(event.currentTarget.checked)}
                    />
                  </label>

                  <label className="settings-setting-row" htmlFor="onboarding-auto-update-mode">
                    <span className="settings-setting-meta">
                      <span className="settings-setting-label">Automatic updates</span>
                      <span className="settings-setting-description">Keep Mira up to date.</span>
                    </span>
                    <select
                      id="onboarding-auto-update-mode"
                      value={autoUpdateMode}
                      className="theme-input settings-select-input settings-select-limit settings-setting-control"
                      onChange={(event) => {
                        const nextMode = event.currentTarget.value as AutoUpdateMode;
                        if (
                          nextMode === 'off' ||
                          nextMode === 'ask-on-launch' ||
                          nextMode === 'ask-on-close' ||
                          nextMode === 'auto-on-launch' ||
                          nextMode === 'auto-on-close'
                        ) {
                          setAutoUpdateMode(nextMode);
                        }
                      }}
                    >
                      <option value="off">Off</option>
                      <option value="ask-on-launch">Ask when Mira starts</option>
                      <option value="ask-on-close">Ask when Mira closes</option>
                      <option value="auto-on-launch" disabled={!canAutoInstallOnLaunch}>
                        Auto update on launch
                      </option>
                      <option value="auto-on-close" disabled={!canAutoInstallOnLaunch}>
                        Auto update on close
                      </option>
                    </select>
                  </label>
                </div>
              </section>
            )}

            {stepIndex === 3 && (
              <section className="onboarding-group">
                <div className="settings-card">
                  <label className="settings-setting-row" htmlFor="onboarding-ad-blocking">
                    <span className="settings-setting-meta">
                      <span className="settings-setting-label">Enable ad blocking</span>
                      <span className="settings-setting-description">
                        Block known ad and marketing hosts while browsing.
                      </span>
                    </span>
                    <input
                      id="onboarding-ad-blocking"
                      type="checkbox"
                      className="settings-toggle settings-setting-control"
                      checked={adBlockEnabled}
                      onChange={(event) => setAdBlockEnabled(event.currentTarget.checked)}
                    />
                  </label>

                  <label className="settings-setting-row" htmlFor="onboarding-tracker-blocking">
                    <span className="settings-setting-meta">
                      <span className="settings-setting-label">Enable tracker blocking</span>
                      <span className="settings-setting-description">
                        Blocks many analytics trackers, but may also block resources some sites
                        need.
                      </span>
                    </span>
                    <input
                      id="onboarding-tracker-blocking"
                      type="checkbox"
                      className="settings-toggle settings-setting-control"
                      checked={trackerBlockEnabled}
                      onChange={(event) => setTrackerBlockEnabled(event.currentTarget.checked)}
                    />
                  </label>
                </div>
              </section>
            )}
          </div>
          <footer className="onboarding-footer">
            {finishError && (
              <p className="onboarding-error" role="alert">
                {finishError}
              </p>
            )}
            <div className="onboarding-footer-actions">
              <button
                type="button"
                className="onboarding-button onboarding-button-secondary"
                onClick={() =>
                  stepIndex > 0 ? setStepIndex((index) => index - 1) : void finishOnboarding()
                }
                disabled={isFinishing}
              >
                {stepIndex > 0 && <ArrowLeft size={15} aria-hidden="true" />}
                <span>{stepIndex > 0 ? 'Back' : 'Skip setup'}</span>
              </button>
              <button
                type="button"
                className="onboarding-button onboarding-button-primary"
                onClick={handleNext}
                disabled={isFinishing}
              >
                <span>
                  {isFinishing
                    ? 'Starting...'
                    : isLastStep
                      ? 'Start browsing'
                      : stepIndex === 0
                        ? 'Get started'
                        : 'Continue'}
                </span>
                {!isFinishing && <ArrowRight size={15} aria-hidden="true" />}
              </button>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
