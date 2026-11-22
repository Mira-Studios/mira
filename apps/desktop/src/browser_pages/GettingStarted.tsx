import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, FolderOpen, Globe2, RefreshCw, UserRound, UsersRound } from 'lucide-react';
import { electron } from '../electronBridge';
import { useBookmarks } from '../features/bookmarks/BookmarksProvider';
import { useTabs } from '../features/tabs/TabsProvider';
import type { BatchImportResult, DetectedBrowser, ImportProfile } from '../../electron/browserImportPolicy';
import { GETTING_STARTED_STEPS, guideFinished, type GettingStartedState, type GettingStartedStep } from '../../electron/gettingStartedPolicy';
import edgeIcon from '../assets/browsers/edge.svg';
import chromeIcon from '../assets/browsers/chrome.png';
import cometIcon from '../assets/browsers/comet.png';
import operaIcon from '../assets/browsers/opera.png';
import operaGxIcon from '../assets/browsers/opera-gx.png';
import braveIcon from '../assets/browsers/brave.png';
import firefoxIcon from '../assets/browsers/firefox.png';
import miraIcon from '../assets/mira_logo.png';
import GettingStartedLayout, { availableLayoutPages, loadLayoutPage, persistLayoutPage, LAYOUT_PAGES, LAYOUT_PAGE_TITLES, type LayoutPage } from '../components/GettingStartedLayout';
import { useSidebarSettings } from '../features/sidebar/useSidebarSettings';
import ImportFeedback from '../components/ImportFeedback';
import './Settings.css';
import './Onboarding.css';
import './GettingStarted.css';

const ipc = electron?.ipcRenderer;
const browserIcons: Record<string, string> = { edge: edgeIcon, chrome: chromeIcon, comet: cometIcon, opera: operaIcon, 'opera-gx': operaGxIcon, brave: braveIcon, firefox: firefoxIcon };
const errorMessage = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Something went wrong. Try again.';
  return message.includes('Unknown setup step') ? 'Restart Mira to finish setup. Your layout choices are saved.' : message;
};

