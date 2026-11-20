import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { electron } from '../../electronBridge';
import { alertDialog } from '../../components/appDialogs';
import { useTabs } from '../tabs/TabsProvider';
import { isEditorUrl } from '../editor/editorLifecycle';
import {
  getGitHubRepository,
  type GitRepository,
  type GitEditorRepository,
  type GitRepositoryLink,
} from '../../../electron/githubRepository';

type GitContextValue = {
  repository: GitRepository | null;
  target: string;
  isLocal: boolean;
  link: GitRepositoryLink | null;
  loading: boolean;
  busy: boolean;
  sidebarOpen: boolean;
  toggle: () => void;
  close: () => void;
  pickFolder: () => Promise<void>;
  unlink: () => Promise<void>;
};
const GitContext = createContext<GitContextValue>(null!);
export const useGitRepository = () => useContext(GitContext);

export default function GitProvider({ children }: { children: ReactNode }) {
  const { tabs, activeId } = useTabs();
  const activeUrl = tabs.find((tab) => tab.id === activeId)?.url ?? '';
  const githubRepository = getGitHubRepository(activeUrl);
  const fileEditor = isEditorUrl(activeUrl);
  const [editor, setEditor] = useState<{ url: string; value: GitEditorRepository | null } | null>(
    null,
  );
  const local = fileEditor && editor?.url === activeUrl ? editor.value : null;
  const repository = githubRepository ?? local?.repository ?? null;
  const key = repository?.key ?? '';
  const url = githubRepository ? `https://github.com/${githubRepository.key}` : '';
  const target = local?.target ?? url;
  const isLocal = !!local;
  const [links, setLinks] = useState<Record<string, GitRepositoryLink | null>>({});
  const [busy, setBusy] = useState(false);
  const [views, setViews] = useState<Record<string, string>>({});
  const link = local?.link ?? links[key] ?? null;
  const loading = fileEditor ? editor?.url !== activeUrl : !!key && !Object.hasOwn(links, key);
  const sidebarOpen = !!key && !!link && views[activeId] === key;

  useEffect(() => {
    if (!url || !electron) return;
    const ipc = electron.ipcRenderer;
    let alive = true;
    let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      void ipc
        .invoke<GitRepositoryLink | null>('git-repository-link-get', url)
        .then((value) => {
          if (alive && request === sequence) setLinks((current) => ({ ...current, [key]: value }));
        })
        .catch(() => {
          if (alive && request === sequence) setLinks((current) => ({ ...current, [key]: null }));
        });
    };
    refresh();
    ipc.on('git-links-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      ipc.off('git-links-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [key, url]);

  useEffect(() => {
    if (!fileEditor || !electron) return;
    const ipc = electron.ipcRenderer;
    let alive = true;
    let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      void ipc
        .invoke<GitEditorRepository | null>('git-repository-editor-get', activeUrl)
        .then((value) => {
          if (alive && request === sequence) setEditor({ url: activeUrl, value });
        })
        .catch(() => {
          if (alive && request === sequence) setEditor({ url: activeUrl, value: null });
        });
    };
    refresh();
    ipc.on('git-links-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      ipc.off('git-links-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [fileEditor, activeUrl]);

  useEffect(() => {
    const ids = new Set(tabs.map((tab) => tab.id));
    setViews((current) =>
      Object.keys(current).some((id) => !ids.has(id))
        ? Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)))
        : current,
    );
  }, [tabs]);

  const close = () => setViews((current) => ({ ...current, [activeId]: '' }));
  const pickFolder = async () => {
    if (!key || busy || !electron || isLocal) return;
    setBusy(true);
    try {
      const value = await electron.ipcRenderer.invoke<GitRepositoryLink | null>(
        'git-repository-link-pick',
        url,
      );
      if (value) {
        setLinks((current) => ({ ...current, [key]: value }));
        setViews((current) => ({ ...current, [activeId]: key }));
      }
    } catch (error) {
      await alertDialog({ title: 'Could not link repository', message: String(error) });
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    if (!key || busy || !electron || isLocal) return;
    setBusy(true);
    try {
      await electron.ipcRenderer.invoke('git-repository-unlink', url);
      setLinks((current) => ({ ...current, [key]: null }));
      setViews((current) =>
        Object.fromEntries(Object.entries(current).filter(([, value]) => value !== key)),
      );
    } catch (error) {
      await alertDialog({ title: 'Could not unlink repository', message: String(error) });
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => {
    if (busy || loading) return;
    if (!link) {
      void pickFolder();
      return;
    }
    setViews((current) => ({ ...current, [activeId]: current[activeId] === key ? '' : key }));
  };
  return (
    <GitContext.Provider
      value={{
        repository,
        target,
        isLocal,
        link,
        loading,
        busy,
        sidebarOpen,
        toggle,
        close,
        pickFolder,
        unlink,
      }}
    >
      {children}
    </GitContext.Provider>
  );
}
