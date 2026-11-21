export type TabPromptScope = { tabId: string; webContentsId?: number };
export type TabPromptSource = { tabId?: string; webContentsId?: number; app?: boolean };

/** Window dialogs stay window scoped; site and editor requests belong to one tab. */
export function promptMatchesTab(request: TabPromptSource, scope?: TabPromptScope): boolean {
  if (!scope) return true; // Single-page app and profile-picker windows.
  if (request.tabId) return request.tabId === scope.tabId;
  if (request.app) return true;
  return request.webContentsId !== undefined && request.webContentsId === scope.webContentsId;
}
