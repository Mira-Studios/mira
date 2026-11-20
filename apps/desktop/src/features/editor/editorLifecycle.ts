import { electron } from '../../electronBridge';
export { isEditorUrl } from '../../../electron/editorPolicy';
const definitionPositions = new Map<string, { lineNumber: number; column: number }>();
export function setDefinitionPosition(url: string, position: { lineNumber: number; column: number }) {
  definitionPositions.set(url, position);
}
export function takeDefinitionPosition(url: string) {
  const position = definitionPositions.get(url);
  definitionPositions.delete(url);
  return position;
}
export type EditorFindCommand = { id: string; query: string; requestId: number; options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean } };
export function findInEditor(command: EditorFindCommand) {
  window.dispatchEvent(new CustomEvent('mira:editor-find', { detail: command }));
}
export async function checkEditor(id: string, action: string): Promise<boolean> {
  return await electron?.ipcRenderer.invoke<boolean>('editor-check', id, action).catch(() => false) ?? false;
}
export function saveEditor(id: string) {
  return electron?.ipcRenderer.invoke<boolean>('editor-save', id);
}
