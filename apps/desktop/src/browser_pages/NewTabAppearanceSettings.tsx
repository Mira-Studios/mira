import { useState } from 'react';
import { electron } from '../electronBridge';
import { saveBrowserSettings, type BrowserSettings } from '../features/settings/browserSettings';
import {
  getBackgroundStyle,
  getNewTabBackgroundSource,
  useBackgroundImage,
  useNewTabAppearance,
  prepareBackgroundImage,
} from '../features/themes/useNewTabAppearance';
import { getBackgroundImageError, normalizeBackgroundImageUrl } from '../themes/backgroundImage';

export default function NewTabAppearanceSettings() {
  const settings = useNewTabAppearance();
  const source = getNewTabBackgroundSource(settings);
  const { image, error, loading, retry } = useBackgroundImage(source);
  const [url, setUrl] = useState(() => normalizeBackgroundImageUrl(settings.backgroundImage));
  const [busy, setBusy] = useState<'download' | 'choose' | null>(null);
  const [actionError, setActionError] = useState('');
  const update = (change: Partial<BrowserSettings>) => saveBrowserSettings(change);
  const chooseImage = async (fromUrl: boolean) => {
    setBusy(fromUrl ? 'download' : 'choose');
    setActionError('');
    try {
      if (!electron) throw new Error('Open the desktop app to choose a background image.');
      let nextSource: string | null;
      if (fromUrl) {
        nextSource = normalizeBackgroundImageUrl(url);
        if (!nextSource) throw new Error('Enter an image URL starting with http:// or https://.');
        await prepareBackgroundImage(nextSource);
      } else {
        nextSource = await electron.ipcRenderer.invoke<string | null>('background-image-choose');
        if (nextSource) await prepareBackgroundImage(nextSource);
      }
      if (nextSource) {
        update({ backgroundImage: nextSource, useThemeBackgroundImage: false });
        setUrl(normalizeBackgroundImageUrl(nextSource));
      }
    } catch (error) {
      setActionError(getBackgroundImageError(error));
    } finally {
      setBusy(null);
    }
  };
  const failure = actionError || error;
  return (
    <>
      <label className="settings-setting-row">
        <span className="settings-setting-label">Show center search bar</span>
        <input
          type="checkbox"
          className="settings-toggle settings-setting-control"
          checked={settings.showNewTabSearch}
          onChange={(event) => update({ showNewTabSearch: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-setting-row">
        <span className="settings-setting-label">Use theme background image</span>
        <input
          type="checkbox"
          className="settings-toggle settings-setting-control"
          checked={settings.useThemeBackgroundImage}
          disabled={!!busy}
          onChange={(event) => {
            update({ useThemeBackgroundImage: event.currentTarget.checked });
            setActionError('');
          }}
        />
      </label>
      <div className="newtab-background-controls">
        {image && (
          <div
            className="newtab-background-preview"
            role="img"
            aria-label="New Tab background preview"
            style={getBackgroundStyle(settings, image)}
          />
        )}
        <div className="newtab-background-actions">
          <button
            type="button"
            className="theme-btn theme-btn-nav settings-btn-pad"
            disabled={!!busy}
            onClick={() => {
              void chooseImage(false);
            }}
          >
            {busy === 'choose' ? 'Choosing...' : 'Choose image'}
          </button>
          <span className="settings-setting-description">Up to 50 MB</span>
          {!!source && (
            <button
              type="button"
              className="theme-btn theme-btn-nav settings-btn-pad newtab-background-remove"
              disabled={!!busy}
              onClick={() => {
                update({ backgroundImage: '', useThemeBackgroundImage: false });
                setUrl('');
                setActionError('');
              }}
            >
              Remove
            </button>
          )}
        </div>
        <form
          className="newtab-background-url"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void chooseImage(true);
          }}
        >
          <label htmlFor="newtab-background-url" className="settings-setting-label">
            Image URL
          </label>
          <div className="newtab-background-url-input">
            <input
              id="newtab-background-url"
              type="text"
              inputMode="url"
              className="theme-input settings-text-input"
              placeholder="https://example.com/image.jpg"
              value={url}
              disabled={!!busy}
              aria-invalid={!!actionError}
              aria-describedby={failure ? 'newtab-background-error' : undefined}
              onChange={(event) => {
                setUrl(event.currentTarget.value);
                setActionError('');
              }}
            />
            <button
              type="submit"
              className="theme-btn theme-btn-nav settings-btn-pad"
              disabled={!!busy || !url.trim()}
            >
              {busy === 'download' ? 'Downloading...' : 'Use URL'}
            </button>
          </div>
        </form>
        {failure && (
          <div id="newtab-background-error" className="newtab-background-error" role="alert">
            <span>{failure}</span>
            {!actionError && (
              <button
                type="button"
                className="theme-btn theme-btn-nav settings-btn-pad"
                disabled={!!busy}
                onClick={retry}
              >
                Retry
              </button>
            )}
          </div>
        )}
        {loading && !busy && (
          <div className="settings-setting-description" role="status">
            Loading image...
          </div>
        )}
      </div>
      {!!source && (
        <>
          <label className="settings-setting-row">
            <span className="settings-setting-label">Sizing</span>
            <select
              className="theme-input settings-select-input settings-setting-control"
              value={settings.backgroundImageFit}
              onChange={(event) =>
                update({
                  backgroundImageFit: event.currentTarget
                    .value as BrowserSettings['backgroundImageFit'],
                })
              }
            >
              <option value="cover">Fill</option>
              <option value="contain">Fit</option>
              <option value="stretch">Stretch</option>
              <option value="original">Original size</option>
              <option value="tile">Tile</option>
            </select>
          </label>
          <div className="settings-setting-row newtab-background-position">
            <span className="settings-setting-label">Position</span>
            <div className="newtab-background-sliders">
              <label>
                <span>
                  Horizontal <output>{settings.backgroundImagePositionX}%</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={settings.backgroundImagePositionX}
                  onChange={(event) =>
                    update({ backgroundImagePositionX: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                <span>
                  Vertical <output>{settings.backgroundImagePositionY}%</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={settings.backgroundImagePositionY}
                  onChange={(event) =>
                    update({ backgroundImagePositionY: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <button
                type="button"
                className="theme-btn theme-btn-nav settings-btn-pad"
                onClick={() =>
                  update({ backgroundImagePositionX: 50, backgroundImagePositionY: 50 })
                }
              >
                Center
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
