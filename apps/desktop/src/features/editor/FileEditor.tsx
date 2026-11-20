import { useEffect, useRef, useState } from 'react';
import { electron } from '../../electronBridge';
import { useTabs } from '../tabs/TabsProvider';
import { addHistoryEntry } from '../history/clientHistory';
import { saveEditor, setDefinitionPosition, takeDefinitionPosition } from './editorLifecycle';
import type { Tab } from '../tabs/types';
import { getBrowserSettings, BROWSER_SETTINGS_CHANGED_EVENT } from '../settings/browserSettings';
import { getThemeById } from '../themes/themeLoader';
import type { EditorFindCommand } from './editorLifecycle';

/** The frame owns Monaco's modules and workers, so removing it releases the entire editor. */
export default function FileEditor({ tab, active }: { tab: Tab; active: boolean }) {
  const [activated, setActivated] = useState(active);
  if (active && !activated) setActivated(true);
  const [dark, setDark] = useState(() => getThemeById(getBrowserSettings().themeId)?.mode !== 'light');
  const frame = useRef<HTMLIFrameElement>(null);
  const [document, setDocument] = useState<{ text: string }>();
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const pendingFind = useRef<EditorFindCommand | null>(null);
  const [definitionPosition] = useState(() => takeDefinitionPosition(tab.url));
  const { updateTabMetadata, reloadTab, closeTab, openFile, newTab, updateFindInPageMatches, findInPageNext } = useTabs();
  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    void electron?.ipcRenderer.invoke<{ text: string }>('editor-open', tab.id, tab.url).then(result => {
      if (cancelled) return;
      setDocument(result);
      const name = decodeURIComponent(new URL(tab.url).pathname.split('/').pop() || tab.url);
      updateTabMetadata(tab.id, { title: name, favicon: null });
      void addHistoryEntry(tab.url, name);
    }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; void electron?.ipcRenderer.invoke('editor-release', tab.id); };
  }, [activated, tab.id, tab.url, updateTabMetadata]);
  useEffect(() => {
    const update = () => setDark(getThemeById(getBrowserSettings().themeId)?.mode !== 'light');
    window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, update);
    return () => window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, update);
  }, []);
  useEffect(() => {
    if (ready && document) {
      frame.current?.contentWindow?.postMessage({ miraEditor: true, type: 'init', text: document.text, url: tab.url, dark, position: definitionPosition }, '*');
      if (pendingFind.current) frame.current?.contentWindow?.postMessage({ miraEditor: true, type: 'find', ...pendingFind.current }, '*');
    }
  }, [ready, document, tab.url, dark, definitionPosition]);
  useEffect(() => {
    if (!ready || !document || !active) return;
    let cancelled = false;
    void electron?.ipcRenderer.invoke('editor-imports', tab.id).then(files => {
      if (!cancelled) frame.current?.contentWindow?.postMessage({ miraEditor: true, type: 'imports', files }, '*');
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [ready, document, active, tab.id]);
  useEffect(() => {
    let importTimer: ReturnType<typeof setTimeout> | undefined;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.miraEditor) return;
      const data = event.data;
      if (data.type === 'ready') setReady(true);
      if (data.type === 'change') {
        electron?.ipcRenderer.send('editor-change', tab.id, data.text);
        clearTimeout(importTimer);
        importTimer = setTimeout(() => {
          void electron?.ipcRenderer.invoke('editor-imports', tab.id).then(files => {
            frame.current?.contentWindow?.postMessage({ miraEditor: true, type: 'imports', files }, '*');
          }).catch(() => undefined);
        }, 500);
      }
      if (data.type === 'save') void saveEditor(tab.id);
      if (data.type === 'reload') reloadTab(tab.id);
      if (data.type === 'close') closeTab(tab.id);
      if (data.type === 'open') openFile();
      if (data.type === 'definition' && typeof data.url === 'string' && data.url.startsWith('file:')) {
        if (data.position) setDefinitionPosition(data.url, data.position);
        newTab(data.url);
      }
      if (data.type === 'find-result') updateFindInPageMatches(tab.id, data.requestId, data.active, data.matches);
      if (data.type === 'find-next') findInPageNext(data.forward);
      if (data.type === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    };
    const discard = (_: unknown, data: { id: string; text: string }) => {
      if (data.id === tab.id) frame.current?.contentWindow?.postMessage({ miraEditor: true, type: 'reset', text: data.text }, '*');
    };
    window.addEventListener('message', receive);
    const find = (event: Event) => {
      const command = (event as CustomEvent<EditorFindCommand>).detail;
      if (command.id === tab.id) {
        pendingFind.current = command;
        frame.current?.contentWindow?.postMessage({ miraEditor: true, type: 'find', ...command }, '*');
      }
    };
    window.addEventListener('mira:editor-find', find);
    electron?.ipcRenderer.on('editor-discard', discard);
    return () => { clearTimeout(importTimer); window.removeEventListener('message', receive); window.removeEventListener('mira:editor-find', find); electron?.ipcRenderer.off('editor-discard', discard); };
  }, [tab.id, reloadTab, closeTab, openFile, newTab, updateFindInPageMatches, findInPageNext]);
  if (!activated) return null;
  return <div data-mira-prevent-suspension={tab.editorDirty ? 'true' : undefined} style={{ display: 'flex', flexDirection: 'column', position: 'relative', flex: 1, minHeight: 0, background: 'var(--bg)', color: 'var(--text1)' }}>
    {error ? <div role="alert" style={{ padding: 20 }}>{error}</div> : !document ? <div style={{ padding: 20 }}>Opening file…</div> : <iframe ref={frame} title={`Edit ${tab.title}`} src="./editor.html" style={{ border: 0, flex: 1, width: '100%' }} />}
  </div>;
}