export default function GettingStarted({ importOnly = false }: { importOnly?: boolean } = {}) {
  const { navigate } = useTabs();
  const { importBookmarkGroups } = useBookmarks();
  const [progress, setProgress] = useState<GettingStartedState | null>(() => importOnly ? { version: 1, completed: [], dismissed: false } : null);
  const [viewedStep, setViewedStep] = useState<GettingStartedStep | null>(null);
  const [storedLayoutPage, setStoredLayoutPage] = useState(loadLayoutPage);
  const settings = useSidebarSettings();
  const layoutPages = availableLayoutPages(settings);
  const layoutPage = layoutPages.includes(storedLayoutPage) ? storedLayoutPage : 'tabs';
  const layoutIndex = layoutPages.indexOf(layoutPage);
  const showLayoutPage = (page: LayoutPage) => { persistLayoutPage(page); setStoredLayoutPage(page); };
  const [browsers, setBrowsers] = useState<DetectedBrowser[]>([]);
  const [custom, setCustom] = useState<ImportProfile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'merge' | 'profiles'>('merge');
  const [bookmarks, setBookmarks] = useState(true);
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const step = importOnly ? 'import' : viewedStep || GETTING_STARTED_STEPS.find(item => !progress?.completed.includes(item)) || 'default-browser';
  const stepIndex = GETTING_STARTED_STEPS.indexOf(step);
  // Use stable milestones so revealing conditional layout pages cannot pull the bar back.
  const milestoneCount = LAYOUT_PAGES.length + 2;
  const milestone = step === 'import' ? .5 : step === 'layout' ? LAYOUT_PAGES.indexOf(layoutPage) + 1.5 : milestoneCount - .5;
  const fraction = milestone / milestoneCount;
  // A restrained ease-out gives early progress a little more visual weight (at most 5 points).
  const progressPercent = progress && guideFinished(progress) ? 100 : Math.min(97, Math.round((fraction + .05 * Math.sin(Math.PI * fraction)) * 100));
  const importCompleted = progress?.completed.includes('import') === true;
  const scrollArea = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (scrollArea.current) scrollArea.current.scrollTop = 0; }, [step, layoutPage]);
  const restricted = electron?.isPrivate || electron?.workspaceId;
  const groups = [...browsers.filter(browser => browser.profiles.length > 0), ...(custom.length ? [{ id: 'custom', name: 'Selected folders', profiles: custom }] : [])];
  const allProfiles = groups.flatMap(group => group.profiles);
  const selection = allProfiles.filter(profile => selected.includes(profile.id));
  const canImport = selection.length > 0 && selection.every(profile => (bookmarks && profile.bookmarks) || (history && profile.history));
  const validationMessage = selection.length > 0 && !canImport ? 'Choose data available in all selected profiles, or deselect profiles without that data.' : '';
  const importMessage = error || notice || validationMessage;

  const detect = async () => {
    setDetecting(true); setError('');
    try {
      const found = await ipc?.invoke<DetectedBrowser[]>('browser-import-detect') || [];
      setBrowsers(found);
      const ids = new Set([...found.flatMap(browser => browser.profiles), ...custom].map(profile => profile.id));
      setSelected(previous => previous.filter(id => ids.has(id)));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setDetecting(false); }
  };
  useEffect(() => {
    if (restricted) return;
    if (!importOnly) void ipc?.invoke<GettingStartedState>('getting-started-state').then(setProgress).catch(cause => setError(errorMessage(cause)));
    void detect();
    // Refresh is explicit; imports retain the user's selection while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = async (complete?: GettingStartedStep, dismiss = false) => {
    if (importOnly) { setSelected([]); return; }
    if (complete === 'layout' && layoutIndex < layoutPages.length - 1) {
      setNotice('');
      showLayoutPage(layoutPages[layoutIndex + 1]);
      return;
    }
    setNotice('');
    const next = await ipc?.invoke<GettingStartedState>('getting-started-update', { step: complete, dismiss });
    if (!next) throw new Error('Setup is unavailable.');
    setProgress(next);
    if (dismiss || (complete === 'default-browser' && guideFinished(next))) navigate('mira://NewTab');
    else if (complete) setViewedStep(GETTING_STARTED_STEPS[Math.min(GETTING_STARTED_STEPS.indexOf(complete) + 1, GETTING_STARTED_STEPS.length - 1)]);
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (cause) { setNotice(''); setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const toggle = (ids: string[]) => setSelected(previous => {
    const remove = ids.every(id => previous.includes(id));
    return remove ? previous.filter(id => !ids.includes(id)) : [...new Set([...previous, ...ids])];
  });
  const importData = () => run(async () => {
    const result = await ipc?.invoke<BatchImportResult>('browser-import-batch', { ids: selection.map(profile => profile.id), mode, bookmarks, history });
    if (!result) throw new Error('Import is unavailable.');
    if (mode === 'merge') {
      const count = importBookmarkGroups(result.groups);
      setNotice(count || result.historyCount ? `Imported ${count} ${count === 1 ? 'bookmark' : 'bookmarks'} and ${result.historyCount} ${result.historyCount === 1 ? 'history entry' : 'history entries'} into this profile.` : 'No new bookmarks or history entries were added.');
    } else {
      const summary = result.profiles.length ? `Created ${result.profiles.length === 1 ? 'Mira profile' : 'Mira profiles'}: ${result.profiles.map(profile => profile.name).join(', ')}.` : '';
      if (result.failures.length) {
        setSelected(result.failures.map(failure => failure.sourceId));
        throw new Error([summary, ...result.failures.map(failure => failure.message)].filter(Boolean).join('\n'));
      }
      setNotice(summary);
    }
    if (!importOnly) {
      const next = await ipc?.invoke<GettingStartedState>('getting-started-update', { step: 'import' });
      if (!next) throw new Error('Setup is unavailable.');
      setProgress(next);
      setViewedStep('import');
    }
    setSelected([]);
  });
  if (restricted) return <div className="getting-started-unavailable">Open setup in a regular profile window.</div>;
  return <div className={`onboarding-root getting-started${importOnly ? ' browser-import-page' : ''}`}>
    <main className="onboarding-main"><div className="onboarding-scroll" ref={scrollArea}>
      <div className="onboarding-section-header">
        {!importOnly && <div className="getting-started-progress-heading"><span className="getting-started-step">Getting started</span><div className="getting-started-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><span style={{ transform: `scaleX(${progressPercent / 100})` }} /></div></div>}
        <h1>{importOnly ? 'Import browser data' : step === 'import' ? 'Bring your browser data' : step === 'layout' ? LAYOUT_PAGE_TITLES[layoutPage] : 'Make Mira your default'}</h1>
        {step === 'import' && <p className="getting-started-description">Choose the browser profiles you want to import.</p>}
      </div>
      {step !== 'import' && error && <p role="alert" className="getting-started-message">{error}</p>}
      {step !== 'import' && notice && <p role="status" className="getting-started-message">{notice}</p>}
      {!progress ? <p role="status">{error ? 'Setup could not load.' : 'Loading setup…'}</p> : step === 'import' ? <>
        <div className="getting-started-section-heading"><h2>Browser profiles{selection.length > 0 && <span>{selection.length} selected</span>}</h2>
          <div>{allProfiles.length > 1 && <button className="getting-started-text-button" disabled={busy || detecting} onClick={() => toggle(allProfiles.map(profile => profile.id))}>{selected.length === allProfiles.length ? 'Deselect all' : 'Select all'}</button>}
          <button className="getting-started-icon" aria-label="Refresh browsers" disabled={busy || detecting} onClick={() => void detect()}><RefreshCw size={16} /></button></div>
        </div>
        {detecting ? <p role="status">Looking for browsers…</p> : <div className="getting-started-browsers">
          {!groups.length && <div className="getting-started-empty"><Globe2 size={24} /><span>No browser profiles found</span><small>Choose a profile folder to import from a custom location.</small></div>}
          {groups.map(group => {
            const checked = group.profiles.every(profile => selected.includes(profile.id));
            const mixed = !checked && group.profiles.some(profile => selected.includes(profile.id));
            return <section key={group.id} className="getting-started-browser" data-browser={group.id}>
              <div className="getting-started-browser-heading">
                <label><input type="checkbox" checked={checked} ref={node => { if (node) node.indeterminate = mixed; }} disabled={busy} onChange={() => toggle(group.profiles.map(profile => profile.id))} aria-label={`Select all ${group.name} profiles`} />{browserIcons[group.id] ? <img className="getting-started-browser-icon" src={browserIcons[group.id]} alt="" /> : <FolderOpen size={24} />}<strong>{group.name}</strong></label>
                <span className="getting-started-profile-count">{group.profiles.length} {group.profiles.length === 1 ? 'profile' : 'profiles'}</span>
              </div>
              <div className="getting-started-profile-list">{group.profiles.map(profile => <label className="getting-started-profile" key={profile.id} data-selected={selected.includes(profile.id)}>
                <input type="checkbox" checked={selected.includes(profile.id)} disabled={busy} onChange={() => toggle([profile.id])} aria-label={`Import ${group.name} ${profile.name}`} />
                <span className="getting-started-avatar">{profile.avatar ? <img src={profile.avatar} alt="" /> : <UserRound size={17} />}</span><span className="getting-started-profile-meta"><strong>{profile.name}</strong><small>{mode === 'profiles' && selected.includes(profile.id) ? `New Mira profile: ${group.id === 'custom' ? 'Selected browser' : group.name} · ${profile.name}` : [profile.bookmarks && 'Bookmarks', profile.history && 'History'].filter(Boolean).join(' · ')}</small></span>
              </label>)}</div>
            </section>;
          })}
        </div>}
        <button className="getting-started-text-button getting-started-folder" disabled={busy || detecting} onClick={() => void run(async () => {
          const profile = await ipc?.invoke<ImportProfile | null>('browser-import-choose-profile');
          if (profile) {
            if (!allProfiles.some(item => item.id === profile.id)) setCustom(previous => [...previous.filter(item => item.id !== profile.id), profile]);
            setSelected(previous => [...new Set([...previous, profile.id])]);
          }
        })}><FolderOpen size={16} />Choose profile folder</button>
      </> : step === 'layout' ? <GettingStartedLayout page={layoutPage} /> : <div className="getting-started-default"><img className="getting-started-browser-icon" src={miraIcon} alt="" /><div><strong>Open links in Mira</strong><p>Make Mira your default browser for links from other apps.</p></div><button className="onboarding-button onboarding-button-secondary" disabled={busy} onClick={() => void run(async () => {
        const status = await ipc?.invoke<{ isDefault?: boolean; message?: string }>('default-browser-set');
        setNotice(status?.isDefault ? 'Mira is your default browser.' : status?.message || 'Choose Mira in your system’s default browser settings.');
      })}>Make default</button></div>}
    </div></main>
    {step === 'import' && <section className="getting-started-import-options" aria-label="Import options">
      <div className="import-feedback-slot">{importMessage && <ImportFeedback key={JSON.stringify([importMessage, !!error, validationMessage ? [selected, bookmarks, history] : null])} message={importMessage} error={!!error || !!validationMessage} onDismiss={() => { setError(''); setNotice(''); }} />}</div>
      <div className="getting-started-section-heading"><h2>Import into</h2></div>
      <div className="getting-started-destinations" role="radiogroup" aria-label="Import destination">
        <label className="getting-started-destination" data-selected={mode === 'merge'}><img className="getting-started-browser-icon" src={miraIcon} alt="" /><span><strong>This Mira profile</strong><small>Merge data and skip duplicate bookmarks.</small></span><input type="radio" name="import-mode" value="merge" checked={mode === 'merge'} disabled={busy} onChange={() => setMode('merge')} /></label>
        <label className="getting-started-destination" data-selected={mode === 'profiles'}><UsersRound size={24} /><span><strong>Separate Mira profiles</strong><small>Create one for each selected browser profile.</small></span><input type="radio" name="import-mode" value="profiles" checked={mode === 'profiles'} disabled={busy} onChange={() => setMode('profiles')} /></label>
      </div>
      <div className="getting-started-data" role="group" aria-label="Data to import"><span>Include</span><label><input type="checkbox" checked={bookmarks} disabled={busy} onChange={event => setBookmarks(event.target.checked)} />Bookmarks</label><label><input type="checkbox" checked={history} disabled={busy} onChange={event => setHistory(event.target.checked)} />Browsing history</label></div>
    </section>}
    <footer className="getting-started-footer">
      {importOnly ? <button className="onboarding-button onboarding-button-secondary" disabled={busy} onClick={() => navigate('mira://Settings?section=general')}><ArrowLeft size={16} />Settings</button> : <button className="onboarding-button onboarding-button-secondary" disabled={busy || !progress} onClick={() => void run(() => advance(undefined, true))}>Don’t show again</button>}
      <div>{stepIndex > 0 && <button className="onboarding-button onboarding-button-secondary" disabled={busy || !progress} onClick={() => void run(async () => {
        if (step === 'layout' && layoutIndex > 0) showLayoutPage(layoutPages[layoutIndex - 1]);
        else { if (step === 'default-browser') showLayoutPage(layoutPages[layoutPages.length - 1]); setViewedStep(GETTING_STARTED_STEPS[stepIndex - 1]); }
      })}><ArrowLeft size={16} />Back</button>}
      {!importOnly && <button className="onboarding-button onboarding-button-secondary" disabled={busy || !progress} onClick={() => void run(() => advance(step))}>Skip</button>}
      <button className="onboarding-button onboarding-button-primary" disabled={busy || !progress || (step === 'import' && (detecting || (!canImport && !importCompleted)))} onClick={() => step === 'import' && canImport ? void importData() : void run(() => advance(step))}>{busy ? 'Please wait…' : step === 'import' && (canImport || importOnly) ? `Import${selection.length > 1 ? ` ${selection.length} profiles` : ''}` : step === 'default-browser' ? 'Finish' : 'Continue'}<ArrowRight size={16} /></button></div>
    </footer>
  </div>;
}
