import Settings from './Settings';
import { electron } from '../electronBridge';
export default function WorkspaceSettings() {
  if (electron?.isPrivate) return null;
  if (!electron?.workspaceId)
    return (
      <div className="settings-page settings-redesign">
        <h1 className="settings-title">Workspace settings</h1>
        <p className="theme-text2">Open a workspace to change its settings.</p>
      </div>
    );
  return <Settings workspaceMode />;
}
