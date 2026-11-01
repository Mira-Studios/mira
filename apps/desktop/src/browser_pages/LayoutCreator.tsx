import { useEffect, useMemo, useState } from 'react';
import { applyLayout } from '../features/layouts/applyLayout';
import {
  getAllLayouts,
  getLayoutById,
  importLayoutFromJson,
  type LayoutEntry,
} from '../features/layouts/layoutLoader';
import { getBrowserSettings, saveBrowserSettings } from '../features/settings/browserSettings';
import type { Layout } from '../layouts/types';
import {
  getDefaultLayoutValues,
  getLayoutValueDisplayName,
  LAYOUT_VALUE_DEFINITIONS,
} from '../layouts/layoutValueDefinitions';

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function createEditableValues(baseLayout: Layout): Record<string, string> {
  return {
    ...getDefaultLayoutValues(),
    ...baseLayout.values,
  };
}

export default function LayoutCreator() {
  const [layouts, setLayouts] = useState<LayoutEntry[]>(() => getAllLayouts());
  const settingsLayoutId = getBrowserSettings().layoutId;
  const initialLayoutEntry =
    layouts.find((entry) => entry.id === settingsLayoutId) ?? layouts[0] ?? null;

  const [baseLayoutId, setBaseLayoutId] = useState<string>(initialLayoutEntry?.id ?? '');
  const [layoutName, setLayoutName] = useState('My Layout');
  const [layoutAuthor, setLayoutAuthor] = useState('Me');
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialLayoutEntry ? createEditableValues(initialLayoutEntry.layout) : getDefaultLayoutValues(),
  );
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(true);
  const [exportMessage, setExportMessage] = useState('');

  const selectedLayoutEntry: LayoutEntry | null =
    layouts.find((entry) => entry.id === baseLayoutId) ?? initialLayoutEntry;

  useEffect(() => {
    if (!selectedLayoutEntry) return;
    setValues(createEditableValues(selectedLayoutEntry.layout));
  }, [baseLayoutId, selectedLayoutEntry]);

  const editableKeys = useMemo(() => LAYOUT_VALUE_DEFINITIONS.map((entry) => entry.key), []);

  useEffect(() => {
    if (!livePreviewEnabled) return;
    applyLayout({
      name: layoutName.trim() || 'My Layout',
      author: layoutAuthor.trim() || 'Me',
      values,
    });
  }, [layoutName, layoutAuthor, values, livePreviewEnabled]);

  useEffect(() => {
    if (livePreviewEnabled) return;
    const settingsLayoutId = getBrowserSettings().layoutId;
    applyLayout(getLayoutById(settingsLayoutId));
  }, [livePreviewEnabled]);

  const handleExport = () => {
    const trimmedName = layoutName.trim() || 'My Layout';
    const trimmedAuthor = layoutAuthor.trim() || 'Me';
    const payload: Layout = {
      name: trimmedName,
      author: trimmedAuthor,
      values,
    };
    const filename = `${trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'layout'}.json`;
    downloadTextFile(filename, JSON.stringify(payload, null, 2));
    setExportMessage(`Exported ${filename}`);
  };

  const handleExportLoadAndSelect = () => {
    try {
      const trimmedName = layoutName.trim() || 'My Layout';
      const trimmedAuthor = layoutAuthor.trim() || 'Me';
      const payload: Layout = {
        name: trimmedName,
        author: trimmedAuthor,
        values,
      };
      const json = JSON.stringify(payload, null, 2);
      const imported = importLayoutFromJson(json);
      saveBrowserSettings({ layoutId: imported.id });
      applyLayout(imported.layout);
      setLayouts(getAllLayouts());
      setBaseLayoutId(imported.id);
      setExportMessage(`Loaded and selected: ${imported.layout.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load and select layout.';
      setExportMessage(message);
    }
  };

  if (!layouts.length) {
    return (
      <div className="settings-page creator-page">No layouts are available to use as a base.</div>
    );
  }

  return (
    <div className="settings-page creator-page" data-mira-prevent-suspension="true">
      <header className="settings-header">
        <div>
          <h1 className="settings-title">Layout Creator</h1>
        </div>
      </header>

      <section className="theme-panel settings-card">
        <div className="settings-card-header">
          <h2 className="settings-card-title">Actions</h2>
        </div>
        <div className="settings-actions-row">
          <button
            type="button"
            onClick={handleExport}
            className="theme-btn theme-btn-go settings-btn-pad"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={handleExportLoadAndSelect}
            className="theme-btn theme-btn-nav settings-btn-pad"
          >
            Export, Load, and Select
          </button>
          <label className="creator-live-preview">
            <input
              type="checkbox"
              checked={livePreviewEnabled}
              onChange={(e) => setLivePreviewEnabled(e.currentTarget.checked)}
              className="settings-toggle"
            />
            <span className="theme-text2">Live Preview</span>
          </label>
        </div>
        {!!exportMessage && (
          <div className="theme-text2 settings-inline-message">{exportMessage}</div>
        )}
      </section>

      <section className="theme-panel settings-card">
        <div className="settings-card-header">
          <h2 className="settings-card-title">Layout Details</h2>
        </div>
        <div className="creator-meta-grid">
          <label className="creator-meta-field">
            <span className="settings-setting-label">Base Layout</span>
            <select
              value={baseLayoutId}
              onChange={(e) => {
                setBaseLayoutId(e.currentTarget.value);
                setExportMessage('');
              }}
              className="theme-input settings-select-input"
            >
              {layouts.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.layout.name} - {entry.layout.author}
                </option>
              ))}
            </select>
          </label>

          <label className="creator-meta-field">
            <span className="settings-setting-label">Name</span>
            <input
              value={layoutName}
              onChange={(e) => {
                setLayoutName(e.currentTarget.value);
                setExportMessage('');
              }}
              className="theme-input settings-text-input"
            />
          </label>

          <label className="creator-meta-field">
            <span className="settings-setting-label">Author</span>
            <input
              value={layoutAuthor}
              onChange={(e) => {
                setLayoutAuthor(e.currentTarget.value);
                setExportMessage('');
              }}
              className="theme-input settings-text-input"
            />
          </label>
        </div>
      </section>

      <section className="theme-panel settings-card">
        <div className="settings-card-header">
          <h2 className="settings-card-title">Layout Values</h2>
        </div>
        <div className="creator-values-list">
          {editableKeys.map((key) => {
            const definition = LAYOUT_VALUE_DEFINITIONS.find((entry) => entry.key === key);
            const isChoice = definition?.kind === 'choice';
            const options = definition?.options ?? [];

            return (
              <div key={key} className="settings-setting-row creator-value-row">
                <div className="settings-setting-meta">
                  <span className="settings-setting-label">{getLayoutValueDisplayName(key)}</span>
                  <span className="settings-setting-description creator-code-text">{key}</span>
                </div>

                {isChoice ? (
                  <select
                    value={values[key] ?? ''}
                    onChange={(e) => {
                      setValues((prev) => ({ ...prev, [key]: e.currentTarget.value }));
                      setExportMessage('');
                    }}
                    className="theme-input settings-select-input settings-setting-control creator-value-input"
                  >
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={values[key] ?? ''}
                    onChange={(e) => {
                      setValues((prev) => ({ ...prev, [key]: e.currentTarget.value }));
                      setExportMessage('');
                    }}
                    className="theme-input settings-text-input settings-setting-control creator-value-input creator-code-input"
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
