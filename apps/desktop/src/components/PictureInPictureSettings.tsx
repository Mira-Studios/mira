import { saveBrowserSettings } from '../features/settings/browserSettings';
import { useSidebarSettings } from '../features/sidebar/useSidebarSettings';
export default function PictureInPictureSettings() {
  const settings = useSidebarSettings();
  return (
    <section className="settings-group">
      <div className="settings-card-header">
        <h3 className="settings-card-title">Picture in picture</h3>
      </div>
      <div className="settings-card">
        <label className="settings-setting-row">
          <span className="settings-setting-label">When switching tabs</span>
          <input
            id="pip-on-tab-switch"
            type="checkbox"
            className="settings-toggle settings-setting-control"
            checked={settings.pipOnTabSwitch}
            onChange={(event) => saveBrowserSettings({ pipOnTabSwitch: event.target.checked })}
          />
        </label>
        <label className="settings-setting-row">
          <span className="settings-setting-label">When the window is hidden</span>
          <input
            id="pip-on-window-hidden"
            type="checkbox"
            className="settings-toggle settings-setting-control"
            checked={settings.pipOnWindowHidden}
            onChange={(event) => saveBrowserSettings({ pipOnWindowHidden: event.target.checked })}
          />
        </label>
      </div>
    </section>
  );
}
