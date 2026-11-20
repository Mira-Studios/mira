import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = { getWorker(_, label) {
  if (label === 'json') return new JsonWorker();
  if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
  if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
  if (['typescript', 'javascript'].includes(label)) return new TsWorker();
  return new EditorWorker();
} };
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let model: monaco.editor.ITextModel | undefined;
let baseline = '';
let suppress = false;
const importedModels = new Map<string, monaco.editor.ITextModel>();
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setCompilerOptions({ allowJs: true, checkJs: true, target: monaco.typescript.ScriptTarget.ESNext, module: monaco.typescript.ModuleKind.ESNext, moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs, jsx: monaco.typescript.JsxEmit.ReactJSX, esModuleInterop: true, resolveJsonModule: true, allowNonTsExtensions: true, noEmit: true });
  defaults.setEagerModelSync(true);
}
const send = (data: object) => parent.postMessage({ miraEditor: true, ...data }, '*');
let findQuery = '';
let findCase = false;
let findIndex = 0;
let findRequestId = 0;
let highlights: monaco.editor.IEditorDecorationsCollection | undefined;
function find(query: string, requestId: number, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) {
  if (!model || !editor) return;
  if (query !== findQuery || (options?.matchCase !== undefined && options.matchCase !== findCase)) findIndex = 0;
  findQuery = query; findRequestId = requestId; findCase = options?.matchCase ?? findCase;
  const matches = query ? model.findMatches(query, false, false, findCase, null, false) : [];
  if (options?.findNext && matches.length) findIndex = (findIndex + (options.forward === false ? -1 : 1) + matches.length) % matches.length;
  findIndex = Math.min(findIndex, Math.max(0, matches.length - 1));
  highlights ??= editor.createDecorationsCollection();
  highlights.set(matches.map((match, index) => ({ range: match.range, options: { inlineClassName: index === findIndex ? 'mira-find-active' : 'mira-find-match' } })));
  if (matches[findIndex]) { editor.setSelection(matches[findIndex].range); editor.revealRangeInCenterIfOutsideViewport(matches[findIndex].range); }
  else if (!query) { const position = editor.getPosition(); if (position) editor.setPosition(position); }
  send({ type: 'find-result', requestId, matches: matches.length, active: matches.length ? findIndex + 1 : 0 });
}
const opener = monaco.editor.registerEditorOpener({ openCodeEditor(_source, resource, selection) {
  if (resource.scheme !== 'file' || resource.toString() === model?.uri.toString()) return false;
  const position = selection ? 'startLineNumber' in selection ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : selection : undefined;
  send({ type: 'definition', url: resource.toString(), position });
  return true;
} });
window.addEventListener('message', event => {
  if (event.source !== parent || !event.data?.miraEditor) return;
  const data = event.data;
  if (data.type === 'init') monaco.editor.setTheme(data.dark ? 'vs-dark' : 'vs');
  if (data.type === 'init' && !editor) {
    baseline = data.text;
    model = monaco.editor.createModel(data.text, undefined, monaco.Uri.parse(data.url));
    editor = monaco.editor.create(document.getElementById('editor')!, { model, automaticLayout: true, theme: data.dark ? 'vs-dark' : 'vs', minimap: { enabled: true }, fontSize: 14, scrollBeyondLastLine: false });
    editor.onDidChangeModelContent(() => {
      if (!suppress) send({ type: 'change', text: model!.getValue(monaco.editor.EndOfLinePreference.TextDefined, true), dirty: model!.getValue() !== baseline });
      if (findQuery) find(findQuery, findRequestId);
    });
    editor.focus();
    if (data.position) { editor.setPosition(data.position); editor.revealPositionInCenter(data.position); }
  }
  if (data.type === 'find') find(data.query, data.requestId, data.options);
  if (data.type === 'reset' && model) {
    suppress = true; baseline = data.text; model.setValue(data.text); suppress = false;
  }
  if (data.type === 'imports' && Array.isArray(data.files)) {
    const current = new Set<string>();
    for (const file of data.files as { url: string; text: string }[]) {
      const uri = monaco.Uri.parse(file.url);
      if (uri.toString() === model?.uri.toString()) continue;
      current.add(file.url);
      const existing = importedModels.get(file.url);
      if (existing) { if (existing.getValue() !== file.text) existing.setValue(file.text); }
      else importedModels.set(file.url, monaco.editor.createModel(file.text, undefined, uri));
    }
    for (const [url, imported] of importedModels) if (!current.has(url)) { imported.dispose(); importedModels.delete(url); }
  }
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') send({ type: 'escape' });
  if (event.key === 'F3' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g')) {
    event.preventDefault(); event.stopPropagation(); send({ type: 'find-next', forward: !event.shiftKey }); return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  const action = ({ s: 'save', r: 'reload', w: 'close', o: 'open' } as Record<string, string>)[event.key.toLowerCase()];
  if (action) { event.preventDefault(); event.stopPropagation(); send({ type: action }); }
}, true);
window.addEventListener('unload', () => { opener.dispose(); editor?.dispose(); model?.dispose(); for (const imported of importedModels.values()) imported.dispose(); });
send({ type: 'ready' });
