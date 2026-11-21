/** Profile storage is isolated by Electron. Workspaces start with empty collections. */
export function collectionKey(base: string, workspaceId?: string): string {
  return workspaceId ? `${base}.workspace.${workspaceId}` : base;
}
